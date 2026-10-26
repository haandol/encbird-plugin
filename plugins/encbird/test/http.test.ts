import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../src/http.js';
import { uncertainOutcome } from '../src/errors.js';
import { responseStream } from './response-stream.js';

const endpoint = 'http://127.0.0.1:1/fixture';
const oversized = `The service response exceeded the size limit. Ask the operator to repair the response before retrying. ${uncertainOutcome}`;
const invalidJson = `The service returned invalid JSON. Ask the operator to restore a valid response before retrying. ${uncertainOutcome}`;
const network = `The service request could not be completed securely; delivery or response receipt is uncertain. Check connectivity and ask the operator if it persists. Retry only after access is restored; no fallback was attempted. ${uncertainOutcome}`;

test('HTTP accepts exactly 1 MiB across chunks and rejects the next byte with its original error', async t => {
  const raw = Buffer.from(JSON.stringify('x'.repeat(1_048_574)));
  assert.equal(raw.length, 1_048_576);
  const exact = responseStream([raw.subarray(0, 500_000), raw.subarray(500_000)]);
  const over = responseStream([raw, Buffer.from(' '), Buffer.from('unread')]);
  let response = new Response(exact.body);
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal); return response;
  });
  assert.deepEqual(await requestJson(endpoint), { status: 200, body: 'x'.repeat(1_048_574) });
  assert.equal(exact.cancellations(), 0);
  response = new Response(over.body);
  await assert.rejects(requestJson(endpoint), { code: 'INVALID_RESPONSE', message: oversized });
  assert.equal(over.reads(), 2); assert.equal(over.cancellations(), 1); assert.equal(fetch.mock.callCount(), 2);
});

test('HTTP preserves UTF-8 across chunks and replacement decoding for malformed bytes', async t => {
  const raw = Buffer.from('"한😀"');
  let response = new Response(responseStream([...raw].map(byte => Uint8Array.of(byte))).body);
  t.mock.method(globalThis, 'fetch', async () => response);
  assert.equal((await requestJson(endpoint)).body, '한😀');
  response = new Response(responseStream([Uint8Array.of(34, 0xe2), Uint8Array.of(0x82, 34)]).body);
  assert.equal((await requestJson(endpoint)).body, '\ufffd');
  response = new Response(Uint8Array.of(0xef, 0xbb, 0xbf, 123, 125));
  await assert.rejects(requestJson(endpoint), { code: 'INVALID_RESPONSE', message: invalidJson });
});

test('HTTP preserves empty success, invalid JSON and optional error body handling', async t => {
  let response: Response;
  t.mock.method(globalThis, 'fetch', async () => response);
  for (const status of [200, 204]) {
    response = new Response(null, { status });
    assert.deepEqual(await requestJson(endpoint), { status, body: null });
  }
  for (const raw of ['', ' ', 'invalid']) {
    response = new Response(raw);
    if (!raw) assert.deepEqual(await requestJson(endpoint), { status: 200, body: null });
    else await assert.rejects(requestJson(endpoint), { code: 'INVALID_RESPONSE', message: invalidJson });
    response = new Response(raw, { status: 400 });
    await assert.rejects(requestJson(endpoint), { code: 'INVALID_RESPONSE', message: invalidJson });
    response = new Response(raw, { status: 400 });
    assert.deepEqual(await requestJson(endpoint, {}, 1000, true), { status: 400, body: {} });
  }
  response = new Response('x'.repeat(1_048_577), { status: 400 });
  assert.deepEqual(await requestJson(endpoint, {}, 1000, true), { status: 400, body: {} });
});

for (const failure of ['read', 'cancel'] as const) {
  test(`HTTP ${failure} failure keeps NETWORK_ERROR even with optional error bodies`, async t => {
    let response: Response;
    const fetch = t.mock.method(globalThis, 'fetch', async () => response);
    for (const status of [200, 400]) {
      const stream = responseStream(failure === 'read' ? [Buffer.from('{')] : [new Uint8Array(1_048_577)],
        failure === 'read' ? { readError: new Error('private read failure') } : { cancelError: new Error('private cancel failure') });
      response = new Response(stream.body, { status });
      await assert.rejects(requestJson(endpoint, {}, 1000, true), { code: 'NETWORK_ERROR', message: network });
      assert.equal(stream.cancellations(), failure === 'read' ? 0 : 1);
    }
    assert.equal(fetch.mock.callCount(), 2);
  });
}

test('HTTP optional 401 skips body reads and ignores cancellation failure', async t => {
  const stream = responseStream([new Uint8Array(1_048_577)], { cancelError: new Error('private cancellation') });
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(stream.body, { status: 401 }));
  assert.deepEqual(await requestJson(endpoint, {}, 1000, true), { status: 401, body: null });
  assert.equal(stream.reads(), 0); assert.equal(stream.cancellations(), 1); assert.equal(fetch.mock.callCount(), 1);
});

test('HTTP strict 401 still validates its body', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('invalid', { status: 401 }));
  await assert.rejects(requestJson(endpoint), { code: 'INVALID_RESPONSE', message: invalidJson });
});

for (const status of [429, 503]) {
  test(`HTTP ${status} retains Retry-After for malformed, oversized, unreadable and uncancellable bodies`, async t => {
    let response: Response;
    const fetch = t.mock.method(globalThis, 'fetch', async () => response);
    const streams = [
      responseStream([Buffer.from('invalid')]),
      responseStream([new Uint8Array(1_048_576), Uint8Array.of(1)]),
      responseStream([Buffer.from('{')], { readError: new Error('private read failure') }),
      responseStream([new Uint8Array(1_048_577)], { cancelError: new Error('private cancel failure') }),
    ];
    for (const stream of streams) {
      response = new Response(stream.body, { status, headers: { 'retry-after': '45' } });
      assert.deepEqual(await requestJson(endpoint), { status, body: {}, retryAfterSeconds: 45 });
    }
    assert.equal(fetch.mock.callCount(), streams.length);
  });
}
