import { bootstrap } from './config.js';
import { SafeError, safeError, type Secrets } from './errors.js';
import { apiRequest } from './api.js';
import { object } from './http.js';
import { authorizationUrl, callback, openBrowser, proof, revoke, tokenRequest, verifyIdentity } from './oauth.js';
import { CredentialStore, type Credentials, type Grant, type Transaction } from './store.js';
import { filterExternalInput } from './privacy.js';
import { createHash } from 'node:crypto';
import { decodeJwt } from 'jose';

const pending = () => ({ data: { status: 'authentication_pending', message: 'Finish browser sign-in, then run connect again.' } });
const hasCleanup = (g: Grant) => !!(g.cleanup?.backend || g.cleanup?.provider);
const needsLogin = (g: Grant) => !!g.cleanup?.backend && (!g.accessToken || g.refreshInvalid || (!g.refreshToken && g.expiresAt <= Date.now()));
const incompatible = (a: Grant, b: Grant) => a.oauth.clientId !== b.oauth.clientId || a.oauth.issuer !== b.oauth.issuer || a.oauth.resource !== b.oauth.resource;
const permanent = (error: unknown) => error instanceof SafeError && [
  'INVALID_ID_TOKEN', 'ACCOUNT_MISMATCH', 'AUTH_CANCELLED', 'INVALID_TOKEN_RESPONSE', 'REFRESH_TOKEN_REQUIRED', 'INVALID_CONNECTION',
].includes(error.code);

export class Auth {
  private task?: Promise<void>;
  private abort?: AbortController;
  private failure?: ReturnType<typeof safeError>;
  constructor(readonly base: string, readonly store: CredentialStore, readonly secrets: Secrets,
    private browser = openBrowser, private callbackTimeoutMs = 180_000) {}

