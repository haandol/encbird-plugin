import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RESPONSE_BYTES, readBoundedBody } from '../src/body.js';
import { responseStream } from './response-stream.js';

test('bounded reader accepts exactly 1,048,576 bytes across chunks without cancelling', async () => {
  assert.equal(MAX_RESPONSE_BYTES, 1_048_576);
  const first = Buffer.from('한'.repeat(349_525));
  const stream = responseStream([first, Buffer.from('!')]);
  assert.equal(first.length + 1, 1_048_576);
  assert.deepEqual(await readBoundedBody(stream.body), { kind: 'complete', text: '한'.repeat(349_525) + '!' });
  assert.equal(stream.cancellations(), 0); assert.equal(stream.reads(), 3);
});

test('bounded reader cancels and stops at limit + 1 across chunks', async () => {
  const stream = responseStream([new Uint8Array(1_048_576), Uint8Array.of(1), Buffer.from('unread')]);
  assert.deepEqual(await readBoundedBody(stream.body), { kind: 'too-large' });
  assert.equal(stream.reads(), 2); assert.equal(stream.cancellations(), 1);
});

test('bounded reader waits for cancellation before reporting oversize', async () => {
  let release!: () => void;
  let cancelling!: () => void;
  const started = new Promise<void>(resolve => { cancelling = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1_048_577)); },
    cancel() { cancelling(); return gate; },
  });
  let settled = false;
  const read = readBoundedBody(body).finally(() => { settled = true; });
  await started;
  try { assert.equal(settled, false); } finally { release(); }
  assert.deepEqual(await read, { kind: 'too-large' });
});

for (const failure of ['read', 'cancel'] as const) {
  test(`bounded reader passes through the original ${failure} failure`, async () => {
    const error = new Error('stream failure');
    const stream = responseStream(failure === 'read' ? [Buffer.from('partial')] : [new Uint8Array(1_048_577)],
      failure === 'read' ? { readError: error } : { cancelError: error });
    await assert.rejects(readBoundedBody(stream.body), value => value === error);
    assert.equal(stream.reads(), failure === 'read' ? 2 : 1);
    assert.equal(stream.cancellations(), failure === 'read' ? 0 : 1);
  });
}

test('bounded reader leaves acquisition failures to its caller', async () => {
  const { body } = responseStream([]);
  const lock = body.getReader();
  try { await assert.rejects(readBoundedBody(body), TypeError); }
  finally { lock.releaseLock(); }
});

test('bounded reader returns empty text for absent and empty bodies', async () => {
  assert.deepEqual(await readBoundedBody(null), { kind: 'complete', text: '' });
  const stream = responseStream([new Uint8Array()]);
  assert.deepEqual(await readBoundedBody(stream.body), { kind: 'complete', text: '' });
  assert.equal(stream.cancellations(), 0);
});

test('bounded reader decodes once after joining bytes, preserving split UTF-8, replacement characters and BOM', async () => {
  for (const [bytes, text] of [
    [Buffer.from('한😀é'), '한😀é'],
    [Uint8Array.of(0xe2, 0x82), '\ufffd'],
    [Uint8Array.of(0xff, 0x61, 0x80), '\ufffda\ufffd'],
    [Uint8Array.of(0xef, 0xbb, 0xbf, 0x61), '\ufeffa'],
  ] as const) {
    const stream = responseStream([...bytes].map(byte => Uint8Array.of(byte)));
    assert.deepEqual(await readBoundedBody(stream.body), { kind: 'complete', text });
  }
});
