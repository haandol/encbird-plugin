import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Auth } from '../src/auth.js';
import { LearningTools } from '../src/tools.js';
import { SafeError, Secrets, uncertainOutcome } from '../src/errors.js';
import samples from '../contracts/serialization-samples.json' with { type: 'json' };

function authDouble(output?: Record<string, unknown>) {
  const calls: { name: string; input?: Record<string, unknown> }[] = [];
  const auth: Pick<Auth, 'connect' | 'disconnect' | 'callLearningTool' | 'secrets'> = {
    secrets: new Secrets(),
    async connect() {
      assert.equal(this, auth); calls.push({ name: 'encbird_connect' });
      return { data: { status: 'authentication_pending' } };
    },
    async disconnect() {
      assert.equal(this, auth); calls.push({ name: 'encbird_disconnect' });
      return { data: { status: 'disconnected' } };
    },
    async callLearningTool(name, input) {
      assert.equal(this, auth); calls.push({ name, input });
      return output ?? (samples as Record<string, { output: Record<string, unknown> }>)[name]!.output;
    },
  };
  return { auth, calls };
}

test('tool input validation rejects invalid arguments before delegating or making a request', async t => {
  const f = authDouble(); const tools = new LearningTools();
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  const cases: [string, Record<string, unknown>, string][] = [
    ['unknown', {}, 'TOOL_UNAVAILABLE'],
    ['encbird_connect', { userId: 'other' }, 'INVALID_ARGUMENTS'],
    ['encbird_disconnect', { token: 'not-allowed' }, 'INVALID_ARGUMENTS'],
    ['encbird_search_expressions', {}, 'INVALID_ARGUMENTS'],
    ['encbird_list_expressions', { limit: 0 }, 'INVALID_ARGUMENTS'],
    ['encbird_get_expression', { expressionId: '..' }, 'INVALID_ARGUMENTS'],
    ['encbird_add_expression', { ...samples.encbird_add_expression.input, userId: 'other' }, 'INVALID_ARGUMENTS'],
    ['encbird_submit_quiz_result', { ...samples.encbird_submit_quiz_result.input, rating: 5 }, 'INVALID_ARGUMENTS'],
  ];
  for (const [name, input, code] of cases) await assert.rejects(tools.call(f.auth, name, input), { code });
  assert.deepEqual(f.calls, []); assert.equal(fetch.mock.callCount(), 0);
});

test('tool privacy and candidate evidence checks run before delegation', async t => {
  const f = authDouble(); const tools = new LearningTools();
  f.auth.secrets.add('fixture-secret');
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  await assert.rejects(tools.call(f.auth, 'encbird_search_expressions', { query: 'fixture-secret' }), { code: 'PRIVACY_FILTERED' });
  const privateInput = structuredClone(samples.encbird_submit_memory_candidates.input);
  privateInput.messages[0]!.content = 'learner@example.com';
  await assert.rejects(tools.call(f.auth, 'encbird_submit_memory_candidates', privateInput), { code: 'PRIVACY_FILTERED' });
  const evidence = structuredClone(samples.encbird_submit_memory_candidates.input);
  evidence.candidates[0]!.evidenceIds = ['missing-user-message'];
  await assert.rejects(tools.call(f.auth, 'encbird_submit_memory_candidates', evidence), { code: 'INVALID_ARGUMENTS' });
  assert.deepEqual(f.calls, []); assert.equal(fetch.mock.callCount(), 0);
});

test('external UTF-8 byte limits apply to Korean content before delegation or HTTP', async t => {
  const f = authDouble(); const tools = new LearningTools();
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  const input = structuredClone(samples.encbird_submit_memory_candidates.input); input.messages[0]!.content = '한'.repeat(1400);
  await assert.rejects(tools.call(f.auth, 'encbird_submit_memory_candidates', input), { code: 'INVALID_ARGUMENTS' });
  assert.deepEqual(f.calls, []); assert.equal(fetch.mock.callCount(), 0);
});

test('all twelve tools forward the original name and input once and return the validated output unchanged', async t => {
  const f = authDouble(); const tools = new LearningTools();
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  for (const [name, sample] of Object.entries(samples)) {
    const input = structuredClone(sample.input);
    const before = structuredClone(input);
    assert.equal(await tools.call(f.auth, name, input), sample.output);
    assert.equal(f.calls.at(-1)!.name, name); assert.equal(f.calls.at(-1)!.input, input);
    assert.deepEqual(input, before);
  }
  assert.equal(f.calls.length, 12); assert.equal(fetch.mock.callCount(), 0);
});

test('each data tool rejects malformed success payloads and unexpected private fields without a second delegation', async () => {
  const tools = new LearningTools();
  const f = authDouble({ data: { privateEmail: 'hidden@example.com', unexpected: true } });
  for (const [name, sample] of Object.entries(samples)) {
    const before = f.calls.length;
    await assert.rejects(tools.call(f.auth, name, sample.input), { code: 'INVALID_RESPONSE',
      message: `EncBird returned data that does not match the installed output schema. Ask the operator to align plugin and service versions before retrying. ${uncertainOutcome}` });
    assert.equal(f.calls.length, before + 1);
  }
});

test('connect and disconnect delegate to their matching method with the original receiver', async () => {
  const f = authDouble(); const tools = new LearningTools();
  assert.deepEqual(await tools.call(f.auth, 'encbird_connect'), { data: { status: 'authentication_pending' } });
  assert.deepEqual(await tools.call(f.auth, 'encbird_disconnect'), { data: { status: 'disconnected' } });
  assert.deepEqual(f.calls, [{ name: 'encbird_connect' }, { name: 'encbird_disconnect' }]);
});

test('tool delegation propagates the original error without retry or output validation', async t => {
  const f = authDouble(); const tools = new LearningTools();
  const failure = new SafeError('RATE_LIMITED', 'fixture failure', 45);
  const call = t.mock.method(f.auth, 'callLearningTool', async () => { throw failure; });
  await assert.rejects(tools.call(f.auth, 'encbird_get_context'), error => error === failure);
  assert.equal(call.mock.callCount(), 1);
  for (const [name, method] of [['encbird_connect', 'connect'], ['encbird_disconnect', 'disconnect']] as const) {
    const delegate = t.mock.method(f.auth, method, async () => { throw failure; });
    await assert.rejects(tools.call(f.auth, name), error => error === failure);
    assert.equal(delegate.mock.callCount(), 1);
  }
});
