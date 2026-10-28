import { bootstrap } from './config.js';
import { authCleanup, SafeError, safeError, type Secrets } from './errors.js';
import { apiRequest } from './api.js';
import { object } from './http.js';
import { authorizationUrl, callback, discoveryKeys, openBrowser, proof, revoke, tokenRequest, verifyIdentity } from './oauth.js';
import { type Credentials, type Grant, type Transaction } from './store.js';
import { filterExternalInput } from './privacy.js';
import { createHash } from 'node:crypto';
import { decodeJwt } from 'jose';
import { checkRequestBudget, reserveRequest, startRequestInterval } from './traffic.js';
import { callRemoteTool } from './remote.js';

export const authenticationPending = () => ({ data: { status: 'authentication_pending', message: 'Finish browser sign-in, then run encbird_connect to check progress; use encbird_disconnect to cancel.' } });
const hasCleanup = (g: Grant) => !!(g.cleanup?.backend || g.cleanup?.provider);
const needsLogin = (g: Grant) => !!g.cleanup?.backend && (!g.accessToken || g.refreshInvalid || (!g.refreshToken && g.expiresAt <= Date.now()));
const incompatible = (a: Grant, b: Grant) => a.oauth.clientId !== b.oauth.clientId || a.oauth.issuer !== b.oauth.issuer || a.oauth.resource !== b.oauth.resource;
const permanent = (error: unknown) => error instanceof SafeError && [
  'INVALID_ID_TOKEN', 'ACCOUNT_MISMATCH', 'AUTH_CANCELLED', 'INVALID_TOKEN_RESPONSE', 'REFRESH_TOKEN_REQUIRED', 'INVALID_CONNECTION',
].includes(error.code);

// One locked transaction owns all durable connection and recovery transitions.
export class Connection {
  constructor(private readonly base: string, private readonly tx: Transaction, private readonly secrets: Secrets) {}

