import { createServer, type Server } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { type OAuthConfig, REDIRECT_URI } from './config.js';
import { authCleanup, SafeError, Secrets } from './errors.js';
import { object, requestJson, serviceUrl } from './http.js';

export function proof() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url') };
}
export function authorizationUrl(config: OAuthConfig, values: ReturnType<typeof proof>, forceLogin = false) {
  const url = new URL(config.authorizationEndpoint);
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: REDIRECT_URI,
    scope: config.scopes.join(' '), resource: config.resource, code_challenge: values.challenge,
    code_challenge_method: 'S256', state: values.state, nonce: values.nonce }).toString();
  if (forceLogin) url.searchParams.set('prompt', 'login');
  return url.href;
}
export async function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!command) throw new SafeError('BROWSER_UNAVAILABLE', 'Automatic browser sign-in requires macOS or Linux. Use a supported local desktop and encbird_connect when the learner wants to sign in; never copy tokens or callback URLs into the assistant.');
  try { await promisify(execFile)(command, [url], { timeout: 5_000, maxBuffer: 4096 }); }
  catch { throw new SafeError('BROWSER_UNAVAILABLE', 'The sign-in browser could not be opened. Ask the local operator to restore the default browser launcher in this desktop session, then use encbird_connect if the learner still wants to sign in. Never copy tokens or callback URLs.'); }
}
export async function callback(state: string, signal: AbortSignal, timeoutMs = 180_000) {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Attach a rejection handler before the browser has had time to open.
  void code.catch(() => {});
  const servers: Server[] = [];
  const fail = (error: SafeError) => rejectCode(error);
  const close = () => { for (const server of servers) { server.close(); server.closeAllConnections(); } };
  const abort = () => fail(new SafeError('AUTH_CANCELLED', 'Sign-in was cancelled. Do not restart without learner intent. Run encbird_disconnect if cleanup is still pending; preserve credential records until cleanup completes.'));
  const timer = setTimeout(() => fail(new SafeError('AUTH_TIMEOUT', 'Browser sign-in timed out. If the learner still wants to connect, run encbird_connect for a fresh browser flow and complete it before the timeout; do not reuse the old callback.')), timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (const host of ['127.0.0.1', '::1']) {
      const server = createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        res.setHeader('Referrer-Policy', 'no-referrer');
        if (req.method !== 'GET' || req.headers.host !== 'localhost:18765' ||
            (req.headers.origin && req.headers.origin !== 'http://localhost:18765')) { res.writeHead(400).end('Invalid callback.'); return; }
        let url: URL;
        try {
          const target = req.url ?? '/';
          if (!target.startsWith('/') || target.startsWith('//') || /[\s\x00-\x1f\x7f#\\]/.test(target)) throw new Error();
          url = new URL(target, REDIRECT_URI);
          if (url.origin !== new URL(REDIRECT_URI).origin || url.pathname !== target.split('?')[0]) throw new Error();
        } catch { res.writeHead(400).end('Invalid callback.'); return; }
        if (url.pathname !== '/oauth/callback') { res.writeHead(404).end('Not found.'); return; }
        const received = url.searchParams.get('state') ?? '';
        if (url.searchParams.getAll('state').length !== 1 || Buffer.byteLength(received) !== Buffer.byteLength(state) ||
            !timingSafeEqual(Buffer.from(received), Buffer.from(state))) {
          res.writeHead(400).end('Invalid sign-in state.'); fail(new SafeError('OAUTH_STATE_MISMATCH', 'The browser callback did not match this sign-in attempt. If the learner still wants to connect, start a fresh flow with encbird_connect and use only its browser window; never reuse or copy callback data.')); return;
        }
        const value = url.searchParams.get('code');
        if (url.searchParams.has('error') || url.searchParams.getAll('code').length !== 1 || !value || value.length > 4096) {
          res.writeHead(400).end('Sign-in was not completed.'); fail(new SafeError('AUTH_DENIED', 'Browser sign-in was denied or incomplete. Wait for the learner to choose to sign in, then start a fresh flow with encbird_connect; do not retry automatically.')); return;
        }
        res.end('Sign-in callback received. Return to your assistant to check the connection.');
        resolveCode(value);
      });
      servers.push(server);
      try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(18765, host, resolve); });
      } catch (error) {
        if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw new SafeError('CALLBACK_PORT_BUSY', 'The local sign-in callback could not listen on port 18765. Let any other sign-in finish; if the port remains unavailable, ask the local operator to inspect it. Retry encbird_connect only once the port is available; do not stop unrelated processes.');
      }
    }
  } catch (error) { clearTimeout(timer); signal.removeEventListener('abort', abort); close(); throw error; }
  if (signal.aborted) abort();
  const result = code.finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); close(); });
  void result.catch(() => {});
  return { result, cancel: abort };
}

