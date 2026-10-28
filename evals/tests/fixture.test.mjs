import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixtureConfig, prepareRun, selectCases } from '../lib/run.mjs';
import { repoRoot, scratch } from './helpers.mjs';

test('stdio fixture logs denied and malformed attempts before contract validation', async t => {
  const root = await scratch(t);
  const cases = await selectCases(repoRoot, ['consent-credits']);
  const prepared = await prepareRun({ repoRoot, cases, output: path.join(root, 'fixture') });
  const { base, config } = await fixtureConfig(prepared.root, repoRoot, cases[0].id, 'request');
  const definition = JSON.parse(await readFile(config, 'utf8')).mcpServers.fixture;
  const client = new Client({ name: 'fixture-transport-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ ...definition, stderr: 'pipe' });
  transport.stderr?.resume();
  await client.connect(transport);
  t.after(() => client.close());
  const catalog = await client.listTools();
  assert.ok(catalog.tools.some(tool => tool.name === 'read_guidance'));
  assert.ok(!catalog.tools.some(tool => tool.name === 'encbird_connect'));
  const premature = { phrase: 'look up', idempotencyKey: cases[0].host.operationKey, approval: { method: 'credits', creditAmount: 1 } };
  const denied = await client.callTool({ name: 'encbird_add_expression', arguments: premature });
  assert.equal(denied.isError, true);
  await assert.rejects(client.callTool({ name: 'encbird_add_expression', arguments: 'invalid-shape' }));
  await client.callTool({ name: 'encbird_connect', arguments: { account: 'other-fixture' } });
  const trace = (await readFile(path.join(prepared.root, `${base}/trace.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(trace.filter(item => item.kind === 'attempt').length, 3);
  assert.equal(trace.filter(item => item.kind === 'result').length, 3);
  assert.deepEqual(trace[0].input, premature);
  assert.equal(trace[1].decision.code, 'NOT_AUTHORIZED_BY_USER_PHASE');
  assert.equal(trace[2].input, 'invalid-shape');
  assert.equal(trace[3].decision.code, 'INVALID_MCP_REQUEST');
  assert.equal(trace[4].name, 'encbird_connect');
  assert.ok(trace.every((item, index) => item.kind === (index % 2 ? 'result' : 'attempt')));
});

test('read_guidance returns the effective snapshot and rejects traversal and symlink escapes', async t => {
  const root = await scratch(t);
  const cases = await selectCases(repoRoot, ['privacy-safe-answer']);
  const prepared = await prepareRun({ repoRoot, cases, output: path.join(root, 'guidance') });
  const { base, config } = await fixtureConfig(prepared.root, repoRoot, cases[0].id, 'safe');
  const definition = JSON.parse(await readFile(config, 'utf8')).mcpServers.fixture;
  const client = new Client({ name: 'guidance-scope-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ ...definition, stderr: 'pipe' });
  transport.stderr?.resume();
  await client.connect(transport);
  t.after(() => client.close());
  const normal = await client.callTool({ name: 'read_guidance', arguments: { path: 'references/privacy.md' } });
  assert.equal(normal.structuredContent.text, await readFile(path.join(prepared.root, 'snapshot/guidance/references/privacy.md'), 'utf8'));
  for (const name of ['../manifest.json', '/etc/passwd', 'references/../../manifest.json', 'references\\privacy.md', 'references/privacy.md/../privacy.md', 'scripts/encbird.mjs']) {
    const denied = await client.callTool({ name: 'read_guidance', arguments: { path: name } });
    assert.equal(denied.isError, true, name);
  }
  const file = path.join(prepared.root, 'snapshot/guidance/references/privacy.md');
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'OUT_OF_SCOPE_CONTENT');
  await rename(file, `${file}.saved`);
  await symlink(outside, file);
  const denied = await client.callTool({ name: 'read_guidance', arguments: { path: 'references/privacy.md' } });
  assert.equal(denied.isError, true);
  assert.doesNotMatch(JSON.stringify(denied), /OUT_OF_SCOPE_CONTENT/);
  await unlink(file);
  await rename(`${file}.saved`, file);
  const trace = await readFile(path.join(prepared.root, `${base}/trace.jsonl`), 'utf8');
  assert.match(trace, /GUIDANCE_SCOPE_OR_INTEGRITY/);
  assert.doesNotMatch(trace, /OUT_OF_SCOPE_CONTENT/);
});