  async connect(started: (value: Record<string, unknown>) => void, signal: AbortSignal,
    browser: typeof openBrowser, callbackTimeoutMs: number) {
    let value = await this.tx.load();
    if (value?.status === 'active') { started(this.connected(value)); return; }
    if (value?.recovery) {
      if (value.recovery.discard) {
        const failure = await this.discardCandidate(value, true);
        if (value.recovery) { started(this.cleanupStatus(value, failure)); return; }
      } else {
        try { started(await this.resumeRecovery(value, signal)); }
        catch (error) {
          const failure = signal.aborted ? new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled. Do not restart without learner intent. Run encbird_disconnect if cleanup is still pending; preserve credential records until cleanup completes.') : error;
          await this.failedCandidate(value, failure); throw failure;
        }
        return;
      }
    }
    if (value && this.grants(value).some(hasCleanup) && !this.grants(value).some(needsLogin)) {
      throw new SafeError('CLEANUP_REQUIRED', 'The previous connection still needs cleanup. Run encbird_disconnect before encbird_connect. If cleanup reports reauthenticationRequired, connect with the same account to recover it; otherwise wait for cleanup to complete before signing in.');
    }
    if (value && this.grants(value).some(hasCleanup) && !value.subject) {
      throw new SafeError('OWNER_UNKNOWN', 'The previous connection has no verified owner. Ask an operator to reconcile the retained cleanup records before reconnecting; do not choose a replacement account, copy tokens, or delete credential or lock files.');
    }
    const oauth = await bootstrap(this.base);
    if (value && incompatible(value, { oauth, expiresAt: 0 })) {
      throw new SafeError('OAUTH_CLIENT_CHANGED', 'The sign-in client, issuer, or resource changed while previous connection records remain. Ask the operator to restore the compatible configuration or reconcile old cleanup before reconnecting. Preserve credential and lock files; do not bypass cleanup with a new scope.');
    }
    await discoveryKeys(oauth);
    value ??= { version: 1, status: 'disabled', oauth, expiresAt: 0, cleanup: { backend: false, provider: false } };
    const values = proof();
    this.secrets.add(values.verifier, values.state, values.nonce);
    const listener = await callback(values.state, signal, callbackTimeoutMs);
    try {
      await browser(authorizationUrl(oauth, values, !!value.subject));
      started(authenticationPending());
      const code = await listener.result;
      this.secrets.add(code);
      value.recovery = { grant: { oauth, expiresAt: 0, cleanup: { backend: false, provider: true } },
        nonce: values.nonce, verified: false, discard: false };
      await this.tx.save(value);
      const root = value;
      await tokenRequest(oauth, { grant_type: 'authorization_code', code, redirect_uri: oauth.redirectUri, code_verifier: values.verifier }, this.secrets,
        async tokens => {
          Object.assign(root.recovery!.grant, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt });
          root.recovery!.idToken = tokens.idToken; root.recovery!.tokenType = tokens.tokenType;
          await this.tx.save(root);
        });
      if (signal.aborted) throw new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled. Do not restart without learner intent. Run encbird_disconnect if cleanup is still pending; preserve credential records until cleanup completes.');
      await this.resumeRecovery(value, signal);
    } catch (error) {
      const failure = signal.aborted ? new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled. Do not restart without learner intent. Run encbird_disconnect if cleanup is still pending; preserve credential records until cleanup completes.') : error;
      await this.failedCandidate(value, failure);
      throw failure;
    } finally { listener.cancel(); }
  }
  private grants(value: Credentials): Grant[] { return [value, ...(value.pendingGrants ?? [])]; }
  private connected(value: Grant) { return { data: { status: 'connected', connectionId: value.connectionId } }; }
  private cleanupStatus(value: Credentials, failure?: unknown) {
    const grants = [...this.grants(value), ...(value.recovery ? [value.recovery.grant] : [])];
    const reauthenticationRequired = this.grants(value).some(needsLogin);
    return { data: { status: 'cleanup_pending', credentialsDisabled: true,
      backendPending: grants.some(g => g.cleanup?.backend), providerPending: grants.some(g => g.cleanup?.provider), reauthenticationRequired,
      message: [
        failure ? safeError(failure).error.message : reauthenticationRequired
          ? 'Cleanup needs fresh authorization. Run encbird_connect and have the learner sign in to the same account to recover previous connection cleanup.'
          : value.recovery && !value.recovery.discard
            ? 'Recovery is saved. Run encbird_connect to resume it after the reported problem is resolved, or encbird_disconnect to cancel and finish cleanup.'
            : 'Connection cleanup is pending. Run encbird_disconnect after the reported problem is resolved; if cleanup still cannot proceed, ask the operator to reconcile the retained records.',
        'Learning access remains disabled. Preserve credential and lock files; do not claim complete revocation until disconnected.',
      ].filter(Boolean).join(' ') } };
  }
  private async refresh(root: Credentials, grant: Grant) {
    if (!grant.refreshToken || grant.refreshInvalid) throw new SafeError('OAUTH_INVALID_GRANT', 'The stored connection has no usable refresh authorization. Run encbird_connect and have the learner sign in to the same account to recover pending cleanup before learning resumes.');
    const previousStatus = root.status;
    const previousCleanup = root.cleanup;
    root.status = 'pending'; root.cleanup ??= { backend: true, provider: true }; await this.tx.save(root);
    try {
      const tokens = await tokenRequest(grant.oauth, { grant_type: 'refresh_token', refresh_token: grant.refreshToken }, this.secrets,
        async tokens => { if (tokens.refreshToken) grant.refreshToken = tokens.refreshToken; await this.tx.save(root); });
      if (tokens.idToken && await verifyIdentity(grant.oauth, tokens.idToken) !== grant.subject) {
        throw new SafeError('INVALID_ID_TOKEN', `The refreshed identity did not match the connection. ${authCleanup}`);
      }
      grant.accessToken = tokens.accessToken; grant.expiresAt = tokens.expiresAt;
      root.status = previousStatus; root.cleanup = previousCleanup; await this.tx.save(root);
    } catch (error) {
      if (error instanceof SafeError && error.code === 'OAUTH_INVALID_GRANT') grant.refreshInvalid = true;
      root.status = 'disabled'; await this.tx.save(root);
      if (error instanceof SafeError && error.code === 'OAUTH_VERIFICATION_UNAVAILABLE') {
        throw new SafeError(error.code, 'Account identity verification is temporarily unavailable during connection refresh. After verification service access is restored, run encbird_disconnect to finish retained cleanup. If it reports reauthenticationRequired, use encbird_connect for same-account browser recovery. Preserve cleanup records; do not bypass verification or repeat learning writes.');
      }
      throw error;
    }
  }
  private async ensureAccess(root: Credentials, grant: Grant) {
    if (grant.expiresAt <= Date.now() + 30_000) await this.refresh(root, grant);
    if (!grant.accessToken || grant.expiresAt <= Date.now()) throw new SafeError('OAUTH_INVALID_GRANT', 'The connection has no usable access authorization after refresh. Run encbird_connect for same-account recovery and complete pending cleanup before resuming learning.');
  }
  private async verifyCandidate(value: Credentials) {
    const candidate = value.recovery!;
    if (candidate.verified) {
      if (!value.subject || candidate.grant.subject !== value.subject) throw new SafeError('ACCOUNT_MISMATCH', `The saved recovery identity does not match the previously verified account. ${authCleanup}`);
      return;
    }
    if (!candidate.grant.refreshToken) throw new SafeError('REFRESH_TOKEN_REQUIRED', `Sign-in did not provide the refresh authorization needed to maintain this connection. ${authCleanup}`);
    if (!candidate.grant.accessToken || candidate.tokenType?.toLowerCase() !== 'bearer' || !candidate.grant.expiresAt) {
      throw new SafeError('INVALID_TOKEN_RESPONSE', `Sign-in returned incomplete or invalid credentials. ${authCleanup}`);
    }
    const subject = await verifyIdentity(candidate.grant.oauth, candidate.idToken, candidate.nonce);
    if (value.subject && subject !== value.subject) throw new SafeError('ACCOUNT_MISMATCH', `The browser sign-in used a different account from the previous connection. Retained cleanup must finish under the original account before learning resumes. ${authCleanup}`);
    candidate.grant.subject = subject; candidate.verified = true;
    value.subject ??= subject;
    delete candidate.idToken;
    await this.tx.save(value);
  }
  private confirmRevoked(result: unknown, grant: Grant) {
    const data = object(result);
    if (data.status !== 'revoked' || typeof data.connectionId !== 'string' || !data.connectionId ||
        (grant.connectionId && data.connectionId !== grant.connectionId)) throw new SafeError('INVALID_CONNECTION', 'EncBird did not confirm revocation of the expected connection. Keep cleanup records and run encbird_disconnect after service recovery; ask the EncBird operator if confirmation still fails. Do not claim the connection is revoked.');
  }
  private async previousConnectionId(root: Credentials, grant: Grant) {
    if (grant.connectionId !== undefined) {
      if (!/^[0-9a-fA-F]{64}$/.test(grant.connectionId)) throw new SafeError('INVALID_CONNECTION_ID', 'The stored previous connection ID is invalid. Ask the operator to reconcile the retained cleanup records before reconnecting. Do not invent an ID, copy tokens, or delete credential or lock files.');
      if (grant.connectionId !== grant.connectionId.toLowerCase()) { grant.connectionId = grant.connectionId.toLowerCase(); await this.tx.save(root); }
      return grant.connectionId;
    }
    try {
      const family = decodeJwt(grant.accessToken ?? '').origin_jti;
      if (typeof family !== 'string' || !family || family.length > 256 || /[\s#\x00-\x1f\x7f]/.test(family)) throw new Error();
      // Unverified origin_jti selects a resource only; fresh verified identity supplies all authority.
      grant.connectionId = createHash('sha256').update(JSON.stringify([grant.oauth.clientId, family])).digest('hex');
    } catch { throw new SafeError('PREVIOUS_RESOURCE_MISSING', 'The previous connection ID cannot be recovered. Ask the operator to reconcile its retained private cleanup records before reconnecting. Do not invent an ID, copy tokens, or delete credential or lock files.'); }
    await this.tx.save(root);
    return grant.connectionId;
  }
  private async revokeBackend(root: Credentials, grant: Grant, fresh?: Grant) {
    const cleanup = grant.cleanup ??= { backend: true, provider: true };
    if (cleanup.backend) {
      if (fresh) {
        if (!fresh.subject || fresh.subject !== root.subject || (grant.subject && grant.subject !== fresh.subject) || incompatible(grant, fresh)) {
          throw new SafeError('ACCOUNT_MISMATCH', 'Previous connection cleanup cannot use this different account or sign-in client. Ask the operator to restore the compatible client and recover the original account; preserve pending cleanup records.');
        }
        await this.ensureAccess(root, fresh);
        const connectionId = await this.previousConnectionId(root, grant);
        this.confirmRevoked(await apiRequest(this.base, fresh.accessToken!, 'POST', '/connection/revoke-previous', { connectionId }), grant);
      } else {
        await this.ensureAccess(root, grant);
        this.confirmRevoked(await apiRequest(this.base, grant.accessToken!, 'DELETE', '/connection'), grant);
      }
      cleanup.backend = false; await this.tx.save(root);
    }
  }
  private async revokeProvider(root: Credentials, grant: Grant) {
    const cleanup = grant.cleanup ??= { backend: true, provider: true };
    if (cleanup.backend) throw new SafeError('CLEANUP_REQUIRED', 'EncBird connection revocation is still pending. Run encbird_disconnect after service recovery; if it reports reauthenticationRequired, use encbird_connect with the same account. Sign-in cleanup can finish only after EncBird confirms revocation.');
    delete grant.accessToken; grant.expiresAt = 0; await this.tx.save(root);
    if (cleanup.provider) {
      if (grant.refreshToken) await revoke(grant.oauth, grant.refreshToken);
      cleanup.provider = false; delete grant.refreshToken; await this.tx.save(root);
    }
  }
  private async cleanupOlder(root: Credentials, fresh?: Grant, signal?: AbortSignal) {
    const checkCancelled = () => { if (signal?.aborted) throw new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled. Do not restart without learner intent. Run encbird_disconnect if cleanup is still pending; preserve credential records until cleanup completes.'); };
    for (const grant of this.grants(root)) {
      checkCancelled();
      if (grant.cleanup?.backend) await this.revokeBackend(root, grant, fresh);
    }
    for (const grant of this.grants(root)) {
      checkCancelled();
      if (hasCleanup(grant)) await this.revokeProvider(root, grant);
    }
  }
  private async resumeRecovery(value: Credentials, signal?: AbortSignal) {
    await this.verifyCandidate(value);
    const candidate = value.recovery!;
    if (signal?.aborted) throw new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled. Do not restart without learner intent. Run encbird_disconnect if cleanup is still pending; preserve credential records until cleanup completes.');
    try { await this.ensureAccess(value, candidate.grant); }
    catch (error) {
      if (error instanceof SafeError && error.code === 'OAUTH_INVALID_GRANT') {
        if (candidate.grant.cleanup!.backend) {
          value.pendingGrants ??= []; value.pendingGrants.push(candidate.grant); delete value.recovery; await this.tx.save(value);
        } else { candidate.discard = true; await this.tx.save(value); await this.discardCandidate(value); }
      }
      throw error;
    }
    await this.cleanupOlder(value, candidate.grant, signal);
    if (signal?.aborted) throw new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled. Do not restart without learner intent. Run encbird_disconnect if cleanup is still pending; preserve credential records until cleanup completes.');
    candidate.grant.cleanup!.backend = true; await this.tx.save(value);
    await this.ensureAccess(value, candidate.grant);
    const result = object(await apiRequest(this.base, candidate.grant.accessToken!, 'POST', '/connections', {}));
    if (result.status !== 'active' || typeof result.connectionId !== 'string' || !result.connectionId || result.userId !== value.subject) {
      throw new SafeError('INVALID_CONNECTION', `EncBird returned an invalid connection confirmation or an unexpected identity. ${authCleanup}`);
    }
    if (signal?.aborted) throw new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled. Do not restart without learner intent. Run encbird_disconnect if cleanup is still pending; preserve credential records until cleanup completes.');
    const active: Credentials = { ...candidate.grant, version: 1, status: 'active', connectionId: result.connectionId };
    delete active.cleanup; delete active.refreshInvalid;
    await this.tx.save(active);
    return this.connected(active);
  }
  private async discardCandidate(value: Credentials, finishOlder = false) {
    if (!value.recovery) return;
    const fresh = value.recovery;
    const olderBackendPending = this.grants(value).some(g => g.cleanup?.backend);
    if (fresh.verified && olderBackendPending && !finishOlder && !fresh.grant.refreshInvalid) return;
    try {
      if (fresh.verified && olderBackendPending && !fresh.grant.refreshInvalid) await this.cleanupOlder(value, fresh.grant);
      await this.revokeBackend(value, fresh.grant);
      await this.revokeProvider(value, fresh.grant);
    }
    catch (error) {
      const candidate = value.recovery;
      if (error instanceof SafeError && error.code === 'OAUTH_INVALID_GRANT' && candidate.verified &&
          candidate.grant.subject === value.subject && candidate.grant.cleanup?.backend) {
        value.pendingGrants ??= []; value.pendingGrants.push(candidate.grant); delete value.recovery;
      }
      value.status = 'disabled'; await this.tx.save(value); return error;
    }
    delete value.recovery;
    if (!this.grants(value).some(hasCleanup) && !value.connectionId && !value.pendingGrants?.length) await this.tx.save(); else await this.tx.save(value);
  }
  private async failedCandidate(value: Credentials, error: unknown) {
    if (!value.recovery) return;
    if (error instanceof SafeError && error.code === 'CONNECTION_INACTIVE' && value.recovery.verified) {
      const grant = value.recovery.grant;
      grant.refreshInvalid = true; grant.cleanup!.backend = false;
      value.pendingGrants ??= []; value.pendingGrants.push(grant);
      delete value.recovery; value.status = 'disabled'; await this.tx.save(value);
      return;
    }
    if (permanent(error) || !value.recovery.grant.refreshToken) {
      value.recovery.discard = true; value.status = 'disabled'; await this.tx.save(value);
      await this.discardCandidate(value);
    }
  }
  async request(method: string, path: string, body?: unknown) {
    return this.authenticated({ path, body }, async token => {
      const currentToken = await token();
      const finishInterval = startRequestInterval();
      try { return await apiRequest(this.base, currentToken, method, path, body); }
      finally { await finishInterval(); }
    });
  }
  async callLearningTool(name: string, input: Record<string, unknown>) {
    return this.authenticated({ name, input }, token => callRemoteTool(this.base, token, name, input));
  }
  private async authenticated<T>(input: unknown, operation: (token: () => Promise<string>) => Promise<T>): Promise<T> {
    const value = await this.tx.load();
    if (!value || value.status !== 'active') throw new SafeError('AUTH_REQUIRED', 'No active local connection is available. Run encbird_connect and complete or check browser sign-in before using learning tools. If cleanup is required, run encbird_disconnect; use same-account recovery when requested.');
    filterExternalInput('transport', input, this.secrets);
    JSON.stringify(input, (key, item) => { filterExternalInput('transport', key, this.secrets); return item; });
    const token = async () => {
      checkRequestBudget(value.traffic);
      if (value.expiresAt <= Date.now() + 60_000) {
        try { await this.refresh(value, value); }
        catch (error) { value.status = 'disabled'; value.cleanup = { backend: true, provider: true }; await this.tx.save(value); throw error; }
      }
      value.traffic = await reserveRequest(value.traffic);
      await this.tx.save(value);
      return value.accessToken!;
    };
    try { return await operation(token); }
    catch (error) {
      if (error instanceof SafeError && error.retryAfterSeconds !== undefined && value.traffic) {
        value.traffic.blockedUntil = Date.now() + error.retryAfterSeconds * 1000;
        await this.tx.save(value);
      }
      if (error instanceof SafeError && error.code === 'AUTH_REQUIRED') {
        value.expiresAt = 0; await this.tx.save(value);
        throw new SafeError(error.code, 'EncBird rejected this connection authentication. Do not replay the write automatically. An explicit retry of the exact same operation lets the plugin refresh first; retain the original payload, key, and approval. If refresh fails, follow its cleanup or same-account encbird_connect recovery instructions. Never copy tokens or bypass sign-in.');
      }
      if (error instanceof SafeError && error.code === 'CONNECTION_INACTIVE') {
        value.status = 'disabled'; value.cleanup = { backend: true, provider: true }; await this.tx.save(value); await this.cleanup(value);
      }
      throw error;
    }
  }
  private async cleanup(value: Credentials) {
    value.status = 'disabled'; value.cleanup ??= { backend: true, provider: true }; await this.tx.save(value);
    const candidate = value.recovery;
    if (candidate) { candidate.discard = true; await this.tx.save(value); }
    try { await this.cleanupOlder(value, candidate?.verified ? candidate.grant : undefined); }
    catch (error) { value.status = 'disabled'; await this.tx.save(value); return this.cleanupStatus(value, error); }
    if (candidate) {
      const failure = await this.discardCandidate(value);
      if (value.recovery) return this.cleanupStatus(value, failure);
    }
    await this.tx.save(); return { data: { status: 'disconnected' } };
  }
  async disconnect() {
    const value = await this.tx.load();
    if (!value) return { data: { status: 'disconnected' } };
    return this.cleanup(value);
  }
}
