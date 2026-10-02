import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth } from '../src/auth.js';
import { mock } from './helpers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { CredentialStore, type Grant } from '../src/store.js';

async function expiredGrant() {
  const m = await mock(); m.flags.signedAccess = true; await m.login();
  await m.store.withLock(async tx => {
    const value = (await tx.load())!;
    value.accessToken = await m.expiredAccess(value.accessToken!); value.expiresAt = Date.now() - 120_000;
    m.refreshTokens.delete(value.refreshToken!); await tx.save(value);
  });
  const previous = (await m.read())!;
  await assert.rejects(m.auth.request('GET', '/context'), { code: 'OAUTH_INVALID_GRANT' });
  assert.equal((await m.read())!.refreshInvalid, true);
  return { m, previous };
}

async function reconnect(auth: Auth) { const result = await auth.connect(); await auth.waitForIdle(); return result; }

test('expired signed access + invalid_grant -> same-account login -> old revocation -> new connected', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close());
  const pending = await m.auth.disconnect();
  assert.equal(pending.data.status, 'cleanup_pending'); assert.equal((pending.data as any).reauthenticationRequired, true);
  await reconnect(m.auth);
  const current = (await m.read())!;
  assert.equal(current.status, 'active'); assert.equal(current.subject, previous.subject);
  assert.notEqual(current.connectionId, previous.connectionId); assert.ok(m.revokedFamilies.has(previous.connectionId!));
  assert.equal(current.recovery, undefined); assert.equal(current.pendingGrants, undefined);
  const proofIndex = m.requests.findIndex(r => r.path.endsWith('/revoke-previous'));
  const proof = m.requests[proofIndex]!;
  assert.deepEqual(proof.body, { connectionId: previous.connectionId });
  assert.ok(!m.requests.some(r => JSON.stringify(r.body).includes(previous.accessToken!)));
  assert.notEqual(proof.token, `Bearer ${previous.accessToken}`);
  assert.ok(!m.requests.some(r => r.token === `Bearer ${previous.accessToken}`));
  const providerIndex = m.requests.findIndex((r, i) => i > proofIndex && r.path === '/revoke' && (r.body as any).token === previous.refreshToken);
  const registerIndex = m.requests.findIndex((r, i) => i > providerIndex && r.path.endsWith('/connections'));
  assert.ok(proofIndex >= 0 && providerIndex > proofIndex && registerIndex > providerIndex);
  const prompts = m.requests.filter(r => r.path.startsWith('/authorize')).map(r => new URL(r.path, m.origin).searchParams.get('prompt'));
  assert.deepEqual(prompts, [null, 'login']);
  assert.equal(((await m.auth.connect()).data as any).status, 'connected'); await m.auth.waitForIdle();
});

test('wrong-account recovery revokes only the unregistered fresh grant and preserves the owner', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close()); m.flags.subject = 'another-user';
  await reconnect(m.auth);
  const result = await m.auth.connect(); await m.auth.waitForIdle();
  assert.equal((result.error as any).code, 'ACCOUNT_MISMATCH');
  const saved = (await m.read())!;
  assert.equal(saved.subject, previous.subject); assert.equal(saved.connectionId, previous.connectionId);
  assert.equal(saved.accessToken, previous.accessToken); assert.equal(saved.recovery, undefined);
  assert.equal(m.counts.revokePrevious, 0); assert.equal(m.counts.register, 1); assert.equal(m.counts.revoke, 1);
  m.flags.subject = previous.subject!; await reconnect(m.auth); assert.equal((await m.read())!.status, 'active');
});

test('cancelled recovery preserves the expired previous grant across a new client instance', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close()); m.flags.noCallback = true;
  assert.equal(((await m.auth.connect()).data as any).status, 'authentication_pending');
  await m.auth.cancel();
  assert.equal((await m.read())!.accessToken, previous.accessToken); assert.equal((await m.read())!.subject, previous.subject);
  assert.equal(m.counts.revokePrevious, 0); assert.equal(m.counts.register, 1);
  m.flags.noCallback = false;
  const restarted = new Auth(m.base, m.store, m.secrets, m.browser); await reconnect(restarted);
  assert.equal((await m.read())!.status, 'active');
});

