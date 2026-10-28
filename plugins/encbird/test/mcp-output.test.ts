import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { errorOutputSchema, withErrorOutputSchemas } from '../src/mcp-output.js';
import { LearningTools } from '../src/tools.js';
import { Secrets, SafeError } from '../src/errors.js';
import openapi from '../contracts/openapi.json' with { type: 'json' };
import samples from '../contracts/serialization-samples.json' with { type: 'json' };

const withoutDescriptions = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'description').map(([key, item]) => [key, withoutDescriptions(item)]));
  return value;
};

test('the structured error description matches the existing public failure envelope', () => {
  const declared = openapi.paths['/expressions'].post.responses.default.content['application/json'].schema;
  assert.deepEqual(withoutDescriptions(errorOutputSchema), withoutDescriptions(declared));
});

test('MCP discovery accepts either existing success data or a sanitized error without changing canonical schemas', () => {
  const tools = new LearningTools();
  const original = structuredClone(tools.list());
  const advertised = withErrorOutputSchemas(tools.list());
  const ajv = new Ajv2020({ strict: true });
  for (const tool of advertised) {
    if (!tool.outputSchema) continue;
    const validate = ajv.compile(tool.outputSchema);
    assert.ok(validate(samples[tool.name as keyof typeof samples].output), tool.name);
    assert.ok(validate({ error: { code: 'NOT_ENOUGH_CREDIT', message: 'Insufficient credits.' } }), tool.name);
    assert.ok(validate({ error: { code: 'RATE_LIMITED', message: 'Wait.', retryAfterSeconds: 90 } }), tool.name);
    assert.equal(validate({ data: {}, error: { code: 'FAIL', message: 'Ambiguous result.' } }), false);
    assert.equal(validate({ error: { code: 'RATE_LIMITED', message: 'Wait.', retryAfterSeconds: 0 } }), false);
    assert.equal(validate({ error: { code: 'FAIL', message: 'Private details.', accessToken: 'never-allowed' } }), false);
  }
  assert.deepEqual(tools.list(), original);
});

test('error-inclusive discovery never turns an error-shaped service success into valid learning data', async () => {
  const tools = new LearningTools();
  withErrorOutputSchemas(tools.list());
  const auth = {
    secrets: new Secrets(), connect: async () => ({}), disconnect: async () => ({ data: { status: 'disconnected' } }),
    callLearningTool: async () => ({ error: { code: 'NOT_ENOUGH_CREDIT', message: 'Wrong success envelope.' } }),
  };
  await assert.rejects(tools.call(auth, 'encbird_get_context', {}), (error: unknown) => error instanceof SafeError && error.code === 'INVALID_RESPONSE');
});
