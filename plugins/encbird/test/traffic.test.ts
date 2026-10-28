import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { reserveRequest, retryAfterSeconds } from '../src/traffic.js';
import { apiRequest } from '../src/api.js';
import { requestJson } from '../src/http.js';
import { Auth } from '../src/auth.js';
import { CredentialStore, type Transaction } from '../src/store.js';
import { Secrets, safeError } from '../src/errors.js';
import { mock } from './helpers.js';
import { LearningTools } from '../src/tools.js';

function outboundTimes(t: TestContext, endpoint: string) {
  const times: number[] = [];
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    if ((input instanceof Request ? input.url : String(input)) === endpoint) times.push(performance.now());
    return originalFetch(input, init);
  });
  return times;
}

function assertSpaced(times: number[], count: number) {
  assert.equal(times.length, count);
  for (let i = 1; i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!;
    assert.ok(gap >= 220, `Outbound request interval was ${gap.toFixed(1)} ms`);
  }
}

function delayFirstTrafficSave(t: TestContext, stores: CredentialStore[]) {
  let injections = 0;
  for (const store of stores) {
    const withLock = store.withLock.bind(store);
    t.mock.method(store, 'withLock', <T>(action: (tx: Transaction) => Promise<T>) => withLock(tx => action({
      load: tx.load,
      async save(value) {
        await tx.save(value);
        if (!injections && value?.traffic?.recent.length === 1) {
          injections++; await delay(350);
        }
      },
    })));
  }
  return () => injections;
}

test('Retry-After accepts seconds and HTTP dates, with a safe fallback', () => {
  const now = Date.parse('2026-10-03T00:00:00Z');
  assert.equal(retryAfterSeconds('120', now), 120);
  assert.equal(retryAfterSeconds('Sat, 03 Oct 2026 00:02:00 GMT', now), 120);
  assert.equal(retryAfterSeconds('0', now), 1);
  for (const value of [null, '', 'invalid', '-1', 'Infinity', '999999999999999999999999']) assert.equal(retryAfterSeconds(value, now), 30);
});

test('rolling request budget rejects bursts without resetting at a minute boundary', async () => {
  const now = Date.now();
  const full = { recent: Array.from({ length: 60 }, () => now - 1000), nextRequestAt: 0, blockedUntil: 0 };
  await assert.rejects(reserveRequest(full), error => {
    assert.equal(safeError(error).error.code, 'REQUEST_THROTTLED');
    assert.ok(safeError(error).error.retryAfterSeconds! >= 58); return true;
  });
  const expired = { recent: Array.from({ length: 60 }, () => now - 60_001), nextRequestAt: 0, blockedUntil: 0 };
  assert.equal((await reserveRequest(expired)).recent.length, 1);
});

test('different Auth instances share request spacing through the credential lock', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const second = new Auth(m.base, new CredentialStore(m.base, 'mock-host', m.secrets, m.directory), m.secrets, m.browser);
  const times = outboundTimes(t, `${m.base}/context`);
  await Promise.all([m.auth.request('GET', '/context'), second.request('GET', '/context')]);
  assertSpaced(times, 2);
  assert.equal(m.requests.filter(r => r.path.endsWith('/context')).length, 2);
  assert.equal((await m.read())!.traffic!.recent.length, 2);
});

for (const status of [200, 500]) {
  test(`slow credential saves preserve concurrent request spacing after HTTP ${status}`, async t => {
    const m = await mock(); t.after(() => m.close()); await m.login();
    const secondStore = new CredentialStore(m.base, 'mock-host', m.secrets, m.directory);
    const second = new Auth(m.base, secondStore, m.secrets, m.browser);
    const injected = delayFirstTrafficSave(t, [m.store, secondStore]);
    const times = outboundTimes(t, `${m.base}/context`);
    m.flags.apiStatus = status;
    const results = await Promise.allSettled([m.auth.request('GET', '/context'), second.request('GET', '/context')]);
    assert.equal(injected(), 1);
    assertSpaced(times, 2);
    for (const result of results) {
      assert.equal(result.status, status === 200 ? 'fulfilled' : 'rejected');
      if (result.status === 'rejected') assert.equal(safeError(result.reason).error.code, 'API_ERROR');
    }
    assert.equal(m.requests.filter(r => r.path.endsWith('/context')).length, 2);
    assert.equal((await m.read())!.traffic!.recent.length, 2);
  });
}

for (const status of [429, 503]) {
  test(`${status} preserves a cooldown across runtime recreation without replaying writes`, async t => {
    const m = await mock(); t.after(() => m.close()); await m.login();
    m.flags.apiStatus = status; m.flags.apiRetryAfter = '90';
    const payload = { phrase: 'hello', idempotencyKey: 'same-request' };
    await assert.rejects(m.auth.request('POST', '/expressions', payload), error => {
      assert.equal(safeError(error).error.retryAfterSeconds, 90); return true;
    });
    const calls = m.requests.length;
    m.flags.apiStatus = 200;
    await m.store.withLock(async tx => { const value = (await tx.load())!; value.expiresAt = 0; await tx.save(value); });
    const secrets = new Secrets();
    const restarted = new Auth(m.base, new CredentialStore(m.base, 'mock-host', secrets, m.directory), secrets, m.browser);
    await assert.rejects(restarted.request('POST', '/expressions', payload), { code: 'REQUEST_THROTTLED' });
    assert.equal(m.requests.length, calls);
    assert.equal(m.counts.refresh, 0);
    assert.equal((await m.read())!.status, 'active');
    assert.deepEqual(m.requests.filter(r => r.path.endsWith('/expressions')).map(r => r.body), [payload]);
  });
}