for (const failure of ['previousRevocationFailure', 'providerFailure'] as const) {
  test(`recovery resumes ${failure} after restart without losing either grant`, async t => {
    const { m, previous } = await expiredGrant(); t.after(() => m.close()); m.flags[failure] = true;
    await reconnect(m.auth);
    const pending = (await m.read())!;
    assert.notEqual(pending.status, 'active'); assert.ok(pending.recovery?.verified);
    assert.ok(pending.recovery?.grant.refreshToken); assert.ok(pending.refreshToken);
    assert.equal(m.counts.register, 1);
    const freshAccess = pending.recovery!.grant.accessToken!;
    const exchanges = m.counts.exchange;
    m.flags[failure] = false;
    const restarted = new Auth(m.base, m.store, m.secrets, m.browser);
    const result = await reconnect(restarted);
    assert.equal((result.data as any).status, 'connected'); assert.equal(m.counts.exchange, exchanges);
    assert.equal((await m.read())!.accessToken, freshAccess); assert.ok(m.revokedFamilies.has(previous.connectionId!));
    if (failure === 'providerFailure') assert.equal(m.counts.revokePrevious, 1);
  });
}

test('fresh tokens and nonce persist before identity verification and verify after restart', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close()); m.flags.verificationFailure = true;
  await reconnect(m.auth);
  const staged = (await m.read())!;
  assert.equal(staged.recovery?.verified, false); assert.ok(staged.recovery?.idToken); assert.ok(staged.recovery?.nonce);
  assert.ok(staged.recovery?.grant.refreshToken); assert.equal(m.counts.revokePrevious, 0);
  const serialized = JSON.stringify(m.secrets.clean(staged));
  assert.ok(!serialized.includes(staged.recovery!.idToken!)); assert.ok(!serialized.includes(previous.accessToken!));
  m.flags.verificationFailure = false;
  const restarted = new Auth(m.base, m.store, m.secrets, m.browser); await reconnect(restarted);
  assert.equal((await m.read())!.status, 'active'); assert.equal(m.counts.exchange, 2);
});

test('nonce rejection after restart never revokes the previous backend family', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close()); m.flags.verificationFailure = true;
  await reconnect(m.auth);
  await m.store.withLock(async tx => { const value = (await tx.load())!; value.recovery!.nonce = 'incorrect-nonce'; await tx.save(value); });
  m.flags.verificationFailure = false;
  const restarted = new Auth(m.base, m.store, m.secrets, m.browser); const result = await reconnect(restarted);
  assert.equal((result.error as any).code, 'INVALID_ID_TOKEN');
  assert.equal(m.counts.revokePrevious, 0); assert.equal(m.counts.register, 1);
  assert.equal((await m.read())!.subject, previous.subject); assert.equal((await m.read())!.accessToken, previous.accessToken);
});

test('blocked JWKS redirect retains unverified private credentials and can resume securely', async t => {
  const m = await mock(); t.after(() => m.close()); m.flags.jwksRedirect = true;
  await reconnect(m.auth);
  assert.equal(m.counts.register, 0); assert.equal((await m.read())?.recovery?.verified, false);
  assert.ok(!m.requests.some(r => r.path === '/untrusted'));
  m.flags.jwksRedirect = false;
  const restarted = new Auth(m.base, m.store, m.secrets, m.browser); await reconnect(restarted);
  assert.equal((await m.read())!.status, 'active'); assert.equal(m.counts.exchange, 1);
});

test('a second invalid grant during ambiguous new registration is retained for another same-account recovery', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close()); m.flags.registrationFailure = true;
  await reconnect(m.auth);
  await m.store.withLock(async tx => {
    const value = (await tx.load())!; const candidate = value.recovery!.grant;
    candidate.accessToken = await m.expiredAccess(candidate.accessToken!); candidate.expiresAt = Date.now() - 120_000;
    m.refreshTokens.delete(candidate.refreshToken!); await tx.save(value);
  });
  m.flags.registrationFailure = false;
  const restarted = new Auth(m.base, m.store, m.secrets, m.browser);
  assert.equal(((await reconnect(restarted)).error as any).code, 'OAUTH_INVALID_GRANT');
  assert.equal((await m.read())!.pendingGrants?.length, 1);
  await reconnect(restarted); // Surface the saved failure before a new browser attempt.
  await reconnect(restarted);
  assert.equal((await m.read())!.status, 'active'); assert.equal((await m.read())!.subject, previous.subject);
  assert.equal(m.counts.exchange, 3); assert.equal(m.counts.revokePrevious, 2);
});

test('a separately launched MCP process resumes persisted previous-grant cleanup', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close()); m.flags.previousRevocationFailure = true;
  await reconnect(m.auth); assert.ok((await m.read())!.recovery?.verified);
  m.flags.previousRevocationFailure = false;
  let stderr = '';
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')],
    env: { PATH: process.env.PATH ?? '', ENCBIRD_CREDENTIALS_DIR: m.directory, ENCBIRD_API_BASE_URL: m.base }, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'mock-host', version: '1.0.0' }); t.after(() => client.close()); await client.connect(transport);
  const result = await client.callTool({ name: 'encbird_connect', arguments: {} });
  assert.equal((result.structuredContent as any).data.status, 'connected');
  assert.ok(m.revokedFamilies.has(previous.connectionId!)); assert.equal(m.counts.exchange, 2);
  for (const token of m.issued) assert.ok(!JSON.stringify(result).includes(token));
  await client.close(); assert.equal(stderr, '');
});