export interface Tokens { accessToken: string; refreshToken?: string; idToken?: string; expiresAt: number }
export async function tokenRequest(config: OAuthConfig, form: Record<string, string>, secrets: Secrets,
  checkpoint?: (tokens: { accessToken?: string; refreshToken?: string; idToken?: string; tokenType?: string; expiresAt: number }) => Promise<void>): Promise<Tokens> {
  const { status, body } = await requestJson(config.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, ...form }) });
  const data = object(body);
  secrets.add(data.access_token, data.refresh_token, data.id_token);
  if (status !== 200) {
    if (data.error === 'invalid_grant') throw new SafeError('OAUTH_INVALID_GRANT', form.grant_type === 'refresh_token'
      ? 'The stored refresh authorization is no longer usable. Run encbird_connect for same-account browser recovery and complete any requested cleanup before learning resumes.'
      : 'The browser sign-in authorization is no longer usable. If the learner still wants to connect, run encbird_connect for a fresh browser flow with the same account if recovering a previous connection. Do not reuse the old callback or repeat a learning write.');
    throw new SafeError('OAUTH_TOKEN_FAILED', 'Sign-in credentials could not be obtained or refreshed. Do not repeat a learning write. After service access is restored, run encbird_disconnect for retained cleanup; use encbird_connect for same-account recovery when reauthenticationRequired is reported. If it persists, ask the operator to check sign-in configuration.');
  }
  await checkpoint?.({ accessToken: typeof data.access_token === 'string' ? data.access_token : undefined,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    idToken: typeof data.id_token === 'string' ? data.id_token : undefined,
    tokenType: typeof data.token_type === 'string' ? data.token_type : undefined,
    expiresAt: typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0 && data.expires_in <= 86400 ? Date.now() + data.expires_in * 1000 : 0 });
  if (typeof data.access_token !== 'string' || !data.access_token ||
      typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400 ||
      typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' ||
      [data.refresh_token, data.id_token].some(v => v !== undefined && (typeof v !== 'string' || !v))) {
    throw new SafeError('INVALID_TOKEN_RESPONSE', `Sign-in returned incomplete or invalid credentials. ${authCleanup}`);
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token as string | undefined,
    idToken: data.id_token as string | undefined, expiresAt: Date.now() + data.expires_in * 1000 };
}
export async function discoveryKeys(config: OAuthConfig): Promise<URL> {
  try {
    const discovery = await requestJson(`${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (discovery.status >= 500) throw new SafeError('OAUTH_VERIFICATION_UNAVAILABLE', 'Account identity verification is temporarily unavailable. After service access is restored, run encbird_connect to start or resume verification; use encbird_disconnect to cancel and clean up any retained flow. Do not bypass verification or repeat learning writes.');
    const doc = object(discovery.body);
    if (discovery.status !== 200 || doc.issuer !== config.issuer || doc.authorization_endpoint !== config.authorizationEndpoint ||
        doc.token_endpoint !== config.tokenEndpoint ||
        (doc.revocation_endpoint !== undefined && doc.revocation_endpoint !== config.revocationEndpoint) ||
        typeof doc.jwks_uri !== 'string') throw new Error();
    const jwksUrl = serviceUrl(doc.jwks_uri);
    if (jwksUrl.origin !== new URL(config.issuer).origin || jwksUrl.username || jwksUrl.password || jwksUrl.search || jwksUrl.hash) throw new Error();
    return jwksUrl;
  } catch (error) {
    if (error instanceof SafeError && ['NETWORK_ERROR', 'OAUTH_VERIFICATION_UNAVAILABLE'].includes(error.code)) throw error;
    throw new SafeError('INVALID_ID_TOKEN', 'Sign-in discovery did not match the configured issuer and endpoints. Ask the EncBird operator to repair configuration before retrying encbird_connect; preserve any cleanup records and do not substitute endpoints.');
  }
}
export async function verifyIdentity(config: OAuthConfig, idToken: string | undefined, nonce?: string) {
  if (!idToken) throw new SafeError('INVALID_ID_TOKEN', `Sign-in did not return the identity proof required to verify the account. ${authCleanup}`);
  try {
    const jwksUrl = await discoveryKeys(config);
    const keys = await requestJson(jwksUrl.href);
    if (keys.status >= 500) throw new SafeError('OAUTH_VERIFICATION_UNAVAILABLE', 'Account identity verification is temporarily unavailable. After service access is restored, run encbird_connect to start or resume verification; use encbird_disconnect to cancel and clean up any retained flow. Do not bypass verification or repeat learning writes.');
    if (keys.status !== 200) throw new Error();
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(object(keys.body) as unknown as JSONWebKeySet), {
      issuer: config.issuer, audience: config.clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp'], clockTolerance: 5,
    });
    if (payload.token_use !== 'id' || typeof payload.sub !== 'string' || !payload.sub || (nonce !== undefined && payload.nonce !== nonce) ||
        (payload.azp !== undefined && payload.azp !== config.clientId)) throw new Error();
    return payload.sub;
  } catch (error) {
    if (error instanceof SafeError && error.code === 'OAUTH_VERIFICATION_UNAVAILABLE') throw new SafeError(error.code, 'Account identity verification is temporarily unavailable. After service access is restored, run encbird_connect to resume the saved verification flow; use encbird_disconnect to cancel and clean up. Do not bypass verification or repeat learning writes.');
    if (error instanceof SafeError && error.code === 'NETWORK_ERROR') throw error;
    throw new SafeError('INVALID_ID_TOKEN', `Account identity proof failed signature, issuer, audience, or nonce validation. ${authCleanup}`);
  }
}

export async function revoke(config: OAuthConfig, refreshToken: string) {
  const { status } = await requestJson(config.revocationEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, token: refreshToken, token_type_hint: 'refresh_token' }) });
  if (status < 200 || status >= 300) throw new SafeError('REVOCATION_FAILED', 'Sign-in authorization revocation was not confirmed. Run encbird_disconnect after service access is restored to retry pending cleanup; ask the operator if it persists. Preserve credential records and do not claim complete revocation.');
}
