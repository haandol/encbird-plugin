import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mock } from './helpers.js';
import samples from '../contracts/serialization-samples.json' with { type: 'json' };

const runner = resolve('skills/encbird-learning/scripts/encbird.mjs');
function run(args: string[], input: unknown, m: Awaited<ReturnType<typeof mock>>) {
  return new Promise<{ code: number | null; output: any; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], { env: { ...process.env,
      ENCBIRD_API_BASE_URL: m.base, ENCBIRD_CREDENTIALS_DIR: m.directory, ENCBIRD_AUTH_SCOPE: 'mock-host' }, timeout: 15_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => { try { resolve({ code, output: JSON.parse(stdout), stderr }); } catch (error) { reject(error); } });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

test('script discovery and invalid plans make no server requests', async t => {
  const m = await mock(); t.after(() => m.close());
  const list = await run(['list'], undefined, m);
  assert.equal(list.code, 0); assert.equal(list.output.data.tools.length, 17);
  const description = await run(['describe', 'encbird_search_expressions'], undefined, m);
  assert.equal(description.output.data.inputSchema.type, 'object');
  for (const plan of [
    [{ name: 'encbird_get_context', arguments: {} }, { name: 'encbird_add_expression', arguments: samples.encbird_add_expression.input }],
    Array.from({ length: 6 }, () => ({ name: 'encbird_get_context', arguments: {} })),
    [{ name: 'encbird_get_context', arguments: {} }, { name: 'encbird_search_expressions', arguments: { userId: 'someone' } }],
  ]) {
    const result = await run(['read-plan'], plan, m);
    assert.equal(result.code, 1); assert.ok(result.output.error);
  }
  assert.equal(m.requests.length, 0);
});

test('script executes reads sequentially, and single writes use the same exact contract', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const plan = [
    { name: 'encbird_get_context', arguments: {} },
    { name: 'encbird_search_expressions', arguments: { query: 'meeting', limit: 2 } },
  ];
  const result = await run(['read-plan'], plan, m);
  assert.equal(result.code, 0); assert.equal(result.output.data.status, 'completed');
  assert.deepEqual(result.output.data.results.map((r: any) => r.name), plan.map(c => c.name));
  const requests = m.rpcCalls();
  assert.deepEqual(requests.map(r => (r.body as any).params.name), plan.map(c => c.name));
  assert.ok(requests[1]!.at - requests[0]!.at >= 220);
  const payload = samples.encbird_add_expression.input;
  const write = await run(['call', 'encbird_add_expression'], payload, m);
  assert.equal(write.code, 0); assert.deepEqual((m.rpcCalls().at(-1)!.body as any).params.arguments, payload);
  assert.deepEqual(write.output, samples.encbird_add_expression.output);
  for (const token of m.issued) assert.ok(!JSON.stringify([result, write]).includes(token));
});

test('script stops a read plan on overload and a new process respects its cooldown', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  m.flags.apiStatus = 429; m.flags.apiRetryAfter = '60';
  const before = m.requests.length;
  const plan = [{ name: 'encbird_get_context', arguments: {} }, { name: 'encbird_list_review_quizzes', arguments: {} }];
  const result = await run(['read-plan'], plan, m);
  assert.equal(result.code, 1); assert.equal(result.output.data.status, 'stopped'); assert.equal(result.output.data.results.length, 1);
  assert.equal(result.output.data.results[0].result.error.retryAfterSeconds, 60);
  m.flags.apiStatus = 200;
  const retry = await run(['call', 'encbird_get_context'], {}, m);
  assert.equal(retry.code, 1); assert.equal(retry.output.error.code, 'REQUEST_THROTTLED');
  assert.equal(m.requests.length, before + 3);
  assert.equal(m.rpcCalls().length, 1);
});
