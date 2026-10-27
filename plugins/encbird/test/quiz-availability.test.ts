import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LearningTools } from '../src/tools.js';
import { Secrets } from '../src/errors.js';
import samples from '../contracts/serialization-samples.json' with { type: 'json' };

function fixture() {
  let data: Record<string, unknown> = structuredClone(samples.encbird_get_expression.output.data);
  delete data.quizAvailability;
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls, data,
    auth: {
      secrets: new Secrets(),
      async connect() { throw new Error('Unexpected connection change'); },
      async disconnect() { throw new Error('Unexpected connection change'); },
      async callLearningTool(name: string, input: Record<string, unknown>) {
        calls.push({ name, input });
        return { data };
      },
    },
  };
}

test('ordinary detail reads preserve the detail-only response and make exactly one read', async () => {
  for (const input of [{ expressionId: 'owned' }, { expressionId: 'owned', includeQuizAvailability: false }]) {
    const f = fixture();
    const result = await new LearningTools().call(f.auth, 'encbird_get_expression', input);
    assert.deepEqual(result, { data: f.data });
    assert.equal(Object.hasOwn(result.data as object, 'quizAvailability'), false);
    assert.deepEqual(f.calls, [{ name: 'encbird_get_expression', input }]);
  }
});

test('explicit availability reads forward the option and preserve observed ready or not_ready', async () => {
  for (const status of ['ready', 'not_ready']) {
    const f = fixture(); f.data.quizAvailability = { status };
    const input = { expressionId: 'owned', includeQuizAvailability: true };
    assert.deepEqual(await new LearningTools().call(f.auth, 'encbird_get_expression', input), { data: f.data });
    assert.deepEqual(f.calls, [{ name: 'encbird_get_expression', input }]);
  }
});

test('missing or invented availability is not reported as a successful readiness check', async () => {
  for (const value of [undefined, { status: 'generating' }, { status: 'failed' }, { status: 'ready', count: 1 }]) {
    const f = fixture(); if (value !== undefined) f.data.quizAvailability = value;
    await assert.rejects(new LearningTools().call(f.auth, 'encbird_get_expression', {
      expressionId: 'owned', includeQuizAvailability: true,
    }), { code: 'INVALID_RESPONSE' });
    assert.equal(f.calls.length, 1);
  }
});

test('availability options must be actual booleans before any request', async () => {
  for (const value of ['true', 1, null]) {
    const f = fixture();
    await assert.rejects(new LearningTools().call(f.auth, 'encbird_get_expression', {
      expressionId: 'owned', includeQuizAvailability: value,
    }), { code: 'INVALID_ARGUMENTS' });
    assert.equal(f.calls.length, 0);
  }
});
