import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiError } from '../src/api-errors.js';
import { apiRequest } from '../src/api.js';
import { callRemoteTool } from '../src/remote.js';
import { Auth } from '../src/auth.js';
import { CredentialStore } from '../src/store.js';
import { SafeError, safeError, Secrets } from '../src/errors.js';
import { LearningTools } from '../src/tools.js';
import { mock } from './helpers.js';

test('structured RATE_LIMITED accepts only integer seconds from 1 through 86400', () => {
  for (const pause of [1, 12, 86_400]) {
    assert.equal(apiError(0, 'RATE_LIMITED', undefined, pause).retryAfterSeconds, pause);
  }
  for (const pause of [undefined, null, '45', '', true, [], {}, NaN, Infinity, -Infinity, -1, 0, 1.5, 86_401, Number.MAX_SAFE_INTEGER]) {
    assert.equal(apiError(0, 'RATE_LIMITED', undefined, pause).retryAfterSeconds, 30);
  }
});

test('only throttle bodies extend trusted overload pauses and HTTP401 always wins', () => {
  for (const status of [429, 503]) {
    for (const [header, body, expected] of [[90, 45, 90], [45, 90, 90], [12, 1, 12], [86_400, 12, 86_400]] as const) {
      assert.equal(apiError(status, 'RATE_LIMITED', header, body).retryAfterSeconds, expected);
    }
    for (const pause of [NaN, Infinity, -1, 0, 1.5, 86_401]) {
      assert.equal(apiError(status, 'RATE_LIMITED', pause).retryAfterSeconds, 30);
    }
    const credit = apiError(status, 'NOT_ENOUGH_CREDIT', 45, 90);
    assert.equal(credit.code, 'NOT_ENOUGH_CREDIT');
    assert.equal(credit.retryAfterSeconds, 45);
    assert.match(credit.message, /Insufficient credits.*top up credits/);
  }
  assert.equal(apiError(0, 'NOT_ENOUGH_CREDIT', undefined, 90).retryAfterSeconds, undefined);
  assert.equal(apiError(400, 'INVALID_REQUEST', 45, 90).retryAfterSeconds, undefined);
  assert.equal(apiError(200, 'RATE_LIMITED', 90, 12).retryAfterSeconds, 12);
  const auth = apiError(401, 'RATE_LIMITED', 45, 90);
  assert.equal(auth.code, 'AUTH_REQUIRED');
  assert.equal(auth.retryAfterSeconds, undefined);
});

for (const encoding of ['structured', 'text', 'rpc-data']) {
  test(`MCP ${encoding} throttle persists its pause under the shared lock without replay or sign-in`, async t => {
    const m = await mock(); t.after(() => m.close()); await m.login();
    const tools = new LearningTools();
    const envelope = { error: { code: 'RATE_LIMITED', message: `unsafe ${m.issued.join(' ')}`, retryAfterSeconds: 90 } };
    if (encoding === 'rpc-data') m.rpc.error = { code: -32000, message: 'unsafe', data: envelope };
    else m.rpc.result = { isError: true, ...(encoding === 'structured' ? { structuredContent: envelope } : {}),
      content: [{ type: 'text', text: JSON.stringify(envelope) }] };
    const input = { phrase: 'look up', idempotencyKey: 'original-operation', approval: { method: 'credits', creditAmount: 1 } };
    const started = Date.now();
    await assert.rejects(tools.call(m.auth, 'encbird_add_expression', input), error => {
      const safe = safeError(error).error;
      assert.equal(safe.code, 'RATE_LIMITED'); assert.equal(safe.retryAfterSeconds, 90);
      assert.match(safe.message, /wait.*explicit retry/);
      assert.doesNotMatch(JSON.stringify(safe), /unsafe|Bearer/);
      assert.ok(m.issued.every(token => !JSON.stringify(safe).includes(token)));
      return true;
    });
    const value = (await m.read())!;
    assert.equal(value.status, 'active'); assert.ok(value.expiresAt > Date.now());
    assert.ok(value.traffic!.blockedUntil >= started + 90_000);
    const calls = m.requests.length;
    const secrets = new Secrets();
    const restarted = new Auth(m.base, new CredentialStore(m.base, 'mock-host', secrets, m.directory), secrets, m.browser);
    await m.store.withLock(async tx => { const credentials = (await tx.load())!; credentials.expiresAt = 0; await tx.save(credentials); });
    await Promise.all([m.auth, restarted].map(auth => assert.rejects(tools.call(auth, 'encbird_add_expression', input), error => {
      assert.ok(error instanceof SafeError); assert.equal(error.code, 'REQUEST_THROTTLED');
      assert.ok(error.retryAfterSeconds! >= 85 && error.retryAfterSeconds! <= 91); return true;
    })));
    assert.equal(m.requests.length, calls);
    assert.equal(m.counts.refresh, 0); assert.equal(m.counts.exchange, 1);
    assert.equal(m.counts.disconnect, 0); assert.equal(m.counts.revoke, 0);
    assert.deepEqual(m.rpcCalls().map(r => (r.body as any).params.arguments), [input]);
    assert.ok(!m.requests.some(r => r.path.endsWith('/expressions')));
  });
}

