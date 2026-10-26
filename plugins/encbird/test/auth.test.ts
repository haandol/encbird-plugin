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

test('connect polling shares the pending task and disconnect clears cancellation before a fresh sign-in', async t => {
  const m = await mock(); m.flags.noCallback = true;
  const auth: Auth = new Auth(m.base, m.store, m.secrets, async function(this: Auth, url: string) {
    assert.equal(this, auth); await m.browser(url);
  });
  t.after(async () => { await auth.cancel(); await m.close(); });
  const pending = await auth.connect();
  assert.equal((pending.data as any).status, 'authentication_pending');
  const requests = m.requests.length;
  for (const result of await Promise.all([auth.connect(), auth.connect(), auth.connect()])) {
    assert.deepEqual(result, pending);
  }
  assert.equal(m.requests.length, requests); assert.equal(m.counts.exchange, 0);
  assert.equal((await auth.disconnect()).data.status, 'disconnected');
  assert.equal(await m.read(), undefined);
  m.flags.noCallback = false;
  const started = await auth.connect(); await auth.waitForIdle(); const result = await auth.connect();
  assert.deepEqual(started, pending); assert.equal((result.data as any).status, 'connected');
  assert.equal(m.counts.exchange, 1); assert.equal(m.counts.register, 1);
});

test('a completed sign-in failure is surfaced once without another attempt before explicit reconnect', async t => {
  const m = await mock(); t.after(() => m.close()); m.flags.badNonce = true;
  await m.auth.connect(); await m.auth.waitForIdle();
  const requests = m.requests.length; const counts = { ...m.counts };
  const failure = await m.auth.connect();
  assert.equal((failure.error as any).code, 'INVALID_ID_TOKEN');
  assert.equal(m.requests.length, requests); assert.deepEqual(m.counts, counts);
  assert.equal(await m.read(), undefined);
  m.flags.badNonce = false;
  const { started, result } = await m.login();
  assert.equal((started.data as any).status, 'authentication_pending');
  assert.equal((result.data as any).status, 'connected');
  assert.equal(m.counts.exchange, counts.exchange + 1); assert.equal(m.counts.register, 1);
});

