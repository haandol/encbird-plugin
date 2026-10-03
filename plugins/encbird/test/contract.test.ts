import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LearningTools } from '../src/tools.js';
import { mock } from './helpers.js';
import samples from '../contracts/serialization-samples.json' with { type: 'json' };

test('external privacy filter blocks sensitive source excerpts and known tokens before HTTP', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); const tools = new LearningTools();
  for (const text of ['Contact me at user@example.com', 'https://private.example/report', 'password: topsecret', '010-1234-5678', 'sk-abcdefghijklmno']) {
    const input = structuredClone(samples.encbird_save_memory.input); input.messages[0]!.content = text;
    const before = m.requests.length;
    await assert.rejects(tools.call(m.auth, 'encbird_save_memory', input), { code: 'PRIVACY_FILTERED' });
    assert.equal(m.requests.length, before);
  }
  const token = (await m.read())!.accessToken!;
  await assert.rejects(tools.call(m.auth, 'encbird_search_expressions', { query: token }), { code: 'PRIVACY_FILTERED' });
});

test('external UTF-8 byte limits apply to Korean content before HTTP', async t => {
  const m = await mock(); t.after(() => m.close()); const tools = new LearningTools();
  const input = structuredClone(samples.encbird_save_memory.input); input.messages[0]!.content = '한'.repeat(1400);
  await assert.rejects(tools.call(m.auth, 'encbird_save_memory', input), { code: 'INVALID_ARGUMENTS' }); assert.equal(m.requests.length, 0);
});

test('each data tool rejects malformed success payloads and unexpected private fields', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); const tools = new LearningTools();
  for (const [name, sample] of Object.entries(samples)) {
    m.flags.apiBody = { data: { privateEmail: 'hidden@example.com', unexpected: true } };
    await assert.rejects(tools.call(m.auth, name, sample.input), { code: 'INVALID_RESPONSE' });
  }
});

test('explicit quiz ratings 1-4, actual completion and assistance are enforced', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); const tools = new LearningTools();
  for (const rating of [1, 2, 3, 4]) {
    const input = { ...samples.encbird_submit_quiz_result.input, rating };
    await tools.call(m.auth, 'encbird_submit_quiz_result', input);
    assert.equal((m.rpcCalls().at(-1)!.body as any).params.arguments.rating, rating);
  }
  for (const patch of [{ rating: 0 }, { rating: 5 }, { completed: false }, { assistance: 'inferred' }, { questionRevision: 'old' }]) {
    await assert.rejects(tools.call(m.auth, 'encbird_submit_quiz_result', { ...samples.encbird_submit_quiz_result.input, ...patch }), { code: 'INVALID_ARGUMENTS' });
  }
});

test('expression candidates require an explicit supported phrase origin before HTTP', async t => {
  const m = await mock(); t.after(() => m.close()); const tools = new LearningTools();
  for (const origin of [undefined, 'inferred', 'external_host']) {
    const input = structuredClone(samples.encbird_save_suggested_expressions.input) as Record<string, any>;
    if (origin === undefined) delete input.candidates[0].phraseOrigin;
    else input.candidates[0].phraseOrigin = origin;
    await assert.rejects(tools.call(m.auth, 'encbird_save_suggested_expressions', input), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(m.requests.length, 0);
});

for (const phraseOrigin of ['user_expression', 'quoted_expression', 'host_generated']) {
  test(`preserves ${phraseOrigin} and the corresponding learner evidence on the wire`, async t => {
    const m = await mock(); t.after(() => m.close()); await m.login(); const tools = new LearningTools();
    const input = structuredClone(samples.encbird_save_suggested_expressions.input) as Record<string, any>;
    input.candidates[0].phraseOrigin = phraseOrigin;
    input.candidates[0].phrase = 'look up';
    input.messages[0].content = phraseOrigin === 'user_expression' ? 'I look up the trail.'
      : phraseOrigin === 'quoted_expression' ? 'What does "look up" mean?' : 'I want to practice finding trail information.';
    await tools.call(m.auth, 'encbird_save_suggested_expressions', input);
    assert.deepEqual((m.rpcCalls().at(-1)!.body as any).params.arguments, input);
  });
}

test('suggestion reads preserve explicit origin and accept legacy rows without inferring one', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); const tools = new LearningTools();
  const result = structuredClone(samples.encbird_list_suggested_expressions.output) as { data: Record<string, unknown>[] };
  delete result.data[0]!.phraseOrigin;
  m.flags.apiBody = result;
  assert.deepEqual(await tools.call(m.auth, 'encbird_list_suggested_expressions'), result);
  for (const origin of ['user_expression', 'quoted_expression', 'host_generated']) {
    result.data[0]!.phraseOrigin = origin;
    assert.deepEqual(await tools.call(m.auth, 'encbird_list_suggested_expressions'), result);
  }
  result.data[0]!.phraseOrigin = 'inferred';
  await assert.rejects(tools.call(m.auth, 'encbird_list_suggested_expressions'), { code: 'INVALID_RESPONSE' });
});

