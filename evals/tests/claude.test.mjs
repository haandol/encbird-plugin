import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { claudeArguments, invokeClaude, providerEnvironment, runChild } from '../lib/claude.mjs';
import { scratch } from './helpers.mjs';

test('only explicitly selected provider authentication reaches the CLI environment', () => {
  const source = { ANTHROPIC_API_KEY: 'fake-key', AWS_ACCESS_KEY_ID: 'fake-aws', AWS_SECRET_ACCESS_KEY: 'fake-secret', AWS_REGION: 'test-region', AWS_PROFILE: 'must-not-inherit', CLAUDE_CODE_OAUTH_TOKEN: 'must-not-inherit', GITHUB_TOKEN: 'must-not-inherit', ENCBIRD_API_BASE_URL: 'must-not-inherit', CLAUDE_CODE_USE_VERTEX: '1' };
  const anthropic = providerEnvironment('anthropic', source, 'fixture-config');
  assert.equal(anthropic.ANTHROPIC_API_KEY, 'fake-key');
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'ENCBIRD_API_BASE_URL', 'CLAUDE_CODE_USE_VERTEX']) assert.equal(anthropic[name], undefined);
  const bedrock = providerEnvironment('bedrock', { ...source, AWS_PROFILE: undefined }, 'fixture-config');
  assert.equal(bedrock.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(bedrock.AWS_ACCESS_KEY_ID, 'fake-aws');
  assert.equal(bedrock.ANTHROPIC_API_KEY, undefined);
  assert.equal(bedrock.AWS_PROFILE, undefined);
  assert.throws(() => providerEnvironment('anthropic', { CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth' }, 'fixture-config'), /MISSING_EXPLICIT_PROVIDER_AUTH/);
  assert.throws(() => providerEnvironment('bedrock', { AWS_REGION: 'region', AWS_PROFILE: 'profile' }, 'fixture-config'), /MISSING_EXPLICIT_PROVIDER_AUTH/);
});

test('an explicitly selected Bedrock profile wins without reading conflicting credential values', () => {
  const source = { AWS_PROFILE: 'selected-profile', AWS_DEFAULT_PROFILE: 'other-profile', AWS_REGION: 'fixture-region', HOME: '/fixture/operator', AWS_CONFIG_FILE: '/fixture/config', AWS_SHARED_CREDENTIALS_FILE: '/fixture/credentials' };
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_API_KEY']) Object.defineProperty(source, key, { get() { throw new Error('Conflicting credential must not be read'); } });
  const env = providerEnvironment('bedrock', source, '/fixture/isolated-claude');
  assert.equal(env.AWS_PROFILE, 'selected-profile');
  assert.equal(env.AWS_DEFAULT_PROFILE, undefined);
  assert.equal(env.HOME, source.HOME);
  assert.equal(env.AWS_CONFIG_FILE, source.AWS_CONFIG_FILE);
  assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, source.AWS_SHARED_CREDENTIALS_FILE);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/fixture/isolated-claude');
  assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true');
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_API_KEY']) assert.equal(env[key], undefined);
  const defaults = providerEnvironment('bedrock', { AWS_DEFAULT_PROFILE: 'default', AWS_DEFAULT_REGION: 'fixture-region', AWS_CONFIG_FILE: '/not-read/config', AWS_SHARED_CREDENTIALS_FILE: '/not-read/credentials' }, '/fixture/isolated-claude');
  assert.equal(defaults.AWS_PROFILE, 'default', 'Normalize explicit AWS_DEFAULT_PROFILE for the CLI SDK');
  assert.equal(defaults.HOME, undefined);
  assert.throws(() => providerEnvironment('bedrock', { AWS_REGION: 'region', HOME: '/fixture/operator' }, 'fixture-config'), /MISSING_EXPLICIT_PROVIDER_AUTH/);
  assert.throws(() => providerEnvironment('bedrock', { AWS_PROFILE: 'default', HOME: '/fixture/operator' }, 'fixture-config'), /MISSING_EXPLICIT_PROVIDER_REGION/);
  assert.throws(() => providerEnvironment('bedrock', { AWS_PROFILE: 'default', AWS_REGION: 'region', AWS_CONFIG_FILE: 'relative-config' }, 'fixture-config'), /ABSOLUTE_PROVIDER_AUTH_PATH_REQUIRED/);
});

test('both target and judge arguments stay confined and preserve the selected model', () => {
  const target = claudeArguments({ config: 'fixture.json', model: 'explicit-target-model' });
  const judge = claudeArguments({ model: 'explicit-judge-model', schema: { type: 'object' } });
  for (const args of [target, judge]) {
    for (const flag of ['--bare', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence']) assert.ok(args.includes(flag));
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(!args.includes('--max-turns'), 'Undocumented turn flags are not a capability dependency');
  }
  assert.equal(target[target.indexOf('--allowedTools') + 1], 'mcp__fixture__*');
  assert.equal(target[target.indexOf('--model') + 1], 'explicit-target-model');
  assert.equal(judge[judge.indexOf('--model') + 1], 'explicit-judge-model');
  assert.equal(judge[judge.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.ok(!judge.includes('--allowedTools'));
});

test('timeout kills the whole child group even after its leader exits on SIGTERM', async t => {
  const root = await scratch(t);
  const heartbeat = path.join(root, 'heartbeat.txt');
  const parent = path.join(root, 'parent.mjs');
  const childCode = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); let n=0; setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(++n)),30);`;
  await writeFile(parent, `import { spawn } from 'node:child_process';\nspawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});\nprocess.on('SIGTERM',()=>process.exit(0));\nsetInterval(()=>{},1000);\n`);
  const result = await runChild(process.execPath, [parent], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 650, graceMs: 150 });
  assert.equal(result.failure, 'TIMEOUT');
  const stopped = await readFile(heartbeat, 'utf8');
  await delay(180);
  assert.equal(await readFile(heartbeat, 'utf8'), stopped, 'SIGKILL must still reach descendants after their leader closes');
});

test('spawn and output failures are bounded without exposing subprocess diagnostics', async t => {
  const root = await scratch(t);
  const missing = await runChild(path.join(root, 'missing-cli'), [], { cwd: root, env: {}, timeoutMs: 100 });
  assert.equal(missing.failure, 'SPAWN_FAILED');
  assert.ok(!Object.hasOwn(missing, 'stderr'));
  const noisy = await runChild(process.execPath, ['-e', "process.stderr.write('FAKE_SECRET'.repeat(10000)); setInterval(()=>{},1000)"], { cwd: root, env: {}, timeoutMs: 1000, maxOutputBytes: 1024 });
  assert.equal(noisy.failure, 'STDERR_LIMIT');
  assert.doesNotMatch(JSON.stringify(noisy), /FAKE_SECRET/);
});

test('an already cancelled run cannot launch another subprocess', async t => {
  const root = await scratch(t);
  const marker = path.join(root, 'must-not-exist');
  const result = await runChild(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], { cwd: root, env: {}, signal: AbortSignal.abort(), timeoutMs: 1000 });
  assert.equal(result.failure, 'CANCELLED');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('visible response bytes survive split UTF-8 chunks without retaining reasoning', async t => {
  const root = await scratch(t);
  const file = path.join(root, 'unicode-cli.mjs');
  const text = '정확한 답변 — café 🌿';
  const event = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_INTERNAL_TEXT' }, { type: 'text', text }] } });
  await writeFile(file, `#!${process.execPath}\nconst bytes = Buffer.from(${JSON.stringify(event + '\n')});\nconst split=bytes.indexOf(Buffer.from('정'))+1;\nprocess.stdout.write(bytes.subarray(0,split));\nsetTimeout(()=>{process.stdout.write(bytes.subarray(split));process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false})+'\\n');},20);\n`, { mode: 0o700 });
  const output = await invokeClaude({ selection: { executable: file, model: 'synthetic' }, env: { PATH: process.env.PATH }, cwd: root, prompt: 'Synthetic input', prefix: 'unicode', timeoutMs: 1000 });
  assert.equal(output.runtime.state, 'completed');
  assert.equal(output.visible[0].text, text);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_INTERNAL_TEXT/);
});
