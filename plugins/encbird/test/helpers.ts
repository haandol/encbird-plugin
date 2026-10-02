import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT, jwtVerify, compactVerify } from 'jose';
import { CredentialStore } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Secrets } from '../src/errors.js';
import type { OAuthConfig } from '../src/config.js';
import snapshot from '../contracts/tools.json' with { type: 'json' };
import samples from '../contracts/serialization-samples.json' with { type: 'json' };

const keys = await generateKeyPair('RS256');
const otherKeys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'mock-key', use: 'sig', alg: 'RS256' };
export async function tempDirectory() {
  const parent = resolve('../../.test-tmp');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return realpath(await mkdtemp(`${parent}/case-`));
}
export async function mock() {
  const directory = await tempDirectory();
  let origin = '';
  let config: OAuthConfig;
  let currentKeys = keys;
  let currentJwk = jwk;
  const connectionOwners = new Map<string, string>();
  const connectionId = (family: string) => createHash('sha256').update(JSON.stringify([config.clientId, family])).digest('hex');
  const codes = new Map<string, { challenge: string; nonce: string; subject: string }>();
  const refreshMeta = new Map<string, { subject: string; family: string }>();
  const accessMeta = new Map<string, { subject: string; family: string; expiresAt: number }>();
  const revokedFamilies = new Set<string>();
  const registeredFamilies = new Set<string>();
  const refreshTokens = new Set<string>();
  const issued: string[] = [];
  const requests: { method: string; path: string; body: unknown; token?: string }[] = [];
  const flags = { badState: false, badNonce: false, badSignature: false, badIssuer: false, badAudience: false,
    expiredId: false, badPkce: false, providerFailure: false, backendFailure: false, registrationFailure: false,
    configRedirect: false, jwksRedirect: false, badDiscovery: false, wrongUser: false, rotation: true,
    malformedToken: false, missingRefresh: false, noCallback: false, refreshFailure: false, refreshUnavailable: false,
    signedAccess: false, subject: 'test-user', verificationFailure: false, previousRevocationFailure: false, previousRevocationFailureAt: 0,
    apiStatus: 200, apiBody: undefined as unknown };
  const counts = { exchange: 0, refresh: 0, revoke: 0, register: 0, disconnect: 0, revokePrevious: 0 };
  const hooks: { beforePreviousRevocation?: () => Promise<void> } = {};
  async function identity(nonce?: string, subject = 'test-user') {
    return new SignJWT({ token_use: 'id', ...(nonce ? { nonce: flags.badNonce ? 'incorrect' : nonce } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: currentJwk.kid }).setSubject(subject)
      .setIssuer(flags.badIssuer ? `${origin}/wrong` : config.issuer).setAudience(flags.badAudience ? 'wrong-client' : config.clientId)
      .setIssuedAt().setExpirationTime(flags.expiredId ? Math.floor(Date.now() / 1000) - 10 : '1h').sign(flags.badSignature ? (currentKeys === keys ? otherKeys.privateKey : keys.privateKey) : currentKeys.privateKey);
  }
  async function access(subject: string, family: string, expiresAt: number) {
    const token = flags.signedAccess ? await new SignJWT({ token_use: 'access', client_id: config.clientId, origin_jti: family, scope: config.scopes.join(' ') })
      .setProtectedHeader({ alg: 'RS256', kid: currentJwk.kid }).setSubject(subject).setIssuer(config.issuer).setAudience(config.resource)
      .setIssuedAt().setExpirationTime(Math.floor(expiresAt / 1000)).sign(currentKeys.privateKey) : `AT-${randomUUID()}`;
    accessMeta.set(token, { subject, family, expiresAt }); connectionOwners.set(connectionId(family), subject); issued.push(token); return token;
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = req.headers['content-type']?.includes('application/json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
      requests.push({ method: req.method!, path: `${url.pathname}${url.search}`, body, token: req.headers.authorization });
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/v1/mcp-learning/config') {
        if (flags.configRedirect) { res.writeHead(302, { location: `${origin}/untrusted` }).end(); return; }
        send(200, { apiVersion: '1', oauth: config }); return;
      }
      if (url.pathname === '/issuer/.well-known/openid-configuration') {
        if (flags.verificationFailure) { send(503, {}); return; }
        send(200, { issuer: flags.badDiscovery ? 'https://wrong.example' : config.issuer,
          authorization_endpoint: config.authorizationEndpoint, token_endpoint: config.tokenEndpoint, jwks_uri: `${origin}/issuer/keys` }); return;
      }
      if (url.pathname === '/issuer/keys') {
        if (flags.jwksRedirect) { res.writeHead(302, { location: `${origin}/untrusted` }).end(); return; }
        send(200, { keys: [currentJwk] }); return;
      }
      if (url.pathname === '/authorize') {
        if (url.searchParams.get('code_challenge_method') !== 'S256' || url.searchParams.get('redirect_uri') !== config.redirectUri ||
            url.searchParams.get('client_id') !== config.clientId || url.searchParams.get('resource') !== config.resource) { send(400, {}); return; }
        const code = randomUUID();
        codes.set(code, { challenge: flags.badPkce ? 'wrong' : url.searchParams.get('code_challenge')!, nonce: url.searchParams.get('nonce')!, subject: flags.subject });
        const callback = new URL(config.redirectUri);
        callback.search = new URLSearchParams({ code, state: flags.badState ? 'wrong' : url.searchParams.get('state')! }).toString();
        send(200, { callback: callback.href }); return;
      }
      if (url.pathname === '/token') {
        let nonce: string | undefined;
        let subject = 'test-user'; let family: string = randomUUID();
        if (body.grant_type === 'authorization_code') {
          counts.exchange++;
          const code = codes.get(body.code); codes.delete(body.code);
          if (!code || body.redirect_uri !== config.redirectUri ||
              createHash('sha256').update(body.code_verifier).digest('base64url') !== code.challenge) { send(400, { error: 'invalid_grant' }); return; }
          nonce = code.nonce; subject = code.subject;
        } else {
          counts.refresh++;
          if (flags.refreshUnavailable) { send(503, { error: 'temporarily_unavailable' }); return; }
          if (flags.refreshFailure || !refreshTokens.has(body.refresh_token)) { send(400, { error: 'invalid_grant' }); return; }
          const metadata = refreshMeta.get(body.refresh_token)!; subject = metadata.subject; family = metadata.family;
          if (flags.rotation) refreshTokens.delete(body.refresh_token);
        }
        const at = await access(subject, family, Date.now() + 3_600_000);
        const rt = `RT-${randomUUID()}`;
        const includeRefresh = !flags.missingRefresh && (nonce !== undefined || flags.rotation);
        if (includeRefresh) { refreshTokens.add(rt); refreshMeta.set(rt, { subject, family }); }
        issued.push(at, rt);
        send(200, { access_token: at, ...(includeRefresh ? { refresh_token: rt } : {}), id_token: await identity(nonce, subject), expires_in: flags.malformedToken ? 'bad' : 3600, token_type: 'Bearer' }); return;
      }
      if (url.pathname === '/revoke') {
        counts.revoke++;
        if (flags.providerFailure) { send(503, { error: 'temporarily_unavailable' }); return; }
        refreshTokens.delete(body.token);
        res.writeHead(200).end(); return;
      }
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const current = accessMeta.get(bearer);
      if (!current || current.expiresAt <= Date.now()) { send(401, { error: { code: 'UNAUTHORIZED', message: 'stack with secret' } }); return; }
      if (flags.signedAccess) {
        try { await jwtVerify(bearer, currentKeys.publicKey, { issuer: config.issuer, audience: config.resource }); }
        catch { send(401, { error: { code: 'UNAUTHORIZED', message: 'expired bearer' } }); return; }
      }
      if (url.pathname === '/v1/mcp-learning/connection/revoke-previous') {
        counts.revokePrevious++;
        await hooks.beforePreviousRevocation?.();
        if (revokedFamilies.has(connectionId(current.family))) { send(403, { error: { code: 'CONNECTION_INACTIVE', message: 'revoked current grant' } }); return; }
        if (flags.previousRevocationFailure || counts.revokePrevious === flags.previousRevocationFailureAt) { send(503, { error: { code: 'LEARNING_UNAVAILABLE', message: 'unavailable' } }); return; }
        if (Object.keys(body).length !== 1 || typeof body.connectionId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(body.connectionId)) {
          send(400, { error: { code: 'INVALID_REQUEST', message: 'invalid resource selector' } }); return;
        }
        // The mock follows the server's USER#fresh.Sub namespace, never token-derived authority.
        const previousId = body.connectionId.toLowerCase();
        if (connectionOwners.get(previousId) === current.subject) revokedFamilies.add(previousId);
        send(200, { data: { connectionId: previousId, status: 'revoked' } }); return;
      }
      if (url.pathname === '/v1/mcp-learning/connections') {
        counts.register++;
        if (flags.registrationFailure) { send(503, { error: { code: 'UNAVAILABLE', message: 'secret stack' } }); return; }
        if (revokedFamilies.has(connectionId(current.family))) { send(403, { error: { code: 'CONNECTION_INACTIVE', message: 'revoked' } }); return; }
        registeredFamilies.add(connectionId(current.family));
        send(200, { data: { connectionId: connectionId(current.family), userId: flags.wrongUser ? 'wrong-user' : current.subject, status: 'active' } }); return;
      }
      if (url.pathname === '/v1/mcp-learning/connection') {
        counts.disconnect++;
        if (flags.backendFailure) { send(503, { error: { code: 'UNAVAILABLE', message: 'secret stack' } }); return; }
        revokedFamilies.add(connectionId(current.family));
        send(200, { data: { connectionId: connectionId(current.family), status: 'revoked' } }); return;
      }
      const route = Object.entries(snapshot.routes).find(([, route]) => route.method === req.method && (route.path.includes('{id}') ? url.pathname.startsWith('/v1/mcp-learning/expressions/') : url.pathname === `/v1/mcp-learning${route.path}`));
      const fixture = route ? (samples as Record<string, { output: unknown }>)[route[0]]?.output : undefined;
      send(flags.apiStatus, flags.apiBody ?? fixture ?? { data: null });
    } catch { res.writeHead(500).end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  origin = `http://127.0.0.1:${address.port}`;
  const base = `${origin}/v1/mcp-learning`;
  config = { issuer: `${origin}/issuer`, clientId: 'public-client', authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`, revocationEndpoint: `${origin}/revoke`, resource: 'https://api.encbird.com',
    scopes: ['openid', 'learning.read', 'learning.write'], redirectUri: 'http://localhost:18765/oauth/callback' };
  const secrets = new Secrets();
  const store = new CredentialStore(base, 'mock-host', secrets, directory);
  const browser = async (url: string) => {
    if (flags.noCallback) return;
    const result = await fetch(url); const data = await result.json() as { callback: string };
    await fetch(data.callback);
  };
  const auth = new Auth(base, store, secrets, browser);
  return { hooks, accessMeta, revokedFamilies, registeredFamilies,
    connectionIdFor(token: string) { return connectionId(accessMeta.get(token)!.family); },
    async retireSigningKey() { currentKeys = otherKeys; currentJwk = { ...await exportJWK(otherKeys.publicKey), kid: 'replacement-key', use: 'sig', alg: 'RS256' }; },
    async currentKeyVerifies(token: string) { try { await compactVerify(token, currentKeys.publicKey); return true; } catch { return false; } },
    async expiredAccess(token: string) { const old = accessMeta.get(token)!; return access(old.subject, old.family, Date.now() - 120_000); },
    auth, store, secrets, base, origin, config, flags, counts, requests, issued, refreshTokens, directory, browser,
    read: () => store.withLock(tx => tx.load()),
    async login() { const started = await auth.connect(); await auth.waitForIdle(); return { started, result: await auth.connect() }; },
    async close() { await auth.cancel(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); },
  };
}