test('accepting a suggestion requires its exact version and original registration key without registering again', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); const tools = new LearningTools();
  const start = m.rpcCalls().length;
  for (const version of [0, 3]) {
    const input = { phraseHash: 'selected-phrase', version, registrationKey: 'original-registration' };
    m.flags.apiBody = { data: { phraseHash: input.phraseHash, version, status: 'saved' } };
    assert.deepEqual(await tools.call(m.auth, 'encbird_accept_suggested_expression', input), m.flags.apiBody);
    assert.deepEqual((m.rpcCalls().at(-1)!.body as any).params.arguments, input);
  }
  assert.equal(m.rpcCalls().length - start, 2);
  assert.ok(m.rpcCalls().slice(start).every(r => r.method === 'POST' && r.path === '/mcp' && (r.body as any).params.name === 'encbird_accept_suggested_expression'));
  for (const input of [
    { phraseHash: 'selected-phrase', registrationKey: 'original-registration' },
    { phraseHash: 'selected-phrase', version: null, registrationKey: 'original-registration' },
    { phraseHash: 'selected-phrase', version: -1, registrationKey: 'original-registration' },
    { phraseHash: 'selected-phrase', version: 0 },
  ]) await assert.rejects(tools.call(m.auth, 'encbird_accept_suggested_expression', input), { code: 'INVALID_ARGUMENTS' });
  assert.equal(m.rpcCalls().length - start, 2);
});

test('a failed suggestion acknowledgement retries the same receipt-bound operation and does not alter registration', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login(); const tools = new LearningTools();
  const input = { phraseHash: 'selected-phrase', version: 2, registrationKey: 'original-registration' };
  m.flags.apiStatus = 409; m.flags.apiBody = { error: { code: 'LEARNING_CONFLICT', message: 'internal detail' } };
  const start = m.rpcCalls().length;
  await assert.rejects(tools.call(m.auth, 'encbird_accept_suggested_expression', input), { code: 'LEARNING_CONFLICT' });
  assert.equal(m.rpcCalls().length - start, 1);
  m.flags.apiStatus = 200; m.flags.apiBody = { data: { phraseHash: input.phraseHash, version: input.version, status: 'saved' } };
  await tools.call(m.auth, 'encbird_accept_suggested_expression', input);
  assert.deepEqual(m.rpcCalls().slice(start).map(r => (r.body as any).params.arguments), [input, input]);
});

test('suggestion registration keys enforce exact printable ASCII rules before HTTP', async t => {
  assert.equal(samples.encbird_accept_suggested_expression.input.registrationKey, samples.encbird_add_expression.input.idempotencyKey);
  assert.equal(samples.encbird_add_expression.output.data.expression.status, 'NORMAL');
  const m = await mock(); t.after(() => m.close()); await m.login(); const tools = new LearningTools();
  const before = m.requests.length;
  for (const registrationKey of ['', 'contains space', 'trailing\n', 'leading\t', 'delete\x7f', '한글', 'a'.repeat(129)]) {
    await assert.rejects(tools.call(m.auth, 'encbird_accept_suggested_expression', {
      phraseHash: 'selected-phrase', version: 0, registrationKey,
    }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(m.requests.length, before);
  for (const registrationKey of ['!', '~', '#', 'attempt:1/receipt', 'a'.repeat(128)]) {
    await tools.call(m.auth, 'encbird_accept_suggested_expression', { phraseHash: 'selected-phrase', version: 0, registrationKey });
    assert.equal((m.rpcCalls().at(-1)!.body as any).params.arguments.registrationKey, registrationKey);
  }
});