test('non-JSON overloaded responses retain Retry-After and never expose server text', async t => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++; res.writeHead(429, { 'retry-after': '12', 'content-type': 'text/html' }).end('private diagnostic');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  await assert.rejects(apiRequest(`http://127.0.0.1:${address.port}`, 'test', 'GET', '/context'), error => {
    const result = safeError(error);
    assert.equal(result.error.code, 'RATE_LIMITED'); assert.equal(result.error.retryAfterSeconds, 12);
    assert.ok(!JSON.stringify(result).includes('private diagnostic')); return true;
  });
  assert.equal(calls, 1);
});

test('overload preserves public error codes while withholding diagnostic text', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  m.flags.apiStatus = 503;
  m.flags.apiBody = { error: { code: 'LEARNING_UNAVAILABLE', message: 'private diagnostic' } };
  await assert.rejects(m.auth.request('GET', '/context'), error => {
    const result = safeError(error).error;
    assert.equal(result.code, 'LEARNING_UNAVAILABLE'); assert.equal(result.retryAfterSeconds, 30);
    assert.match(result.message, /service recovery.*original payload/);
    assert.doesNotMatch(result.message, /private diagnostic/); return true;
  });
});

for (const status of [429, 503]) {
  test(`${status} Retry-After survives a timeout while reading an overloaded response body`, async t => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'retry-after': '45' }); res.write('{');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address() as { port: number };
    const response = await requestJson(`http://127.0.0.1:${address.port}`, {}, 100);
    assert.equal(response.status, status); assert.equal(response.retryAfterSeconds, 45);
  });
}

test('remote MCP negotiation and tool execution share the per-profile HTTP request budget', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const times = outboundTimes(t, `${m.origin}/mcp`);
  await new LearningTools().call(m.auth, 'encbird_get_context');
  const requests = m.requests.filter(r => r.path === '/mcp');
  assert.deepEqual(requests.map(r => (r.body as any).method), ['initialize', 'notifications/initialized', 'tools/call']);
  assertSpaced(times, 3);
  assert.equal((await m.read())!.traffic!.recent.length, 3);
});

test('slow credential saves preserve spacing across remote MCP negotiation and tool execution', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const injected = delayFirstTrafficSave(t, [m.store]);
  const times = outboundTimes(t, `${m.origin}/mcp`);
  await new LearningTools().call(m.auth, 'encbird_get_context');
  assert.equal(injected(), 1);
  assertSpaced(times, 3);
  assert.deepEqual(m.requests.filter(r => r.path === '/mcp').map(r => (r.body as any).method),
    ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal((await m.read())!.traffic!.recent.length, 3);
});

test('exhausting the budget during negotiation never sends the pending write', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  await m.store.withLock(async tx => {
    const value = (await tx.load())!;
    value.traffic = { recent: Array.from({ length: 58 }, () => Date.now()), nextRequestAt: 0, blockedUntil: 0 };
    await tx.save(value);
  });
  await assert.rejects(new LearningTools().call(m.auth, 'encbird_add_expression', { phrase: 'hello', idempotencyKey: 'same' }), { code: 'REQUEST_THROTTLED' });
  assert.equal(m.requests.filter(r => r.path === '/mcp').length, 2);
  assert.equal(m.rpcCalls().length, 0);
  assert.equal((await m.read())!.traffic!.recent.length, 60);
});

for (const status of [429, 503]) {
  test(`remote ${status} persists its cooldown across processes without replay or REST fallback`, async t => {
    const m = await mock(); t.after(() => m.close()); await m.login();
    m.flags.apiStatus = status; m.flags.apiRetryAfter = '90';
    m.flags.apiBody = { error: { code: 'LEARNING_UNAVAILABLE', message: 'private diagnostic' } };
    const tools = new LearningTools(); const input = { phrase: 'hello', idempotencyKey: 'same' };
    await assert.rejects(tools.call(m.auth, 'encbird_add_expression', input), error => {
      assert.equal(safeError(error).error.retryAfterSeconds, 90);
      assert.equal(safeError(error).error.code, 'LEARNING_UNAVAILABLE');
      assert.ok(!JSON.stringify(safeError(error)).includes('private diagnostic')); return true;
    });
    const before = m.requests.length;
    await m.store.withLock(async tx => { const value = (await tx.load())!; value.expiresAt = 0; await tx.save(value); });
    const restarted = new Auth(m.base, new CredentialStore(m.base, 'mock-host', m.secrets, m.directory), m.secrets, m.browser);
    await assert.rejects(tools.call(restarted, 'encbird_add_expression', input), { code: 'REQUEST_THROTTLED' });
    assert.equal(m.requests.length, before); assert.equal(m.counts.refresh, 0);
    assert.deepEqual(m.rpcCalls().map(r => (r.body as any).params.arguments), [input]);
    assert.ok(!m.requests.some(r => r.path.endsWith('/expressions')));
  });
}
