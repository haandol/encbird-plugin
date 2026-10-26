import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tempDirectory, mock } from './helpers.js';
import { CredentialStore } from '../src/store.js';
import samples from '../contracts/serialization-samples.json' with { type: 'json' };

test('bundled MCP process initializes, lists allowlisted tools and returns structured plus identical text output', async t => {
  const dir = await tempDirectory(); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'standalone'));
  await cp('dist/index.js', join(dir, 'standalone/index.mjs'));
  let stderr = '';
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(dir, 'standalone/index.mjs')],
    cwd: dir, env: { PATH: process.env.PATH ?? '', ENCBIRD_CREDENTIALS_DIR: join(dir, 'credentials'), ENCBIRD_API_BASE_URL: 'http://evil.example' }, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'smoke-host', version: '1.0.0' });
  t.after(() => client.close()); await client.connect(transport);
  const { tools } = await client.listTools(); assert.equal(tools.length, 14); assert.ok(tools.filter(t => !t.name.endsWith('connect')).every(t => t.outputSchema));
  const result = await client.callTool({ name: 'encbird_connect', arguments: {} });
  assert.equal((result.structuredContent as any).error.code, 'INVALID_CONFIG');
  assert.deepEqual(JSON.parse((result.content as any)[0].text), result.structuredContent); assert.equal(result.isError, true);
  await client.close(); assert.equal(stderr, '');
  const source = await readFile(resolve('dist/index.js'), 'utf8');
  assert.ok(source.includes('encbird_connect')); assert.ok(!/\/Users\/[^/]+\/git\//.test(source));
});

test('bundled MCP returns a successful disconnect result without bootstrapping or network access', async t => {
  const dir = await tempDirectory(); t.after(() => rm(dir, { recursive: true, force: true }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')],
    env: { PATH: process.env.PATH ?? '', ENCBIRD_CREDENTIALS_DIR: dir, ENCBIRD_API_BASE_URL: 'http://127.0.0.1:1/v1/mcp-learning' }, stderr: 'pipe' });
  const client = new Client({ name: 'smoke-clean-host', version: '1.0.0' }); t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({ name: 'encbird_disconnect', arguments: {} });
  assert.deepEqual(result.structuredContent, { data: { status: 'disconnected' } });
  assert.deepEqual(JSON.parse((result.content as any)[0].text), result.structuredContent); assert.notEqual(result.isError, true);
});

test('bundled stdio MCP relays all twelve tools through remote MCP using contract serialization samples', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const scoped = new CredentialStore(m.base, 'smoke-data-host', m.secrets, m.directory);
  const credentials = await m.read(); await scoped.withLock(tx => tx.save(credentials));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')],
    env: { PATH: process.env.PATH ?? '', ENCBIRD_CREDENTIALS_DIR: m.directory, ENCBIRD_API_BASE_URL: m.base }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
  const client = new Client({ name: 'smoke-data-host', version: '1.0.0' }); t.after(() => client.close()); await client.connect(transport);
  for (const [name, sample] of Object.entries(samples)) {
    const result = await client.callTool({ name, arguments: sample.input });
    assert.notEqual(result.isError, true, name); assert.deepEqual(result.structuredContent, sample.output);
    assert.deepEqual(JSON.parse((result.content as any)[0].text), sample.output);
  }
  assert.equal(m.rpcCalls().length, 12);
  assert.ok(m.requests.filter(r => r.path === '/mcp').every(r => r.method === 'POST'));
  await client.close(); assert.equal(stderr, '');
});

test('bundled stdio delivers actionable credit failures identically in text and structured results without extra HTTP', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  const scoped = new CredentialStore(m.base, 'error-host', m.secrets, m.directory);
  await scoped.withLock(async tx => tx.save(await m.read()));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')],
    env: { PATH: process.env.PATH ?? '', ENCBIRD_CREDENTIALS_DIR: m.directory, ENCBIRD_API_BASE_URL: m.base }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
  const client = new Client({ name: 'error-host', version: '1.0.0' }); t.after(() => client.close()); await client.connect(transport);
  const args = { phrase: 'take a break', idempotencyKey: 'approved-key', approval: { method: 'credits', creditAmount: 1 } };
  for (const status of [402, 403, 503, 401]) {
    await scoped.withLock(async tx => { const value = (await tx.load())!; delete value.traffic; await tx.save(value); });
    m.flags.apiStatus = status;
    m.flags.apiBody = { error: { code: 'NOT_ENOUGH_CREDIT', message: `Copy tokens ${m.issued.join(' ')}; provider detail; retry with a new key` } };
    const before = m.requests.length; const counts = { ...m.counts };
    const result = await client.callTool({ name: 'encbird_add_expression', arguments: args });
    assert.equal(result.isError, true); assert.deepEqual(JSON.parse((result.content as any)[0].text), result.structuredContent);
    const error = (result.structuredContent as any).error;
    assert.deepEqual(Object.keys(error).sort(), status === 503 ? ['code', 'message', 'retryAfterSeconds'] : ['code', 'message']);
    assert.equal(error.code, status === 401 ? 'AUTH_REQUIRED' : 'NOT_ENOUGH_CREDIT');
    if (status === 401) { assert.match(error.message, /authentication.*refresh first/); assert.doesNotMatch(error.message, /Insufficient credits/); }
    else { assert.match(error.message, /Insufficient credits.*top up credits in EncBird/); assert.match(error.message, /unchanged balance.*original operation key/); }
    for (const token of m.issued) assert.ok(!JSON.stringify(result).includes(token));
    assert.doesNotMatch(JSON.stringify(result), /provider detail|Copy tokens/);
    assert.equal(m.requests.length, before + 3); assert.deepEqual(m.counts, counts);
    assert.deepEqual((m.rpcCalls().at(-1)!.body as any).params.arguments, args);
  }
  await client.close(); assert.equal(stderr, '');
});