test('REST and remote HTTP throttles keep the longer header or structured pause without automatic retries', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const token = (await m.read())!.accessToken!;
  for (const status of [429, 503]) {
    m.flags.apiStatus = status;
    for (const [header, body, expected] of [['45', 90, 90], ['90', 45, 90], ['12', 1, 12], ['45', '90', 45], ['45', 86_401, 45]] as const) {
      m.flags.apiRetryAfter = header;
      m.flags.apiBody = { error: { code: 'RATE_LIMITED', message: 'unsafe', retryAfterSeconds: body } };
      const before = m.requests.length;
      await assert.rejects(apiRequest(m.base, token, 'POST', '/expressions', { idempotencyKey: 'original' }),
        { code: 'RATE_LIMITED', retryAfterSeconds: expected });
      await assert.rejects(callRemoteTool(m.base, async () => token, 'encbird_add_expression', { idempotencyKey: 'original' }),
        { code: 'RATE_LIMITED', retryAfterSeconds: expected });
      assert.equal(m.requests.slice(before).filter(r => r.path.endsWith('/expressions')).length, 1);
      assert.equal(m.requests.slice(before).filter(r => (r.body as any).method === 'tools/call').length, 1);
    }
  }
});

test('native MCP throttle rejects malformed pause values and keeps safe fallback metadata', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const token = (await m.read())!.accessToken!;
  for (const pause of [undefined, '90', null, -1, 0, 1.5, 86_401, 1e100]) {
    m.flags.apiBody = { error: { code: 'RATE_LIMITED', message: 'unsafe', retryAfterSeconds: pause } };
    await assert.rejects(callRemoteTool(m.base, async () => token, 'encbird_get_context', {}),
      { code: 'RATE_LIMITED', retryAfterSeconds: 30 });
  }
  for (const pause of [1, 86_400]) {
    m.flags.apiBody = { error: { code: 'RATE_LIMITED', message: 'unsafe', retryAfterSeconds: pause } };
    await assert.rejects(callRemoteTool(m.base, async () => token, 'encbird_get_context', {}),
      { code: 'RATE_LIMITED', retryAfterSeconds: pause });
  }
});

test('RATE_LIMITED body cannot turn HTTP401 into a cooldown or bypass explicit authentication recovery', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  m.flags.apiStatus = 401; m.flags.apiRetryAfter = '90';
  m.flags.apiBody = { error: { code: 'RATE_LIMITED', message: 'unsafe', retryAfterSeconds: 90 } };
  const token = (await m.read())!.accessToken!;
  for (const call of [() => apiRequest(m.base, token, 'GET', '/context'),
    () => new LearningTools().call(m.auth, 'encbird_get_context')]) {
    await assert.rejects(call(), error => {
      assert.equal(safeError(error).error.code, 'AUTH_REQUIRED');
      assert.equal(safeError(error).error.retryAfterSeconds, undefined); return true;
    });
  }
  assert.equal((await m.read())!.traffic!.blockedUntil, 0);
  assert.equal((await m.read())!.expiresAt, 0);
  assert.equal(m.counts.refresh, 0); assert.equal(m.rpcCalls().length, 1);
});

