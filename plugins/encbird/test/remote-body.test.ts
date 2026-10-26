import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { callRemoteTool } from '../src/remote.js';
import { apiError } from '../src/api-errors.js';
import { uncertainOutcome } from '../src/errors.js';
import { responseStream } from './response-stream.js';

const base = 'http://127.0.0.1:1/v1/mcp-learning';
const oversized = `The remote MCP response exceeded its size limit. Ask the operator to check service compatibility and connectivity before retrying. ${uncertainOutcome}`;
const network = `The remote MCP request failed. No fallback or automatic retry was attempted. Ask the operator to check service compatibility and connectivity before retrying. ${uncertainOutcome}`;
type RequestMessage = { id?: number; method: string };
function resultBody(request: RequestMessage, text: string) {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [], structuredContent: { data: { text } } } }));
}
function remoteFixture(t: TestContext, respond: (request: RequestMessage) => Response, phase = 'tools/call') {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal(url, 'http://127.0.0.1:1/mcp');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-token');
    const request = JSON.parse(init.body as string) as RequestMessage;
    requests.push(request.method);
    if (request.method === phase) return respond(request);
    if (request.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } },
    }), { headers: { 'content-type': 'application/json' } });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response(resultBody(request, 'ok'), { headers: { 'content-type': 'application/json' } });
  });
  return { requests, call: () => callRemoteTool(base, async () => 'fixture-token', 'encbird_get_context', {}) };
}

test('MCP accepts exactly 1 MiB across chunks and cancels at the next byte with its original error', async t => {
  let extra = false;
  let stream: ReturnType<typeof responseStream>;
  let expected: string;
  const f = remoteFixture(t, request => {
    expected = 'x'.repeat(1_048_576 - resultBody(request, '').length);
    const raw = resultBody(request, expected);
    assert.equal(raw.length, 1_048_576);
    stream = responseStream([raw.subarray(0, 500_000), raw.subarray(500_000),
      ...(extra ? [Buffer.from(' '), Buffer.from('unread')] : [])]);
    return new Response(stream.body, { headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(await f.call(), { data: { text: expected! } });
  assert.equal(stream!.cancellations(), 0);
  extra = true;
  await assert.rejects(f.call(), { code: 'INVALID_RESPONSE', message: oversized });
  assert.equal(stream!.reads(), 3); assert.equal(stream!.cancellations(), 1);
  assert.equal(f.requests.filter(method => method === 'tools/call').length, 2);
});

test('MCP preserves split UTF-8 and replacement decoding; a BOM is still invalid JSON', async t => {
  let mode = 'valid';
  const f = remoteFixture(t, request => {
    let raw = resultBody(request, mode === 'valid' ? '한😀' : '~');
    if (mode === 'replacement') {
      const at = raw.indexOf('~');
      raw = Buffer.concat([raw.subarray(0, at), Uint8Array.of(0xe2, 0x82), raw.subarray(at + 1)]);
    }
    if (mode === 'bom') raw = Buffer.concat([Uint8Array.of(0xef, 0xbb, 0xbf), raw]);
    return new Response(responseStream([...raw].map(byte => Uint8Array.of(byte))).body,
      { headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(await f.call(), { data: { text: '한😀' } });
  mode = 'replacement'; assert.deepEqual(await f.call(), { data: { text: '\ufffd' } });
  mode = 'bom';
  await assert.rejects(f.call(), { code: 'INVALID_RESPONSE',
    message: `The service returned an unexpected response shape. Ask the operator to check plugin/service compatibility before retrying. ${uncertainOutcome}` });
});

for (const failure of ['read', 'cancel'] as const) {
  test(`MCP ${failure} failure keeps its original NETWORK_ERROR`, async t => {
    let stream: ReturnType<typeof responseStream>;
    const f = remoteFixture(t, () => {
      stream = responseStream(failure === 'read' ? [Buffer.from('{')] : [new Uint8Array(1_048_577)],
        failure === 'read' ? { readError: new Error('private read failure') } : { cancelError: new Error('private cancel failure') });
      return new Response(stream.body, { headers: { 'content-type': 'application/json' } });
    });
    await assert.rejects(f.call(), { code: 'NETWORK_ERROR', message: network });
    assert.equal(stream!.cancellations(), failure === 'read' ? 0 : 1);
    assert.deepEqual(f.requests, ['initialize', 'notifications/initialized', 'tools/call']);
  });
}

test('MCP 401 precedes session/media/body errors and ignores cancellation failure', async t => {
  let stream: ReturnType<typeof responseStream>;
  const f = remoteFixture(t, () => {
    stream = responseStream([new Uint8Array(1_048_577)], { cancelError: new Error('private cancellation') });
    return new Response(stream.body, { status: 401, headers: { 'mcp-session-id': 'unexpected', 'content-type': 'text/event-stream' } });
  });
  await assert.rejects(f.call(), { code: 'AUTH_REQUIRED', message: apiError(401, 'MCP_HTTP_ERROR').message });
  assert.equal(stream!.reads(), 0); assert.equal(stream!.cancellations(), 1);
  assert.deepEqual(f.requests, ['initialize', 'notifications/initialized', 'tools/call']);
});

for (const status of [429, 503]) {
  test(`MCP ${status} keeps Retry-After when its body is malformed, oversized, unreadable or uncancellable`, async t => {
    let body: ReadableStream<Uint8Array>;
    const f = remoteFixture(t, () => new Response(body, { status, headers: { 'retry-after': '45' } }));
    const streams = [
      responseStream([Buffer.from('invalid')]),
      responseStream([new Uint8Array(1_048_576), Uint8Array.of(1)]),
      responseStream([Buffer.from('{')], { readError: new Error('private read failure') }),
      responseStream([new Uint8Array(1_048_577)], { cancelError: new Error('private cancel failure') }),
    ];
    const expected = apiError(status, 'API_ERROR', 45);
    for (const stream of streams) {
      body = stream.body;
      await assert.rejects(f.call(), { code: expected.code, message: expected.message, retryAfterSeconds: 45 });
    }
    assert.equal(f.requests.filter(method => method === 'tools/call').length, streams.length);
  });
}

test('MCP still rejects empty tool responses while allowing only empty notification acknowledgements', async t => {
  const f = remoteFixture(t, () => new Response(null, { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(f.call(), { code: 'INVALID_RESPONSE',
    message: `The service returned an unexpected response shape. Ask the operator to check plugin/service compatibility before retrying. ${uncertainOutcome}` });
});

test('MCP notification status/body checks still gate learning calls', async t => {
  let status = 202;
  let body: string | null = null;
  const f = remoteFixture(t, () => new Response(body, { status }), 'notifications/initialized');
  for (const accepted of [200, 202, 204]) {
    status = accepted; body = accepted === 204 ? null : ' \r\n\t';
    assert.deepEqual(await f.call(), { data: { text: 'ok' } });
  }
  for (const rejected of [{ status: 206, body: '' }, { status: 202, body: '{}' }]) {
    ({ status, body } = rejected);
    const before = f.requests.length;
    await assert.rejects(f.call(), { code: 'MCP_PROTOCOL_ERROR', message: 'The MCP notification acknowledgement was invalid.' });
    assert.deepEqual(f.requests.slice(before), ['initialize', 'notifications/initialized']);
  }
});