test('transient refresh failure remains retryable and is not classified as invalid_grant', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); m.flags.refreshUnavailable = true;
  await m.store.withLock(async tx => { const value = (await tx.load())!; value.expiresAt = 0; await tx.save(value); });
  const previous = (await m.read())!;
  await assert.rejects(m.auth.request('GET', '/context'), { code: 'OAUTH_TOKEN_FAILED' });
  assert.notEqual((await m.read())!.refreshInvalid, true); assert.equal((await m.read())!.refreshToken, previous.refreshToken);
  m.flags.refreshUnavailable = false;
  assert.equal((await m.auth.disconnect()).data.status, 'disconnected'); assert.equal(m.counts.exchange, 1);
});

async function addPreviousGrant(m: Awaited<ReturnType<typeof mock>>): Promise<Grant> {
  const auxiliaryStore = new CredentialStore(m.base, 'previous-recovery-fixture', m.secrets, m.directory);
  const auxiliaryAuth = new Auth(m.base, auxiliaryStore, m.secrets, m.browser);
  await reconnect(auxiliaryAuth);
  const saved = (await auxiliaryStore.withLock(tx => tx.load()))!;
  const grant: Grant = { oauth: saved.oauth, subject: saved.subject, connectionId: saved.connectionId,
    accessToken: await m.expiredAccess(saved.accessToken!), refreshToken: saved.refreshToken,
    expiresAt: Date.now() - 120_000, refreshInvalid: true, cleanup: { backend: true, provider: true } };
  m.refreshTokens.delete(grant.refreshToken!);
  await m.store.withLock(async tx => { const root = (await tx.load())!; root.pendingGrants = [grant]; await tx.save(root); });
  return grant;
}

test('all older backend revocations finish before any old provider token is closed', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close()); const second = await addPreviousGrant(m);
  m.flags.previousRevocationFailureAt = 2;
  const start = m.requests.length;
  await reconnect(m.auth);
  const pending = (await m.read())!;
  assert.equal(pending.cleanup?.backend, false); assert.equal(pending.pendingGrants![0]!.cleanup?.backend, true);
  assert.equal(pending.refreshToken, previous.refreshToken); assert.equal(pending.pendingGrants![0]!.refreshToken, second.refreshToken);
  assert.equal(m.counts.revoke, 0); assert.ok(pending.recovery?.grant.refreshToken);
  m.flags.previousRevocationFailureAt = 0;
  const restarted = new Auth(m.base, m.store, m.secrets, m.browser); await reconnect(restarted);
  assert.equal((await m.read())!.status, 'active');
  const requests = m.requests.slice(start);
  const lastBackend = Math.max(...requests.map((r, i) => r.path.endsWith('/revoke-previous') ? i : -1));
  const firstProvider = requests.findIndex(r => r.path === '/revoke');
  assert.ok(firstProvider > lastBackend); assert.equal(m.counts.revoke, 2);
});

test('cancelling partial older-grant cleanup preserves fresh refresh capability across restart', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close()); const second = await addPreviousGrant(m);
  let reached!: () => void; const blocked = new Promise<void>(resolve => { reached = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  m.flags.previousRevocationFailureAt = 2;
  m.hooks.beforePreviousRevocation = async () => { if (m.counts.revokePrevious === 2) { reached(); await gate; } };
  await m.auth.connect(); await blocked;
  const cancelled = m.auth.cancel(); release(); await cancelled;
  const saved = (await m.read())!;
  assert.equal(saved.subject, previous.subject); assert.equal(saved.recovery?.discard, true);
  assert.ok(saved.recovery?.grant.refreshToken); assert.equal(saved.pendingGrants![0]!.accessToken, second.accessToken);
  assert.equal(m.counts.revoke, 0); assert.equal(m.counts.register, 2);
  m.flags.previousRevocationFailureAt = 0; delete m.hooks.beforePreviousRevocation;
  const restarted = new Auth(m.base, m.store, m.secrets, m.browser); await reconnect(restarted);
  assert.equal((await m.read())!.status, 'active'); assert.equal((await m.read())!.subject, previous.subject);
  const prompts = m.requests.filter(r => r.path.startsWith('/authorize')).map(r => new URL(r.path, m.origin).searchParams.get('prompt'));
  assert.deepEqual(prompts, [null, null, 'login', 'login']);
  assert.ok(m.revokedFamilies.has(previous.connectionId!)); assert.ok(m.revokedFamilies.has(second.connectionId!));
});

