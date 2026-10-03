import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Auth } from '../src/auth.js';
import { callback, proof } from '../src/oauth.js';
import { mock } from './helpers.js';

test('browser PKCE login verifies identity and registers bearer family without user authority', async t => {
  const m = await mock(); t.after(() => m.close());
  const { started, result } = await m.login();
  assert.equal((started.data as any).status, 'authentication_pending');
  assert.equal((result.data as any).status, 'connected');
  assert.equal(m.counts.register, 1);
  assert.equal((await m.read())?.subject, 'test-user');
  assert.deepEqual(m.requests.find(r => r.path.endsWith('/connections'))?.body, {});
  assert.match(m.requests.find(r => r.path.endsWith('/connections'))!.token!, /^Bearer AT-/);
  const resultText = JSON.stringify(result);
  for (const token of m.issued) assert.ok(!resultText.includes(token));
});

for (const [flag, errorCode] of Object.entries({ badState: 'OAUTH_STATE_MISMATCH', badNonce: 'INVALID_ID_TOKEN', badSignature: 'INVALID_ID_TOKEN',
  badIssuer: 'INVALID_ID_TOKEN', badAudience: 'INVALID_ID_TOKEN', expiredId: 'INVALID_ID_TOKEN', badDiscovery: 'INVALID_ID_TOKEN', badPkce: 'OAUTH_INVALID_GRANT',
  configRedirect: 'NETWORK_ERROR', malformedToken: 'INVALID_TOKEN_RESPONSE', missingRefresh: 'REFRESH_TOKEN_REQUIRED' })) {
  test(`reject ${flag} without registering a learning connection`, async t => {
    const m = await mock(); t.after(() => m.close()); (m.flags as any)[flag] = true;
    const first = await m.auth.connect(); await m.auth.waitForIdle();
    const result = 'error' in first ? first : await m.auth.connect();
    assert.equal((result.error as any)?.code, errorCode);
    assert.equal(m.counts.register, 0);
    assert.equal(await m.read(), undefined);
    if (['badNonce', 'badSignature', 'badIssuer', 'badAudience', 'jwksRedirect', 'malformedToken'].includes(flag)) assert.equal(m.counts.revoke, 1);
    if (flag === 'badDiscovery') assert.equal(m.counts.exchange, 0);
  });
}

test('invalid nonce plus failed provider revocation preserves disabled cleanup credentials', async t => {
  const m = await mock(); t.after(() => m.close()); m.flags.badNonce = true; m.flags.providerFailure = true;
  await m.auth.connect(); await m.auth.waitForIdle();
  const stored = await m.read(); assert.equal(stored?.status, 'disabled'); assert.equal(stored?.recovery?.grant.cleanup?.provider, true);
  await assert.rejects(m.auth.request('GET', '/context'), { code: 'AUTH_REQUIRED' });
  m.flags.providerFailure = false;
  assert.equal((await m.auth.disconnect()).data.status, 'disconnected'); assert.equal(await m.read(), undefined);
});

test('port contention leaves the existing listener alone and does not open a browser', async t => {
  const blocker = createServer(); await new Promise<void>(resolve => blocker.listen(18765, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => blocker.close(() => resolve())));
  const m = await mock(); t.after(() => m.close());
  const result = await m.auth.connect(); await m.auth.waitForIdle();
  assert.equal((result.error as any)?.code, 'CALLBACK_PORT_BUSY');
  assert.equal(m.requests.filter(r => r.path.startsWith('/authorize')).length, 0); assert.ok(blocker.listening);
});

test('callback ignores wrong Host and rejects duplicate state parameters', async () => {
  const p = proof(); const ac = new AbortController(); const listener = await callback(p.state, ac.signal, 1000);
  const wrongHost = await fetch(`http://127.0.0.1:18765/oauth/callback?code=x&state=${p.state}`); assert.equal(wrongHost.status, 400);
  await fetch(`http://localhost:18765/oauth/callback?code=x&state=${p.state}&state=${p.state}`);
  await assert.rejects(listener.result, { code: 'OAUTH_STATE_MISMATCH' });
});

