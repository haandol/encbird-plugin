import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { callRemoteTool, remoteMcpUrl } from '../src/remote.js';
import { DEFAULT_BASE } from '../src/config.js';
import { SafeError } from '../src/errors.js';
import { LearningTools } from '../src/tools.js';
import { mock } from './helpers.js';

async function serverFixture() {
  const requests: { method: string; path: string; body: any; headers: Record<string, unknown> }[] = [];
  const options = { protocolVersion: '2025-06-18', initializeFailure: false,
    call: undefined as undefined | ((request: any, response: ServerResponse) => void), notificationBody: '', notificationStatus: 202 };
  const result = { data: { dataSource: 'encbird', cefrLevel: 'B1' } };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    requests.push({ method: req.method!, path: req.url!, body, headers: { ...req.headers } });
    res.setHeader('content-type', 'application/json');
    if (body.method === 'initialize') {
      if (options.initializeFailure) { res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="https://untrusted.example/metadata"' }).end('{"error":{"code":"AUTHENTICATION_REQUIRED","message":"secret-stack"}}'); return; }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: options.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-encbird', version: '1.0.0' } } })); return;
    }
    if (body.method === 'notifications/initialized') { res.writeHead(options.notificationStatus).end(options.notificationBody); return; }
    if (options.call) { options.call(body, res); return; }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { requests, options, result, base: `http://127.0.0.1:${address.port}/v1/mcp-learning`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('remote endpoint is the fixed production /mcp or the explicit loopback origin /mcp', () => {
  assert.equal(remoteMcpUrl(DEFAULT_BASE), 'https://api.encbird.com/mcp');
  assert.equal(remoteMcpUrl('http://localhost:18080/custom/api'), 'http://localhost:18080/mcp');
  assert.equal(remoteMcpUrl('http://[::1]:18080/v1/mcp-learning'), 'http://[::1]:18080/mcp');
  for (const value of ['https://other.example/v1/mcp-learning', 'http://other.example', 'http://localhost/../secret', 'http://localhost/x?token=x']) {
    assert.throws(() => remoteMcpUrl(value), { code: 'INVALID_CONFIG' });
  }
});

test('SDK negotiates protocol and initializes before tools/call, using current authorization on every POST', async t => {
  const f = await serverFixture(); t.after(() => f.close()); let count = 0;
  assert.deepEqual(await callRemoteTool(f.base, async () => `token-${++count}`, 'encbird_get_context', {}), f.result);
  assert.deepEqual(f.requests.map(r => r.body.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.deepEqual(f.requests.map(r => r.headers.authorization), ['Bearer token-1', 'Bearer token-2', 'Bearer token-3']);
  assert.equal(f.requests[0]!.headers['mcp-protocol-version'], undefined);
  assert.equal(f.requests[1]!.headers['mcp-protocol-version'], '2025-06-18');
  assert.equal(f.requests[2]!.headers['mcp-protocol-version'], '2025-06-18');
  assert.ok(f.requests.every(r => r.method === 'POST' && r.path === '/mcp' && r.headers.accept === 'application/json, text/event-stream' && !r.headers['mcp-session-id']));
  assert.deepEqual(f.requests[2]!.body.params, { name: 'encbird_get_context', arguments: {} });
});

test('registration stays on the existing lifecycle endpoint and a rotated token is used for subsequent MCP calls', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); const tools = new LearningTools();
  const before = (await m.read())!.accessToken;
  await tools.call(m.auth, 'encbird_get_context');
  const registrationIndex = m.requests.findIndex(r => r.path.endsWith('/connections'));
  assert.ok(m.requests.findIndex(r => r.path === '/mcp') > registrationIndex);
  const firstCalls = m.requests.filter(r => r.path === '/mcp'); assert.ok(firstCalls.every(r => r.token === `Bearer ${before}`));
  await m.store.withLock(async tx => { const value = (await tx.load())!; value.expiresAt = 0; await tx.save(value); });
  const start = m.requests.length;
  await tools.call(m.auth, 'encbird_get_context');
  const after = (await m.read())!.accessToken; assert.notEqual(after, before); assert.equal(m.counts.refresh, 1);
  assert.ok(m.requests.slice(start).filter(r => r.path === '/mcp').every(r => r.token === `Bearer ${after}`));
  assert.ok(!m.requests.some(r => r.path.endsWith('/context')));
});

test('structured and text-only tool errors retain domain codes and suppress remote messages', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); const tools = new LearningTools();
  const envelope = { error: { code: 'MCP_QUIZ_REVISION_CONFLICT', message: 'secret-stack Bearer private-token' } };
  for (const structured of [true, false]) {
    m.rpc.result = { isError: true, ...(structured ? { structuredContent: envelope } : {}), content: [{ type: 'text', text: JSON.stringify(envelope) }] };
    await assert.rejects(tools.call(m.auth, 'encbird_get_context'), error => {
      assert.ok(error instanceof SafeError); assert.equal(error.code, envelope.error.code);
      assert.ok(!error.message.includes('secret-stack')); assert.ok(!error.message.includes('private-token')); return true;
    });
  }
  m.rpc.result = undefined; m.rpc.error = { code: -32000, message: 'secret-stack', data: { error: { code: 'LEARNING_CONFLICT', message: 'secret-stack' } } };
  await assert.rejects(tools.call(m.auth, 'encbird_get_context'), { code: 'LEARNING_CONFLICT' });
});