for (const [flag, errorCode] of Object.entries({ badState: 'OAUTH_STATE_MISMATCH', badNonce: 'INVALID_ID_TOKEN', badSignature: 'INVALID_ID_TOKEN',
  badIssuer: 'INVALID_ID_TOKEN', badAudience: 'INVALID_ID_TOKEN', expiredId: 'INVALID_ID_TOKEN', badDiscovery: 'INVALID_ID_TOKEN', badPkce: 'OAUTH_INVALID_GRANT',
  configRedirect: 'NETWORK_ERROR', malformedToken: 'INVALID_TOKEN_RESPONSE', missingRefresh: 'REFRESH_TOKEN_REQUIRED' })) {
  test(`reject ${flag} without registering a learning connection`, async t => {
    const m = await mock(); t.after(() => m.close()); (m.flags as any)[flag] = true;
    const first = await m.auth.connect(); await m.auth.waitForIdle();
    const result = 'error' in first ? first : await m.auth.connect();
    assert.equal((result.error as any)?.code, errorCode);
    assert.doesNotMatch(JSON.stringify(result), /provider-secret|copy all tokens|bypass sign-in and retry/);
    for (const token of m.issued) assert.ok(!JSON.stringify(result).includes(token));
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

test('verification recovery guidance resumes the saved flow, while invalid identity requires cleanup', async t => {
  const m = await mock(); t.after(() => m.close()); m.hooks.afterToken = () => { m.flags.verificationFailure = true; };
  await m.auth.connect(); await m.auth.waitForIdle();
  const error = (await m.auth.connect()).error as { code: string; message: string };
  assert.equal(error.code, 'OAUTH_VERIFICATION_UNAVAILABLE'); assert.match(error.message, /encbird_connect to resume the saved verification flow/);
  assert.equal(m.counts.exchange, 1); assert.equal(m.counts.register, 0); assert.ok((await m.read())?.recovery);
  m.flags.verificationFailure = false; m.hooks.afterToken = undefined;
  await m.auth.connect(); await m.auth.waitForIdle(); assert.equal(m.counts.exchange, 1); assert.equal(m.counts.register, 1);
  m.flags.providerFailure = true;
  const pending = await m.auth.disconnect();
  assert.equal(pending.data.status, 'cleanup_pending'); assert.match((pending.data as any).message, /revocation was not confirmed.*encbird_disconnect/);
  assert.equal((await m.read())?.status, 'disabled');
  m.flags.providerFailure = false; assert.equal((await m.auth.disconnect()).data.status, 'disconnected');
});

test('wrong-account and unknown-owner recovery retain cleanup records and describe their different next actions', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  await m.store.withLock(async tx => { const v = (await tx.load())!; v.status = 'disabled'; v.cleanup = { backend: true, provider: true }; v.refreshInvalid = true; await tx.save(v); });
  m.flags.subject = 'wrong-account';
  await m.auth.connect(); await m.auth.waitForIdle();
  const mismatch = (await m.auth.connect()).error as { code: string; message: string };
  assert.equal(mismatch.code, 'ACCOUNT_MISMATCH'); assert.match(mismatch.message, /different account.*encbird_disconnect.*same-account/);
  assert.equal((await m.read())?.subject, 'test-user'); assert.equal(m.counts.register, 1);
  await m.store.withLock(async tx => { const v = (await tx.load())!; delete v.subject; await tx.save(v); });
  const requests = m.requests.length;
  const unknown = await m.auth.connect(); await m.auth.waitForIdle();
  assert.equal((unknown.error as any).code, 'OWNER_UNKNOWN'); assert.match((unknown.error as any).message, /no verified owner.*operator.*before reconnecting/);
  assert.equal(m.requests.length, requests); assert.ok(await m.read());
});

test('cancelled and denied sign-in require learner intent rather than automatic restart', async t => {
  const m = await mock(); t.after(() => m.close()); m.flags.noCallback = true;
  await m.auth.connect(); await m.auth.cancel();
  const cancelled = (await m.auth.connect()).error as { code: string; message: string };
  assert.equal(cancelled.code, 'AUTH_CANCELLED'); assert.match(cancelled.message, /Do not restart without learner intent/);
  assert.equal(m.counts.exchange, 0); assert.equal(m.counts.register, 0);
  const listener = await callback('test-state', new AbortController().signal, 1000);
  await fetch('http://localhost:18765/oauth/callback?state=test-state&error=denied&error_description=provider-secret');
  await assert.rejects(listener.result, error => {
    assert.equal((error as any).code, 'AUTH_DENIED'); assert.match((error as Error).message, /Wait for the learner/);
    assert.doesNotMatch((error as Error).message, /provider-secret/); return true;
  });
});


test('operator-only cleanup failures are not followed by blanket same-account reconnect advice', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  await m.store.withLock(async tx => {
    const value = (await tx.load())!; value.status = 'disabled'; value.refreshInvalid = true;
    value.cleanup = { backend: true, provider: true }; value.connectionId = 'invalid-retained-id'; await tx.save(value);
  });
  await m.auth.connect(); await m.auth.waitForIdle();
  const failed = (await m.auth.connect()).error as { code: string; message: string };
  assert.equal(failed.code, 'INVALID_CONNECTION_ID'); assert.match(failed.message, /operator.*before reconnecting/);
  const pending = (await m.auth.disconnect()).data as Record<string, unknown>;
  assert.equal(pending.status, 'cleanup_pending'); assert.equal(pending.reauthenticationRequired, true);
  assert.match(String(pending.message), /stored previous connection ID is invalid.*operator/);
  assert.doesNotMatch(String(pending.message), /Run encbird_connect|Run encbird_disconnect|Cleanup needs fresh authorization/);
  const retained = (await m.read())!;
  assert.equal(retained.connectionId, 'invalid-retained-id'); assert.equal(retained.status, 'disabled');
  assert.equal(retained.cleanup?.backend, true); assert.ok(retained.recovery?.grant.refreshToken);
  assert.equal(m.counts.revokePrevious, 0); assert.equal(m.counts.revoke, 0); assert.equal(m.counts.register, 1);
});

test('changed OAuth client requires operator reconciliation without replacing pending credentials', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  await m.store.withLock(async tx => {
    const value = (await tx.load())!; value.status = 'disabled'; value.refreshInvalid = true;
    value.cleanup = { backend: true, provider: true }; await tx.save(value);
  });
  const previous = await m.read(); const before = m.requests.length;
  m.config.clientId = 'changed-client';
  const result = await m.auth.connect(); await m.auth.waitForIdle();
  assert.equal((result.error as any).code, 'OAUTH_CLIENT_CHANGED');
  assert.match((result.error as any).message, /operator.*reconcile old cleanup before reconnecting/);
  assert.deepEqual(await m.read(), previous);
  assert.deepEqual(m.requests.slice(before).map(r => r.path), ['/v1/mcp-learning/config']);
});