  async connect(): Promise<Record<string, unknown>> {
    if (this.task) return pending();
    if (this.failure) { const failure = this.failure; this.failure = undefined; return failure; }
    let started!: (value: Record<string, unknown>) => void;
    const result = new Promise<Record<string, unknown>>(resolve => { started = resolve; });
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.task = this.store.withLock(async tx => {
      let value = await tx.load();
      if (value?.status === 'active') { started(this.connected(value)); return; }
      if (value?.recovery) {
        if (value.recovery.discard) {
          await this.discardCandidate(tx, value, true);
          if (value.recovery) { started(this.cleanupStatus(value)); return; }
        } else {
          try { started(await this.resumeRecovery(tx, value, signal)); }
          catch (error) {
            const failure = signal.aborted ? new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled.') : error;
            await this.failedCandidate(tx, value, failure); throw failure;
          }
          return;
        }
      }
      if (value && this.grants(value).some(hasCleanup) && !this.grants(value).some(needsLogin)) {
        throw new SafeError('CLEANUP_REQUIRED', 'Run disconnect to finish the previous connection cleanup before signing in.');
      }
      if (value && this.grants(value).some(hasCleanup) && !value.subject) {
        throw new SafeError('OWNER_UNKNOWN', 'The previous connection has no verified owner. Its cleanup records were retained.');
      }
      const oauth = await bootstrap(this.base);
      if (value && incompatible(value, { oauth, expiresAt: 0 })) {
        throw new SafeError('OAUTH_CLIENT_CHANGED', 'The public OAuth client changed. Previous connection cleanup records were retained.');
      }
      value ??= { version: 1, status: 'disabled', oauth, expiresAt: 0, cleanup: { backend: false, provider: false } };
      const values = proof();
      this.secrets.add(values.verifier, values.state, values.nonce);
      const listener = await callback(values.state, signal, this.callbackTimeoutMs);
      try {
        await this.browser(authorizationUrl(oauth, values, !!value.subject));
        started(pending());
        const code = await listener.result;
        this.secrets.add(code);
        value.recovery = { grant: { oauth, expiresAt: 0, cleanup: { backend: false, provider: true } },
          nonce: values.nonce, verified: false, discard: false };
        await tx.save(value);
        const root = value;
        await tokenRequest(oauth, { grant_type: 'authorization_code', code, redirect_uri: oauth.redirectUri, code_verifier: values.verifier }, this.secrets,
          async tokens => {
            Object.assign(root.recovery!.grant, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt });
            root.recovery!.idToken = tokens.idToken; root.recovery!.tokenType = tokens.tokenType;
            await tx.save(root);
          });
        if (signal.aborted) throw new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled.');
        await this.resumeRecovery(tx, value, signal);
      } catch (error) {
        const failure = signal.aborted ? new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled.') : error;
        await this.failedCandidate(tx, value, failure);
        throw failure;
      } finally { listener.cancel(); }
    }).catch(error => { this.failure = safeError(error); started(this.failure); }).finally(() => { this.task = undefined; this.abort = undefined; });
    return result;
  }
  async waitForIdle() { await this.task; }
  async cancel() { this.abort?.abort(); await this.task; }
  private grants(value: Credentials): Grant[] { return [value, ...(value.pendingGrants ?? [])]; }
  private connected(value: Grant) { return { data: { status: 'connected', connectionId: value.connectionId } }; }
  private cleanupStatus(value: Credentials) {
    const grants = [...this.grants(value), ...(value.recovery ? [value.recovery.grant] : [])];
    const reauthenticationRequired = this.grants(value).some(needsLogin);
    return { data: { status: 'cleanup_pending', credentialsDisabled: true,
      backendPending: grants.some(g => g.cleanup?.backend), providerPending: grants.some(g => g.cleanup?.provider), reauthenticationRequired,
      message: reauthenticationRequired ? 'Run connect and sign in to the same account to recover previous connection cleanup.' : 'Run connect to resume recovery, or disconnect to finish cleanup.' } };
  }
  private async refresh(tx: Transaction, root: Credentials, grant: Grant) {
    if (!grant.refreshToken || grant.refreshInvalid) throw new SafeError('OAUTH_INVALID_GRANT', 'Run connect for same-account browser recovery.');
    const previousStatus = root.status;
    const previousCleanup = root.cleanup;
    root.status = 'pending'; root.cleanup ??= { backend: true, provider: true }; await tx.save(root);
    try {
      const tokens = await tokenRequest(grant.oauth, { grant_type: 'refresh_token', refresh_token: grant.refreshToken }, this.secrets,
        async tokens => { if (tokens.refreshToken) grant.refreshToken = tokens.refreshToken; await tx.save(root); });
      if (tokens.idToken && await verifyIdentity(grant.oauth, tokens.idToken) !== grant.subject) {
        throw new SafeError('INVALID_ID_TOKEN', 'The refreshed identity did not match the connection.');
      }
      grant.accessToken = tokens.accessToken; grant.expiresAt = tokens.expiresAt;
      root.status = previousStatus; root.cleanup = previousCleanup; await tx.save(root);
    } catch (error) {
      if (error instanceof SafeError && error.code === 'OAUTH_INVALID_GRANT') grant.refreshInvalid = true;
      root.status = 'disabled'; await tx.save(root); throw error;
    }
  }
  private async ensureAccess(tx: Transaction, root: Credentials, grant: Grant) {
    if (grant.expiresAt <= Date.now() + 30_000) await this.refresh(tx, root, grant);
    if (!grant.accessToken || grant.expiresAt <= Date.now()) throw new SafeError('OAUTH_INVALID_GRANT', 'A fresh same-account sign-in is required.');
  }
  private async verifyCandidate(tx: Transaction, value: Credentials) {
    const candidate = value.recovery!;
    if (candidate.verified) {
      if (!value.subject || candidate.grant.subject !== value.subject) throw new SafeError('ACCOUNT_MISMATCH', 'Recovery must retain the previously verified account.');
      return;
    }
    if (!candidate.grant.refreshToken) throw new SafeError('REFRESH_TOKEN_REQUIRED', 'Sign-in did not provide refresh credentials.');
    if (!candidate.grant.accessToken || candidate.tokenType?.toLowerCase() !== 'bearer' || !candidate.grant.expiresAt) {
      throw new SafeError('INVALID_TOKEN_RESPONSE', 'The provider returned invalid credentials.');
    }
    const subject = await verifyIdentity(candidate.grant.oauth, candidate.idToken, candidate.nonce);
    if (value.subject && subject !== value.subject) throw new SafeError('ACCOUNT_MISMATCH', 'Sign in to the same account as the previous connection. Its cleanup records remain intact.');
    candidate.grant.subject = subject; candidate.verified = true;
    value.subject ??= subject;
    delete candidate.idToken;
    await tx.save(value);
  }
  private confirmRevoked(result: unknown, grant: Grant) {
    const data = object(result);
    if (data.status !== 'revoked' || typeof data.connectionId !== 'string' || !data.connectionId ||
        (grant.connectionId && data.connectionId !== grant.connectionId)) throw new SafeError('INVALID_CONNECTION', 'Backend connection revocation was not confirmed.');
  }
  private async previousConnectionId(tx: Transaction, root: Credentials, grant: Grant) {
    if (grant.connectionId !== undefined) {
      if (!/^[0-9a-fA-F]{64}$/.test(grant.connectionId)) throw new SafeError('INVALID_CONNECTION_ID', 'The stored previous connection ID is invalid. Cleanup records were retained.');
      if (grant.connectionId !== grant.connectionId.toLowerCase()) { grant.connectionId = grant.connectionId.toLowerCase(); await tx.save(root); }
      return grant.connectionId;
    }
    try {
      const family = decodeJwt(grant.accessToken ?? '').origin_jti;
      if (typeof family !== 'string' || !family || family.length > 256 || /[\s#\x00-\x1f\x7f]/.test(family)) throw new Error();
      // Unverified origin_jti selects a resource only; fresh verified identity supplies all authority.
      grant.connectionId = createHash('sha256').update(JSON.stringify([grant.oauth.clientId, family])).digest('hex');
    } catch { throw new SafeError('PREVIOUS_RESOURCE_MISSING', 'The previous connection ID cannot be recovered. Its private cleanup records were retained.'); }
    await tx.save(root);
    return grant.connectionId;
  }
  private async revokeBackend(tx: Transaction, root: Credentials, grant: Grant, fresh?: Grant) {
    const cleanup = grant.cleanup ??= { backend: true, provider: true };
    if (cleanup.backend) {
      if (fresh) {
        if (!fresh.subject || fresh.subject !== root.subject || (grant.subject && grant.subject !== fresh.subject) || incompatible(grant, fresh)) {
          throw new SafeError('ACCOUNT_MISMATCH', 'Previous grant cleanup requires the same verified account and client.');
        }
        await this.ensureAccess(tx, root, fresh);
        const connectionId = await this.previousConnectionId(tx, root, grant);
        this.confirmRevoked(await apiRequest(this.base, fresh.accessToken!, 'POST', '/connection/revoke-previous', { connectionId }), grant);
      } else {
        await this.ensureAccess(tx, root, grant);
        this.confirmRevoked(await apiRequest(this.base, grant.accessToken!, 'DELETE', '/connection'), grant);
      }
      cleanup.backend = false; await tx.save(root);
    }
  }
  private async revokeProvider(tx: Transaction, root: Credentials, grant: Grant) {
    const cleanup = grant.cleanup ??= { backend: true, provider: true };
    if (cleanup.backend) throw new SafeError('CLEANUP_REQUIRED', 'Backend revocation must finish before provider cleanup.');
    delete grant.accessToken; grant.expiresAt = 0; await tx.save(root);
    if (cleanup.provider) {
      if (grant.refreshToken) await revoke(grant.oauth, grant.refreshToken);
      cleanup.provider = false; delete grant.refreshToken; await tx.save(root);
    }
  }
  private async cleanupOlder(tx: Transaction, root: Credentials, fresh?: Grant, signal?: AbortSignal) {
    const checkCancelled = () => { if (signal?.aborted) throw new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled.'); };
    for (const grant of this.grants(root)) {
      checkCancelled();
      if (grant.cleanup?.backend) await this.revokeBackend(tx, root, grant, fresh);
    }
    for (const grant of this.grants(root)) {
      checkCancelled();
      if (hasCleanup(grant)) await this.revokeProvider(tx, root, grant);
    }
  }
  private async resumeRecovery(tx: Transaction, value: Credentials, signal?: AbortSignal) {
    await this.verifyCandidate(tx, value);
    const candidate = value.recovery!;
    if (signal?.aborted) throw new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled.');
    try { await this.ensureAccess(tx, value, candidate.grant); }
    catch (error) {
      if (error instanceof SafeError && error.code === 'OAUTH_INVALID_GRANT') {
        if (candidate.grant.cleanup!.backend) {
          value.pendingGrants ??= []; value.pendingGrants.push(candidate.grant); delete value.recovery; await tx.save(value);
        } else { candidate.discard = true; await tx.save(value); await this.discardCandidate(tx, value); }
      }
      throw error;
    }
    await this.cleanupOlder(tx, value, candidate.grant, signal);
    if (signal?.aborted) throw new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled.');
    candidate.grant.cleanup!.backend = true; await tx.save(value);
    await this.ensureAccess(tx, value, candidate.grant);
    const result = object(await apiRequest(this.base, candidate.grant.accessToken!, 'POST', '/connections', {}));
    if (result.status !== 'active' || typeof result.connectionId !== 'string' || !result.connectionId || result.userId !== value.subject) {
      throw new SafeError('INVALID_CONNECTION', 'EncBird returned a connection for an unexpected identity.');
    }
    if (signal?.aborted) throw new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled.');
    const active: Credentials = { ...candidate.grant, version: 1, status: 'active', connectionId: result.connectionId };
    delete active.cleanup; delete active.refreshInvalid;
    await tx.save(active);
    return this.connected(active);
  }
  private async discardCandidate(tx: Transaction, value: Credentials, finishOlder = false) {
    if (!value.recovery) return;
    const fresh = value.recovery;
    const olderBackendPending = this.grants(value).some(g => g.cleanup?.backend);
    if (fresh.verified && olderBackendPending && !finishOlder && !fresh.grant.refreshInvalid) return;
    try {
      if (fresh.verified && olderBackendPending && !fresh.grant.refreshInvalid) await this.cleanupOlder(tx, value, fresh.grant);
      await this.revokeBackend(tx, value, fresh.grant);
      await this.revokeProvider(tx, value, fresh.grant);
    }
    catch (error) {
      const candidate = value.recovery;
      if (error instanceof SafeError && error.code === 'OAUTH_INVALID_GRANT' && candidate.verified &&
          candidate.grant.subject === value.subject && candidate.grant.cleanup?.backend) {
        value.pendingGrants ??= []; value.pendingGrants.push(candidate.grant); delete value.recovery;
      }
      value.status = 'disabled'; await tx.save(value); return;
    }
    delete value.recovery;
    if (!this.grants(value).some(hasCleanup) && !value.connectionId && !value.pendingGrants?.length) await tx.save(); else await tx.save(value);
  }
  private async failedCandidate(tx: Transaction, value: Credentials, error: unknown) {
    if (!value.recovery) return;
    if (error instanceof SafeError && error.code === 'CONNECTION_INACTIVE' && value.recovery.verified) {
      const grant = value.recovery.grant;
      grant.refreshInvalid = true; grant.cleanup!.backend = false;
      value.pendingGrants ??= []; value.pendingGrants.push(grant);
      delete value.recovery; value.status = 'disabled'; await tx.save(value);
      return;
    }
    if (permanent(error) || !value.recovery.grant.refreshToken) {
      value.recovery.discard = true; value.status = 'disabled'; await tx.save(value);
      await this.discardCandidate(tx, value);
    }
  }
  async request(method: string, path: string, body?: unknown) {
    return this.store.withLock(async tx => {
      const value = await tx.load();
      if (!value || value.status !== 'active') throw new SafeError('AUTH_REQUIRED', 'Connect to EncBird before using learning tools.');
      filterExternalInput('transport', { path, body }, this.secrets);
      if (value.expiresAt <= Date.now() + 60_000) {
        try { await this.refresh(tx, value, value); }
        catch (error) { value.status = 'disabled'; value.cleanup = { backend: true, provider: true }; await tx.save(value); throw error; }
      }
      try { return await apiRequest(this.base, value.accessToken!, method, path, body); }
      catch (error) {
        if (error instanceof SafeError && error.code === 'AUTH_REQUIRED') { value.expiresAt = 0; await tx.save(value); }
        if (error instanceof SafeError && error.code === 'CONNECTION_INACTIVE') {
          value.status = 'disabled'; value.cleanup = { backend: true, provider: true }; await tx.save(value); await this.cleanup(tx, value);
        }
        throw error;
      }
    });
  }
  private async cleanup(tx: Transaction, value: Credentials) {
    value.status = 'disabled'; value.cleanup ??= { backend: true, provider: true }; await tx.save(value);
    const candidate = value.recovery;
    if (candidate) { candidate.discard = true; await tx.save(value); }
    try { await this.cleanupOlder(tx, value, candidate?.verified ? candidate.grant : undefined); }
    catch { value.status = 'disabled'; await tx.save(value); return this.cleanupStatus(value); }
    if (candidate) {
      await this.discardCandidate(tx, value);
      if (value.recovery) return this.cleanupStatus(value);
    }
    await tx.save(); return { data: { status: 'disconnected' } };
  }
  async disconnect() {
    await this.cancel(); this.failure = undefined;
    return this.store.withLock(async tx => {
      const value = await tx.load();
      if (!value) return { data: { status: 'disconnected' } };
      return this.cleanup(tx, value);
    });
  }
}