test('HTTP authentication failure follows neither metadata URLs nor an automatic retry', async t => {
  const f = await serverFixture(); t.after(() => f.close()); f.options.initializeFailure = true;
  await assert.rejects(callRemoteTool(f.base, async () => 'private-token', 'encbird_get_context', {}), { code: 'AUTH_REQUIRED' });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.path, '/mcp');
});

test('HTTP 401 on tools/call permits only an explicit same-operation retry with refresh', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); const tools = new LearningTools();
  m.flags.apiStatus = 401; m.flags.apiBody = { error: { code: 'AUTHENTICATION_REQUIRED', message: 'unsafe' } };
  const input = { phrase: 'look up', idempotencyKey: 'same-operation' };
  await assert.rejects(tools.call(m.auth, 'encbird_add_expression', input), { code: 'AUTH_REQUIRED' });
  assert.equal(m.rpcCalls().length, 1); assert.equal(m.counts.refresh, 0);
  m.flags.apiStatus = 200; m.flags.apiBody = undefined;
  await tools.call(m.auth, 'encbird_add_expression', input);
  assert.equal(m.counts.refresh, 1); assert.equal(m.rpcCalls().length, 2);
  assert.deepEqual(m.rpcCalls().map(r => (r.body as any).params.arguments), [input, input]);
});

test('CONNECTION_INACTIVE in a JSON tool result disables learning and uses existing lifecycle cleanup', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); const tools = new LearningTools();
  const error = { error: { code: 'CONNECTION_INACTIVE', message: 'unsafe' } };
  m.rpc.result = { isError: true, structuredContent: error, content: [{ type: 'text', text: JSON.stringify(error) }] };
  await assert.rejects(tools.call(m.auth, 'encbird_get_context'), { code: 'CONNECTION_INACTIVE' });
  assert.equal(m.counts.disconnect, 1); assert.equal(m.counts.revoke, 1); assert.equal(await m.read(), undefined);
  await assert.rejects(tools.call(m.auth, 'encbird_get_context'), { code: 'AUTH_REQUIRED' });
});