test('setup 401 retains unexpired recovery authorization and requires repair before resuming connect', async t => {
  const m = await mock(); t.after(() => m.close()); m.flags.connectionUnauthorized = '/connections';
  await m.auth.connect(); await m.auth.waitForIdle();
  const stored = (await m.read())!; const grant = stored.recovery!.grant;
  assert.equal(stored.recovery!.verified, true); assert.ok(grant.expiresAt > Date.now());
  assert.equal(grant.cleanup?.backend, true); assert.equal(m.counts.refresh, 0);
  const requests = m.requests.length;
  const error = (await m.auth.connect()).error as { code: string; message: string };
  assert.equal(error.code, 'AUTH_REQUIRED'); assert.match(error.message, /operator to repair.*before retrying/);
  assert.match(error.message, /After repair, use encbird_connect to resume retained setup or recovery/);
  assert.doesNotMatch(error.message, /lets the plugin refresh first|provider-secret|copy tokens/);
  assert.equal(m.requests.length, requests); assert.deepEqual(await m.read(), stored);
  m.flags.connectionUnauthorized = '';
  const resumed = await m.auth.connect(); await m.auth.waitForIdle();
  assert.equal((resumed.data as any).status, 'connected');
  assert.equal((await m.read())?.accessToken, grant.accessToken);
  assert.deepEqual(m.requests.slice(requests).map(r => r.path), ['/v1/mcp-learning/connections']);
  assert.equal(m.counts.exchange, 1); assert.equal(m.counts.refresh, 0);
});

test('cleanup 401 preserves unexpired credentials and guides repaired authorization to disconnect without refresh promises', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const original = (await m.read())!; const before = m.requests.length;
  m.flags.connectionUnauthorized = '/connection';
  const pending = (await m.auth.disconnect()).data as Record<string, unknown>;
  assert.equal(pending.status, 'cleanup_pending'); assert.equal(pending.reauthenticationRequired, false);
  assert.match(String(pending.message), /operator to repair.*before retrying/);
  assert.match(String(pending.message), /After repair.*encbird_disconnect to finish cleanup/);
  assert.doesNotMatch(String(pending.message), /lets the plugin refresh first|provider-secret|copy tokens/);
  const retained = (await m.read())!;
  assert.equal(retained.status, 'disabled'); assert.equal(retained.recovery, undefined);
  assert.equal(retained.expiresAt, original.expiresAt); assert.equal(retained.accessToken, original.accessToken);
  assert.equal(retained.refreshToken, original.refreshToken); assert.deepEqual(retained.cleanup, { backend: true, provider: true });
  assert.deepEqual(m.requests.slice(before).map(r => r.path), ['/v1/mcp-learning/connection']);
  assert.equal(m.counts.refresh, 0); assert.equal(m.counts.revoke, 0);
  m.flags.connectionUnauthorized = '';
  assert.equal((await m.auth.disconnect()).data.status, 'disconnected');
  assert.deepEqual(m.requests.slice(before + 1).map(r => r.path), ['/v1/mcp-learning/connection', '/revoke']);
  assert.equal(m.counts.refresh, 0); assert.equal(await m.read(), undefined);
});

