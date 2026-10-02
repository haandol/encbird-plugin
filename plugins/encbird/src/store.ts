import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import lockfile from 'proper-lockfile';
import { SafeError, Secrets } from './errors.js';
import { validateOAuth, type OAuthConfig } from './config.js';

export interface Grant {
  oauth: OAuthConfig;
  accessToken?: string; refreshToken?: string; expiresAt: number; subject?: string;
  connectionId?: string; cleanup?: { backend: boolean; provider: boolean };
  refreshInvalid?: boolean;
}
export interface Recovery {
  grant: Grant; idToken?: string; nonce: string; tokenType?: string;
  verified: boolean; discard: boolean;
}
export interface Credentials extends Grant {
  version: 1; status: 'active' | 'pending' | 'disabled';
  recovery?: Recovery;
  pendingGrants?: Grant[];
}
export interface Transaction { load(): Promise<Credentials | undefined>; save(value?: Credentials): Promise<void> }
export class CredentialStore {
  readonly directory: string;
  readonly path: string;
  constructor(readonly base: string, clientName: string, readonly secrets: Secrets, directory?: string) {
    this.directory = resolve(directory ?? process.env.ENCBIRD_CREDENTIALS_DIR ?? join(homedir(), '.encbird-plugin'));
    const scope = createHash('sha256').update(JSON.stringify([base, hostname(), process.env.ENCBIRD_AUTH_SCOPE ?? clientName])).digest('hex');
    this.path = join(this.directory, `${scope}.json`);
  }
  private async check(path: string, directory = false) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
        (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || (!directory && stat.nlink !== 1)) {
      throw new SafeError('UNSAFE_CREDENTIALS', 'Credential storage must be private, owned by this user, and free of symbolic links.');
    }
  }
  async withLock<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    if (process.platform === 'win32') throw new SafeError('UNSUPPORTED_PLATFORM', 'Private credential storage currently supports macOS and Linux.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.check(this.directory, true);
    if (await realpath(this.directory) !== this.directory) throw new SafeError('UNSAFE_CREDENTIALS', 'Use a canonical credential directory without symbolic links.');
    let compromised = false;
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.path, {
        realpath: false, stale: 30_000, update: 5_000,
        retries: { retries: 8, minTimeout: 25, maxTimeout: 250 },
        onCompromised: () => { compromised = true; },
      });
    } catch { throw new SafeError('AUTH_BUSY', 'Another EncBird process is updating this connection. Retry shortly.'); }
    const assertLock = () => { if (compromised) throw new SafeError('AUTH_LOCK_LOST', 'Credential lock was lost. Reconnect before continuing.'); };
    const transaction: Transaction = {
      load: async () => {
        assertLock();
        try { await this.check(this.path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
        const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (stat.size > 1_048_576) throw new Error();
          const value = JSON.parse(await file.readFile('utf8')) as Credentials;
          if (value.version !== 1 || !['active', 'pending', 'disabled'].includes(value.status) ||
              !Number.isFinite(value.expiresAt) ||
              [value.accessToken, value.refreshToken, value.subject, value.connectionId].some(v => v !== undefined && typeof v !== 'string') ||
              (value.status === 'active' && (!value.accessToken || !value.refreshToken || !value.connectionId)) ||
              (value.status !== 'active' && (!value.cleanup || typeof value.cleanup.backend !== 'boolean' || typeof value.cleanup.provider !== 'boolean'))) throw new Error();
          const validateGrant = (grant: Grant) => {
            if (!grant || !Number.isFinite(grant.expiresAt) ||
                [grant.accessToken, grant.refreshToken, grant.subject, grant.connectionId].some(v => v !== undefined && typeof v !== 'string') ||
                (grant.refreshInvalid !== undefined && typeof grant.refreshInvalid !== 'boolean') ||
                (grant.cleanup && (typeof grant.cleanup.backend !== 'boolean' || typeof grant.cleanup.provider !== 'boolean'))) throw new Error();
            grant.oauth = validateOAuth(grant.oauth, this.base);
            this.secrets.add(grant.accessToken, grant.refreshToken);
          };
          validateGrant(value);
          if (value.pendingGrants !== undefined) {
            if (!Array.isArray(value.pendingGrants)) throw new Error();
            for (const grant of value.pendingGrants) { validateGrant(grant); if (!grant.cleanup) throw new Error(); }
          }
          if (value.recovery) {
            const r = value.recovery;
            if (typeof r.nonce !== 'string' || !r.nonce || typeof r.verified !== 'boolean' || typeof r.discard !== 'boolean' ||
                [r.idToken, r.tokenType].some(v => v !== undefined && typeof v !== 'string')) throw new Error();
            validateGrant(r.grant);
            if (!r.grant.cleanup || (r.verified && !r.grant.subject)) throw new Error();
            this.secrets.add(r.idToken, r.nonce);
          }
          if (value.status === 'active' && (value.recovery || value.pendingGrants?.length)) throw new Error();
          return value;
        } catch { throw new SafeError('INVALID_CREDENTIALS', 'Credential storage is invalid. Restore or remove it locally before reconnecting.'); }
        finally { await file.close(); }
      },
      save: async value => {
        assertLock();
        if (!value) { await unlink(this.path).catch(error => { if (error.code !== 'ENOENT') throw error; }); return; }
        this.secrets.add(value.accessToken, value.refreshToken);
        for (const grant of value.pendingGrants ?? []) this.secrets.add(grant.accessToken, grant.refreshToken);
        if (value.recovery) this.secrets.add(value.recovery.grant.accessToken, value.recovery.grant.refreshToken, value.recovery.idToken, value.recovery.nonce);
        const temp = `${this.path}.${randomUUID()}.tmp`;
        const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
        finally { await file.close(); }
        try { assertLock(); await rename(temp, this.path); }
        finally { await unlink(temp).catch(() => {}); }
        const dir = await open(this.directory, constants.O_RDONLY);
        try { await dir.sync(); } finally { await dir.close(); }
      },
    };
    try { return await fn(transaction); } finally { await release().catch(() => {}); }
  }
}