for (const failure of ['disconnect', 'timeout', 'redirect', 'sse', 'session', 'wrong-id', 'invalid-json', 'oversized']) {
  test(`remote ${failure} fails safely without replaying a write or falling back to REST`, async t => {
    const f = await serverFixture(); t.after(() => f.close());
    f.options.call = (request, response) => {
      if (failure === 'disconnect') { response.destroy(); return; }
      if (failure === 'timeout') { response.writeHead(200); response.write('{'); return; }
      if (failure === 'redirect') { response.writeHead(307, { location: '/v1/mcp-learning/expressions' }).end(); return; }
      if (failure === 'sse') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: {}\n\n'); return; }
      if (failure === 'session') response.setHeader('mcp-session-id', 'unexpected-session');
      if (failure === 'invalid-json') { response.end('invalid'); return; }
      if (failure === 'oversized') { response.end('x'.repeat(1_048_577)); return; }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: failure === 'wrong-id' ? request.id + 99 : request.id, result: { content: [] } }));
    };
    await assert.rejects(callRemoteTool(f.base, async () => 'private-token', 'encbird_add_expression', { phrase: 'look up', idempotencyKey: 'same-op' }, 100), error => {
      assert.ok(error instanceof SafeError); assert.ok(['NETWORK_ERROR', 'INVALID_RESPONSE', 'MCP_PROTOCOL_ERROR'].includes(error.code)); return true;
    });
    assert.equal(f.requests.filter(r => r.body.method === 'tools/call').length, 1);
    assert.ok(f.requests.every(r => r.path === '/mcp' && r.method === 'POST'));
  });
}

test('unsupported protocol or invalid initialized acknowledgement never sends a learning request', async t => {
  const f = await serverFixture(); t.after(() => f.close());
  f.options.protocolVersion = '2099-01-01';
  await assert.rejects(callRemoteTool(f.base, async () => 'token', 'encbird_get_context', {}), { code: 'MCP_PROTOCOL_ERROR' });
  f.options.protocolVersion = '2025-06-18'; f.options.notificationBody = '{"unexpected":true}';
  await assert.rejects(callRemoteTool(f.base, async () => 'token', 'encbird_get_context', {}), { code: 'MCP_PROTOCOL_ERROR' });
  assert.ok(!f.requests.some(r => r.body.method === 'tools/call'));
});

test('MCP authentication guard still rejects credentials hidden in JSON member names before network I/O', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); const current = (await m.read())!;
  const start = m.requests.length;
  for (const key of [current.accessToken!, current.refreshToken!]) {
    await assert.rejects(m.auth.callLearningTool('encbird_save_memory', { nested: { [key]: 'text' } }), { code: 'PRIVACY_FILTERED' });
  }
  assert.equal(m.requests.length, start);
});

test('a protocol timeout waits for an already-started token refresh before releasing its caller', async t => {
  const f = await serverFixture(); t.after(() => f.close());
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = 0; let returned = false;
  const operation = callRemoteTool(f.base, async () => { if (++requested === 1) await gate; return 'current-token'; }, 'encbird_get_context', {}, 10);
  const checked = assert.rejects(operation, { code: 'MCP_PROTOCOL_ERROR' }).finally(() => { returned = true; });
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(returned, false);
  release(); await checked;
  assert.ok(!f.requests.some(r => r.body.method === 'tools/call'));
});

test('an overloaded initialization acknowledgement stops before any learning call', async t => {
  const f = await serverFixture(); t.after(() => f.close());
  f.options.notificationStatus = 429; f.options.notificationBody = 'private diagnostic';
  await assert.rejects(callRemoteTool(f.base, async () => 'token', 'encbird_add_expression', { phrase: 'hello', idempotencyKey: 'same' }),
    { code: 'RATE_LIMITED', retryAfterSeconds: 30 });
  assert.deepEqual(f.requests.map(r => r.body.method), ['initialize', 'notifications/initialized']);
});

test('remote overload retains Retry-After when its response body stalls', async t => {
  const f = await serverFixture(); t.after(() => f.close());
  f.options.call = (_request, response) => { response.writeHead(503, { 'retry-after': '45' }); response.write('{'); };
  await assert.rejects(callRemoteTool(f.base, async () => 'token', 'encbird_get_context', {}, 100),
    { code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: 45 });
  assert.equal(f.requests.filter(r => r.body.method === 'tools/call').length, 1);
});