test('callback timeout is retryable and cancellation frees its port', async () => {
  const ac = new AbortController(); const listener = await callback(proof().state, ac.signal, 20);
  await assert.rejects(listener.result, { code: 'AUTH_TIMEOUT' });
  const next = await callback(proof().state, ac.signal, 1000); ac.abort();
  await assert.rejects(next.result, { code: 'AUTH_CANCELLED' });
});

test('refresh rotation is saved and serializes concurrent requests from separate Auth instances', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const original = (await m.read())!.refreshToken;
  await m.store.withLock(async tx => { const value = (await tx.load())!; value.expiresAt = 0; await tx.save(value); });
  const other = new Auth(m.base, m.store, m.secrets, m.browser);
  await Promise.all([m.auth.request('GET', '/context'), other.request('GET', '/context')]);
  assert.equal(m.counts.refresh, 1); assert.notEqual((await m.read())!.refreshToken, original);
  assert.ok(!m.refreshTokens.has(original!)); assert.equal((await m.read())!.status, 'active');
});

test('nonrotating refresh retains its refresh token; failed refresh disables learning access', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); m.flags.rotation = false;
  const old = (await m.read())!.refreshToken;
  await m.store.withLock(async tx => { const value = (await tx.load())!; value.expiresAt = 0; await tx.save(value); });
  await m.auth.request('GET', '/context'); assert.equal((await m.read())!.refreshToken, old);
  m.flags.refreshFailure = true;
  await m.store.withLock(async tx => { const value = (await tx.load())!; value.expiresAt = 0; await tx.save(value); });
  await assert.rejects(m.auth.request('GET', '/context'), { code: 'OAUTH_INVALID_GRANT' });
  assert.equal((await m.read())!.status, 'disabled');
});

test('disconnect disables credentials, preserves failed provider cleanup across restart, then removes secrets', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); m.flags.providerFailure = true;
  const result = await m.auth.disconnect(); assert.equal(result.data.status, 'cleanup_pending');
  assert.equal(m.counts.disconnect, 1); assert.equal((await m.read())?.status, 'disabled');
  assert.equal((await m.read())?.accessToken, undefined);
  await assert.rejects(m.auth.request('GET', '/context'), { code: 'AUTH_REQUIRED' });
  const restarted = new Auth(m.base, m.store, m.secrets, m.browser);
  assert.equal(((await restarted.connect()).error as any).code, 'CLEANUP_REQUIRED'); await restarted.waitForIdle();
  m.flags.providerFailure = false;
  assert.equal((await restarted.disconnect()).data.status, 'disconnected');
  assert.equal(m.counts.disconnect, 1); assert.equal(m.counts.revoke, 2); assert.equal(await m.read(), undefined);
});

test('backend revocation failure preserves refresh capability and retries before provider revocation', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); m.flags.backendFailure = true;
  assert.equal((await m.auth.disconnect()).data.status, 'cleanup_pending'); assert.equal(m.counts.revoke, 0);
  assert.ok((await m.read())?.refreshToken);
  await m.store.withLock(async tx => { const value = (await tx.load())!; value.expiresAt = 0; await tx.save(value); });
  m.flags.backendFailure = false;
  assert.equal((await m.auth.disconnect()).data.status, 'disconnected'); assert.equal(m.counts.revoke, 1);
});

test('ambiguous registration retains the candidate for idempotent resume; mismatched identity is discarded', async t => {
  const m = await mock(); t.after(() => m.close()); m.flags.registrationFailure = true;
  await m.auth.connect(); await m.auth.waitForIdle();
  assert.equal(m.counts.register, 1); assert.equal(m.counts.revoke, 0);
  assert.equal((await m.read())?.recovery?.grant.cleanup?.backend, true);
  await m.auth.connect(); await m.auth.waitForIdle();
  m.flags.registrationFailure = false;
  const resumed = await m.auth.connect(); await m.auth.waitForIdle();
  assert.equal((resumed.data as any).status, 'connected');
  await m.auth.disconnect();
  m.flags.wrongUser = true;
  await m.auth.connect(); await m.auth.waitForIdle();
  assert.equal(await m.read(), undefined);
});
