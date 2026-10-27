import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LearningTools } from '../src/tools.js';
import { Secrets } from '../src/errors.js';
import { filterExternalInput } from '../src/privacy.js';
import cases from './fixtures/privacy-identifiers.json' with { type: 'json' };
import samples from '../contracts/serialization-samples.json' with { type: 'json' };

const tools = new LearningTools();
function fixture() {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    auth: {
      secrets: new Secrets(),
      async connect() { throw new Error('Unexpected connection change'); },
      async disconnect() { throw new Error('Unexpected connection change'); },
      async callLearningTool(_name: string, input: Record<string, unknown>) {
        calls.push(input);
        return samples.encbird_submit_memory_candidates.output;
      },
    },
  };
}

test('synthetic identifying and ordinary evidence follows the same candidate and message boundary', async t => {
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      for (const location of ['candidate', 'message'] as const) {
        const f = fixture();
        const input = structuredClone(samples.encbird_submit_memory_candidates.input);
        if (location === 'candidate') input.candidates[0]!.content = entry.text;
        else input.messages[0]!.content = entry.text;
        const original = structuredClone(input);
        if (entry.reject) {
          await assert.rejects(tools.call(f.auth, 'encbird_submit_memory_candidates', input),
            (error: any) => error.code === 'PRIVACY_FILTERED' && !error.message.includes(entry.text));
          assert.equal(f.calls.length, 0);
        } else {
          assert.deepEqual(await tools.call(f.auth, 'encbird_submit_memory_candidates', input),
            samples.encbird_submit_memory_candidates.output);
          assert.deepEqual(f.calls, [original]);
        }
        assert.deepEqual(input, original);
      }
    });
  }
});

test('numeric identities and precise timestamps remain unchanged', async () => {
  const f = fixture();
  const input = structuredClone(samples.encbird_submit_memory_candidates.input);
  input.operationKey = '123456789012345'; input.sourceSessionId = '1234567890';
  input.candidates[0]!.id = '12345678901'; input.messages[0]!.id = '2025550100';
  input.candidates[0]!.evidenceIds = ['2025550100'];
  input.candidates[0]!.observedAt = input.messages[0]!.observedAt = '2026-10-01T09:12:30.123456789+09:00';
  const original = structuredClone(input);
  await tools.call(f.auth, 'encbird_submit_memory_candidates', input);
  assert.deepEqual(f.calls, [original]); assert.deepEqual(input, original);
});

test('existing secrets remain blocked across tools and control rejection remains local', () => {
  const secrets = new Secrets(); secrets.add('synthetic-credential');
  for (const name of ['encbird_search_expressions', 'encbird_submit_memory_candidates']) {
    assert.throws(() => filterExternalInput(name, { content: 'synthetic-credential' }, secrets), { code: 'PRIVACY_FILTERED' });
  }
  for (const text of ['contact@example.test', 'password: synthetic', 'Safe\u0085text', 'Safe\u001ftext']) {
    assert.throws(() => filterExternalInput('encbird_submit_memory_candidates', { content: text }, secrets), { code: 'PRIVACY_FILTERED' });
  }
});