test('MCP credit rejection ignores a stray structured pause and keeps top-up guidance', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  m.flags.apiBody = { error: { code: 'NOT_ENOUGH_CREDIT', message: 'unsafe', retryAfterSeconds: 90 } };
  await assert.rejects(new LearningTools().call(m.auth, 'encbird_add_expression', { phrase: 'look up', idempotencyKey: 'original' }), error => {
    const safe = safeError(error).error;
    assert.equal(safe.code, 'NOT_ENOUGH_CREDIT'); assert.equal(safe.retryAfterSeconds, undefined);
    assert.match(safe.message, /Insufficient credits.*top up credits/); return true;
  });
  assert.equal((await m.read())!.traffic!.blockedUntil, 0);
  assert.equal(m.counts.refresh, 0); assert.equal(m.rpcCalls().length, 1);
});

test('malformed HTTP pauses and error codes cannot create unbounded or invalid pauses', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const token = (await m.read())!.accessToken!;
  for (const status of [429, 503]) {
    m.flags.apiStatus = status;
    for (const header of ['-1', 'NaN', 'Infinity', '1.5', '86401', '999999999999999999999999', 'Fri, 01 Jan 2100 00:00:00 GMT']) {
      m.flags.apiRetryAfter = header;
      m.flags.apiBody = { error: { code: 'RATE_LIMITED', retryAfterSeconds: '45' } };
      for (const call of [() => apiRequest(m.base, token, 'GET', '/context'),
        () => callRemoteTool(m.base, async () => token, 'encbird_get_context', {})]) {
        await assert.rejects(call(), { code: 'RATE_LIMITED', retryAfterSeconds: 30 });
      }
    }
    m.flags.apiRetryAfter = '45';
    for (const code of [null, {}, ['RATE_LIMITED'], 'rate_limited', 'RATE_LIMITED\n']) {
      m.flags.apiBody = { error: { code, retryAfterSeconds: 90 } };
      for (const call of [() => apiRequest(m.base, token, 'GET', '/context'),
        () => callRemoteTool(m.base, async () => token, 'encbird_get_context', {})]) {
        await assert.rejects(call(), { code: status === 429 ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE', retryAfterSeconds: 45 });
      }
    }
  }
});

test('delayed invalid throttle metadata persists a finite fallback before another caller gets the lock', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const originalFetch = globalThis.fetch;
  let received!: () => void;
  let release!: () => void;
  const receiving = new Promise<void>(resolve => { received = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (typeof init?.body !== 'string' || !init.body.includes('"tools/call"')) return response;
    await response.body?.cancel();
    received();
    return new Response(new ReadableStream({ async start(controller) {
      await gate;
      controller.enqueue(new TextEncoder().encode('{"error":{"code":"RATE_LIMITED","retryAfterSeconds":1e309}}'));
      controller.close();
    } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '86401' } });
  });
  const tools = new LearningTools();
  const input = { phrase: 'look up', idempotencyKey: 'unchanged-operation' };
  const first = assert.rejects(tools.call(m.auth, 'encbird_add_expression', input), { code: 'RATE_LIMITED', retryAfterSeconds: 30 });
  await receiving;
  const calls = m.requests.length;
  const secondAuth = new Auth(m.base, new CredentialStore(m.base, 'mock-host', m.secrets, m.directory), m.secrets, m.browser);
  const second = assert.rejects(tools.call(secondAuth, 'encbird_add_expression', input), { code: 'REQUEST_THROTTLED' });
  const releasedAt = Date.now(); release();
  await Promise.all([first, second]);
  const value = (await m.read())!;
  assert.ok(Number.isSafeInteger(value.traffic!.blockedUntil));
  assert.ok(value.traffic!.blockedUntil >= releasedAt + 30_000);
  assert.ok(value.traffic!.blockedUntil <= Date.now() + 31_000);
  assert.equal(value.status, 'active'); assert.ok(value.expiresAt > Date.now());
  assert.equal(m.requests.length, calls); assert.equal(m.rpcCalls().length, 1);
  assert.equal(m.counts.refresh, 0); assert.equal(m.counts.exchange, 1);
  assert.deepEqual((m.rpcCalls()[0]!.body as any).params.arguments, input);
});