test('previous-connection cleanup 401 retains both grants until repair and resumes recovery without a new login or refresh', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  await m.store.withLock(async tx => {
    const value = (await tx.load())!; value.status = 'disabled'; value.refreshInvalid = true;
    value.cleanup = { backend: true, provider: true }; await tx.save(value);
  });
  const previous = (await m.read())!; m.flags.connectionUnauthorized = '/connection/revoke-previous';
  await m.auth.connect(); await m.auth.waitForIdle();
  const error = (await m.auth.connect()).error as { code: string; message: string };
  assert.equal(error.code, 'AUTH_REQUIRED'); assert.match(error.message, /operator to repair.*before retrying/);
  assert.doesNotMatch(error.message, /lets the plugin refresh first|provider-secret/);
  const retained = (await m.read())!; const fresh = retained.recovery!.grant;
  assert.equal(retained.subject, previous.subject); assert.equal(retained.refreshToken, previous.refreshToken);
  assert.deepEqual(retained.cleanup, { backend: true, provider: true }); assert.equal(retained.recovery!.verified, true);
  assert.ok(fresh.expiresAt > Date.now()); assert.ok(fresh.refreshToken);
  assert.equal(m.counts.refresh, 0); assert.equal(m.counts.revoke, 0); assert.equal(m.counts.register, 1);
  const before = m.requests.length; m.flags.connectionUnauthorized = '';
  const resumed = await m.auth.connect(); await m.auth.waitForIdle();
  assert.equal((resumed.data as any).status, 'connected'); assert.equal((await m.read())?.accessToken, fresh.accessToken);
  assert.deepEqual(m.requests.slice(before).map(r => r.path), ['/v1/mcp-learning/connection/revoke-previous', '/revoke', '/v1/mcp-learning/connections']);
  assert.equal(m.counts.exchange, 2); assert.equal(m.counts.refresh, 0);
});

test('ordinary refresh verification outage disables learning with cleanup guidance and no saved recovery claim', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  await m.store.withLock(async tx => { const value = (await tx.load())!; value.expiresAt = 0; await tx.save(value); });
  const original = (await m.read())!; const before = m.requests.length; m.flags.verificationFailure = true;
  await assert.rejects(m.auth.request('POST', '/expressions', { phrase: 'take a break', idempotencyKey: 'retained-key' }), error => {
    assert.equal((error as any).code, 'OAUTH_VERIFICATION_UNAVAILABLE');
    assert.match((error as Error).message, /during connection refresh.*restored.*encbird_disconnect to finish retained cleanup/);
    assert.match((error as Error).message, /reauthenticationRequired.*encbird_connect for same-account/);
    assert.doesNotMatch((error as Error).message, /resume the saved verification flow/); return true;
  });
  const retained = (await m.read())!;
  assert.equal(retained.status, 'disabled'); assert.equal(retained.recovery, undefined);
  assert.equal(retained.accessToken, original.accessToken); assert.equal(retained.expiresAt, 0);
  assert.notEqual(retained.refreshToken, original.refreshToken); assert.ok(m.refreshTokens.has(retained.refreshToken!));
  assert.deepEqual(retained.cleanup, { backend: true, provider: true });
  assert.deepEqual(m.requests.slice(before).map(r => r.path), ['/token', '/issuer/.well-known/openid-configuration']);
  const blocked = await m.auth.connect(); await m.auth.waitForIdle();
  assert.equal((blocked.error as any).code, 'CLEANUP_REQUIRED'); assert.equal(m.counts.exchange, 1); assert.equal(m.counts.refresh, 1);
  m.flags.verificationFailure = false;
  assert.equal((await m.auth.disconnect()).data.status, 'disconnected');
  assert.equal(m.counts.refresh, 2); assert.equal(m.counts.revoke, 1); assert.equal(await m.read(), undefined);
  assert.ok(!m.requests.some(r => r.path.endsWith('/expressions')));
});
