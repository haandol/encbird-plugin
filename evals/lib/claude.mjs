// Isolation flags and process-group cleanup adapted from alps-writer-plugins.
// See ../NOTICE and ../LICENSE.alps-writer for the MIT attribution.
import { spawn } from 'node:child_process';
import { access, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const requiredFlags = ['--bare', '--disable-slash-commands', '--tools', '--strict-mcp-config', '--mcp-config', '--no-session-persistence', '--allowedTools', '--model', '--output-format', '--verbose', '--json-schema'];
const providers = {
  anthropic: { required: [['ANTHROPIC_API_KEY']], optional: [] },
  bedrock: { required: [['AWS_REGION', 'AWS_DEFAULT_REGION'], ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID']], optional: ['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'], switch: 'CLAUDE_CODE_USE_BEDROCK' },
  vertex: { required: [['ANTHROPIC_VERTEX_PROJECT_ID'], ['CLOUD_ML_REGION'], ['GOOGLE_APPLICATION_CREDENTIALS']], optional: [], switch: 'CLAUDE_CODE_USE_VERTEX' },
  foundry: { required: [['ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL'], ['ANTHROPIC_FOUNDRY_API_KEY']], optional: [], switch: 'CLAUDE_CODE_USE_FOUNDRY' },
};

export function baseEnvironment(configDir) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    AWS_EC2_METADATA_DISABLED: 'true',
  };
}

export function providerEnvironment(provider, source, configDir) {
  const spec = providers[provider];
  if (!spec) throw new Error('UNSUPPORTED_PROVIDER');
  const present = key => typeof source[key] === 'string' && source[key].trim().length > 0;
  if (provider === 'bedrock' && (present('AWS_PROFILE') || present('AWS_DEFAULT_PROFILE'))) {
    if (!present('AWS_REGION') && !present('AWS_DEFAULT_REGION')) throw new Error('MISSING_EXPLICIT_PROVIDER_REGION');
    if (!['HOME', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE'].some(present)) throw new Error('MISSING_EXPLICIT_PROVIDER_AUTH');
    const env = baseEnvironment(configDir);
    env.AWS_PROFILE = present('AWS_PROFILE') ? source.AWS_PROFILE : source.AWS_DEFAULT_PROFILE;
    env.CLAUDE_CODE_USE_BEDROCK = '1';
    env.AWS_SDK_LOAD_CONFIG = '1';
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION', 'HOME', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) {
      if (!present(key)) continue;
      if (['HOME', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE'].includes(key) && !path.isAbsolute(source[key])) throw new Error('ABSOLUTE_PROVIDER_AUTH_PATH_REQUIRED');
      env[key] = source[key];
    }
    return env;
  }
  for (const group of spec.required) if (!group.some(present)) throw new Error('MISSING_EXPLICIT_PROVIDER_AUTH');
  if (provider === 'bedrock' && !present('AWS_BEARER_TOKEN_BEDROCK') && !present('AWS_SECRET_ACCESS_KEY')) throw new Error('MISSING_EXPLICIT_PROVIDER_AUTH');
  const env = baseEnvironment(configDir);
  for (const key of [...spec.required.flat(), ...spec.optional]) if (present(key)) env[key] = source[key];
  if (provider === 'bedrock' && present('AWS_BEARER_TOKEN_BEDROCK')) {
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_SESSION_TOKEN;
  }
  if (spec.switch) env[spec.switch] = '1';
  return env;
}

export function validateSelection(selection) {
  if (!selection || typeof selection.executable !== 'string' || !path.isAbsolute(selection.executable) || typeof selection.model !== 'string' || !selection.model.trim() || selection.model.length > 300 || !Object.hasOwn(providers, selection.provider)) throw new Error('EXPLICIT_CLI_MODEL_PROVIDER_REQUIRED');
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('PROCESS_GROUP_ISOLATION_UNSUPPORTED');
}

export async function runChild(executable, args, { cwd, env, input = '', timeoutMs = 90_000, maxOutputBytes = 1024 * 1024, onStdout, signal, graceMs = 250 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 128 || maxOutputBytes > 4 * 1024 * 1024) throw new Error('INVALID_PROCESS_LIMIT');
  if (signal?.aborted) return { exitCode: null, failure: 'CANCELLED', stdoutBytes: 0, stderrBytes: 0, elapsedMs: 0 };
  const started = Date.now();
  return new Promise(resolve => {
    let child;
    let failure = null;
    let exitCode = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let cleanup;
    let settled = false;
    let timer;
    let hardDeadline;
    function killGroup(signame) {
      if (!child?.pid) return;
      try { process.kill(-child.pid, signame); } catch { /* Group has already exited. */ }
    }
    function stop(reason) {
      failure ??= reason;
      killGroup('SIGTERM');
      // Keep this timer alive after the leader exits: its MCP child may remain.
      cleanup ??= new Promise(done => setTimeout(() => { killGroup('SIGKILL'); done(); }, graceMs));
      hardDeadline ??= setTimeout(() => { child?.stdout?.destroy(); child?.stderr?.destroy(); void finish(); }, graceMs + 1000);
    }
    const abort = () => stop('CANCELLED');
    async function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      killGroup('SIGTERM');
      cleanup ??= new Promise(done => setTimeout(() => { killGroup('SIGKILL'); done(); }, graceMs));
      await cleanup;
      clearTimeout(hardDeadline);
      resolve({ exitCode, failure, stdoutBytes, stderrBytes, elapsedMs: Date.now() - started });
    }
    try {
      child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false });
    } catch { failure = 'SPAWN_FAILED'; void finish(); return; }
    timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) { stop('OUTPUT_LIMIT'); return; }
      try { onStdout?.(chunk); } catch { stop('INVALID_OUTPUT'); }
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) stop('STDERR_LIMIT');
    });
    child.on('error', () => { failure ??= 'SPAWN_FAILED'; void finish(); });
    child.on('close', code => { exitCode = code; void finish(); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function preflight(selection, { cwd, timeoutMs = 10_000, signal } = {}) {
  validateSelection(selection);
  await access(selection.executable, constants.X_OK);
  if (!(await stat(selection.executable)).isFile()) throw new Error('INVALID_CLI_EXECUTABLE');
  await mkdir(path.join(cwd, 'config'), { recursive: true });
  const env = baseEnvironment(path.join(cwd, 'config'));
  const outputs = [];
  for (const flag of ['--version', '--help']) {
    let output = '';
    const result = await runChild(selection.executable, ['--bare', flag], { cwd, env, signal, timeoutMs, maxOutputBytes: 256 * 1024, onStdout: chunk => { output += chunk.toString('utf8'); } });
    if (result.failure || result.exitCode !== 0) throw new Error('CLI_CAPABILITY_PREFLIGHT_FAILED');
    outputs.push(output);
  }
  const version = outputs[0].trim().match(/^(2)\.(\d+)\.(\d+)\s+\(Claude Code\)$/);
  if (!version || Number(version[2]) < 1 || (Number(version[2]) === 1 && Number(version[3]) < 312)) throw new Error('UNSUPPORTED_CLAUDE_VERSION');
  for (const flag of requiredFlags) if (!outputs[1].split(/[\s,=<>[\]]+/).includes(flag)) throw new Error('MISSING_CLI_ISOLATION_CAPABILITY');
  return { version: `${version[1]}.${version[2]}.${version[3]}`, executable: path.basename(selection.executable), provider: selection.provider, model: selection.model, verifiedFlags: requiredFlags,
    kind: outputs[1].split(/\r?\n/).includes('ENCBIRD_EVAL_TEST_DOUBLE=1') ? 'deterministic-test-double' : 'operator-supplied-claude' };
}

export function claudeArguments({ config, model, schema }) {
  return ['--bare', '--disable-slash-commands', '-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--mcp-config', config ?? '{"mcpServers":{}}', '--no-session-persistence',
    ...(config ? ['--allowedTools', 'mcp__fixture__*'] : []), '--model', model, ...(schema ? ['--json-schema', JSON.stringify(schema)] : [])];
}

export async function invokeClaude({ selection, env, prompt, cwd, config, schema, prefix, timeoutMs, maxOutputBytes, signal, onVisible }) {
  let remainder = '';
  const decoder = new StringDecoder('utf8');
  let final = null;
  let resultCount = 0;
  const visible = [];
  const emit = text => {
    if (typeof text !== 'string' || !text) return;
    const entry = { id: `${prefix}.visible-${visible.length + 1}`, text };
    visible.push(entry);
    onVisible?.(entry);
  };
  function consume(line) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) for (const part of event.message.content) if (part.type === 'text') emit(part.text);
    if (event.type === 'result') {
      resultCount++;
      final = event;
      if (!event.is_error && typeof event.result === 'string' && event.result && !visible.some(item => item.text === event.result) && visible.map(item => item.text).join('') !== event.result) emit(event.result);
    }
  }
  const result = await runChild(selection.executable, claudeArguments({ config, model: selection.model, schema }), {
    cwd, env, input: prompt, timeoutMs, maxOutputBytes, signal,
    onStdout(chunk) {
      remainder += decoder.write(chunk);
      let split;
      while ((split = remainder.indexOf('\n')) >= 0) { const line = remainder.slice(0, split); remainder = remainder.slice(split + 1); consume(line); }
    },
  });
  try { remainder += decoder.end(); if (remainder.trim()) consume(remainder); } catch { result.failure ??= 'INVALID_OUTPUT'; }
  const complete = !result.failure && result.exitCode === 0 && resultCount === 1 && final && final.is_error === false && final.subtype === 'success' && (visible.length > 0 || (schema && final.structured_output));
  return {
    runtime: { state: complete ? 'completed' : 'error', ...result, failure: result.failure ?? (complete ? null : 'INCOMPLETE_CLI_RESULT') },
    visible,
    structured: final?.is_error === false ? final.structured_output ?? null : null,
    usage: final?.usage ? Object.fromEntries(Object.entries(final.usage).filter(([key, value]) => ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].includes(key) && Number.isFinite(value) && value >= 0)) : null,
    costUSD: Number.isFinite(final?.total_cost_usd) && final.total_cost_usd >= 0 ? final.total_cost_usd : null,
  };
}