for (const retainId of [true, false]) {
  test(`retired signing key recovery uses ${retainId ? 'stored' : 'derived'} connection ID without sending the old JWT`, async t => {
    const { m, previous } = await expiredGrant(); t.after(() => m.close());
    if (!retainId) await m.store.withLock(async tx => { const root = (await tx.load())!; delete root.connectionId; await tx.save(root); });
    await m.retireSigningKey(); assert.equal(await m.currentKeyVerifies(previous.accessToken!), false);
    const start = m.requests.length;
    await reconnect(m.auth);
    const current = (await m.read())!;
    assert.equal(current.status, 'active'); assert.equal(current.subject, previous.subject);
    const request = m.requests.slice(start).find(r => r.path.endsWith('/revoke-previous'))!;
    assert.deepEqual(request.body, { connectionId: previous.connectionId });
    assert.ok(!JSON.stringify(m.requests.slice(start)).includes(previous.accessToken!));
    assert.ok(m.revokedFamilies.has(previous.connectionId!));
  });
}

test('a stored connection ID remains usable when historical JWT bytes cannot be decoded', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close());
  await m.store.withLock(async tx => { const root = (await tx.load())!; root.accessToken = 'private-historical-token'; await tx.save(root); });
  await m.retireSigningKey(); const start = m.requests.length; await reconnect(m.auth);
  assert.equal((await m.read())!.status, 'active'); assert.ok(m.revokedFamilies.has(previous.connectionId!));
  assert.ok(!JSON.stringify(m.requests.slice(start)).includes('private-historical-token'));
});

test('decoded old claims never supply owner authority when deriving a missing connection ID', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close());
  const segments = previous.accessToken!.split('.');
  const claims = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString()); claims.sub = 'untrusted-owner';
  const changed = `${segments[0]}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${segments[2]}`;
  await m.store.withLock(async tx => { const root = (await tx.load())!; delete root.connectionId; root.accessToken = changed; await tx.save(root); });
  await m.retireSigningKey(); await reconnect(m.auth);
  assert.equal((await m.read())!.subject, previous.subject); assert.ok(m.revokedFamilies.has(previous.connectionId!));
  assert.ok(!m.requests.some(r => r.token === `Bearer ${changed}` || JSON.stringify(r.body).includes(changed)));
});

test('wrong-account login with a retired old signing key makes no old-connection API request', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close());
  await m.retireSigningKey(); m.flags.subject = 'other-account'; await reconnect(m.auth);
  assert.equal((await m.read())!.subject, previous.subject); assert.equal((await m.read())!.connectionId, previous.connectionId);
  assert.equal(m.counts.revokePrevious, 0); assert.equal(m.counts.register, 1);
  assert.ok(!m.revokedFamilies.has(previous.connectionId!));
});

test('stored connection IDs are sent and confirmed as lowercase hex', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close());
  await m.store.withLock(async tx => { const root = (await tx.load())!; root.connectionId = root.connectionId!.toUpperCase(); await tx.save(root); });
  await reconnect(m.auth);
  assert.equal((await m.read())!.status, 'active');
  const request = m.requests.find(r => r.path.endsWith('/revoke-previous'))!;
  assert.deepEqual(request.body, { connectionId: previous.connectionId });
});

test('a revoked fresh family is retained for provider cleanup and replaced without a refresh loop', async t => {
  const { m, previous } = await expiredGrant(); t.after(() => m.close());
  m.hooks.beforePreviousRevocation = async () => {
    if (m.counts.revokePrevious === 1) m.revokedFamilies.add(m.connectionIdFor(m.requests.at(-1)!.token!.slice('Bearer '.length)));
  };
  await reconnect(m.auth);
  const pending = (await m.read())!;
  assert.equal(pending.subject, previous.subject); assert.equal(pending.recovery, undefined);
  assert.equal(pending.pendingGrants!.length, 1); assert.equal(pending.pendingGrants![0]!.cleanup?.backend, false);
  assert.equal(pending.pendingGrants![0]!.cleanup?.provider, true); assert.equal(m.counts.register, 1);
  assert.ok(!m.revokedFamilies.has(previous.connectionId!));
  const rejectedRefresh = pending.pendingGrants![0]!.refreshToken;
  delete m.hooks.beforePreviousRevocation;
  const restarted = new Auth(m.base, m.store, m.secrets, m.browser); await reconnect(restarted);
  assert.equal((await m.read())!.status, 'active'); assert.equal((await m.read())!.subject, previous.subject);
  assert.equal(m.counts.exchange, 3); assert.equal(m.counts.revoke, 2);
  assert.ok(!m.requests.some(r => r.path === '/token' && (r.body as any).grant_type === 'refresh_token' && (r.body as any).refresh_token === rejectedRefresh));
});
