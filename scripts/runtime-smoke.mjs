#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertUnchanged, requireCommittedSource, requireContainer, requireNoPublicationCredentials,
  sourceState, verificationEnvironment,
} from './check-source.mjs';

async function copyInstallation(source, target) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error('Installed runtime smoke does not follow symlinks out of the package.');
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(source)) {
      if (name === 'node_modules') throw new Error('Installed runtime must not contain node_modules.');
      await copyInstallation(join(source, name), join(target, name));
    }
    return;
  }
  if (!info.isFile()) throw new Error('Installed runtime contains a special file.');
  await copyFile(source, target);
}

function startProcess(file, args, cwd, env, timeoutMs) {
  const child = spawn(process.execPath, [file, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let output = '', errorOutput = '', failure;
  let lineBuffer = '';
  const waiting = new Map();
  const kill = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const fail = error => {
    failure ??= error;
    for (const pending of waiting.values()) pending.reject(failure);
    waiting.clear();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('data', chunk => {
    output += chunk;
    lineBuffer += chunk;
    if (output.length > 2 * 1024 * 1024) { fail(new Error('Runtime output exceeded 2 MiB.')); kill('SIGKILL'); return; }
    let newline;
    while ((newline = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); }
      catch { fail(new Error('Runtime emitted invalid JSON.')); continue; }
      const pending = waiting.get(value.id);
      if (pending) {
        waiting.delete(value.id);
        if (value.jsonrpc !== '2.0' || value.error || !value.result) pending.reject(new Error('MCP request failed.'));
        else pending.resolve(value.result);
      }
    }
  });
  child.stderr.on('data', chunk => {
    errorOutput += chunk;
    if (errorOutput.length > 64 * 1024) { fail(new Error('Runtime stderr exceeded 64 KiB.')); kill('SIGKILL'); }
  });
  const closed = new Promise(resolveClose => child.once('close', (code, signal) => {
    if (waiting.size || code !== 0) fail(new Error(`Runtime closed before a response (exit ${code}, signal ${signal}): ${errorOutput.slice(0, 1000)}`));
    resolveClose({ code, signal });
  }));
  const limit = setTimeout(() => { fail(new Error(`Runtime timed out after ${timeoutMs} ms.`)); kill('SIGKILL'); }, timeoutMs);
  const finish = async () => {
    try {
      const result = await closed;
      if (failure || result.code !== 0) throw failure ?? new Error(`Runtime failed: ${errorOutput.slice(0, 1000)}`);
      assert.equal(errorOutput, '', 'Installed entry point wrote to stderr');
      return output;
    } finally { clearTimeout(limit); }
  };
  return {
    request(id, method, params) {
      if (failure) return Promise.reject(failure);
      const response = new Promise((resolveResponse, reject) => waiting.set(id, { resolve: resolveResponse, reject }));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
      return response;
    },
    notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
    async finish() { child.stdin.end(); return finish(); },
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) {
        kill('SIGTERM');
        const escalation = setTimeout(() => kill('SIGKILL'), 1000);
        try { await closed; } finally { clearTimeout(escalation); }
      }
      clearTimeout(limit);
    },
  };
}

export async function smokeInstalledPlugin(root, { env, timeoutMs = 10_000 } = {}) {
  requireContainer();
  requireNoPublicationCredentials();
  const scratch = await mkdtemp(join(tmpdir(), 'encbird-installed-'));
  const isolated = env ? null : await verificationEnvironment();
  const processes = [];
  try {
    const installed = join(scratch, 'plugins/encbird');
    await mkdir(installed, { recursive: true });
    for (const path of ['package.json', 'dist', 'contracts', 'skills']) {
      await copyInstallation(join(root, 'plugins/encbird', path), join(installed, path));
    }
    for (let path = installed; ; path = dirname(path)) {
      try { await lstat(join(path, 'node_modules')); throw new Error('Runtime isolation has an ancestor node_modules directory.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (dirname(path) === path) break;
    }
    const childEnv = {
      ...(env ?? isolated.env),
      ENCBIRD_API_BASE_URL: 'http://127.0.0.1:1/v1/mcp-learning',
      ENCBIRD_CREDENTIALS_DIR: join(scratch, 'credentials'), ENCBIRD_AUTH_SCOPE: 'installed-smoke',
    };
    delete childEnv.NODE_PATH;
    delete childEnv.NODE_OPTIONS;
    requireNoPublicationCredentials(childEnv);
    const launch = (file, args = []) => {
      const process = startProcess(join(installed, file), args, scratch, childEnv, timeoutMs);
      processes.push(process);
      return process;
    };
    const server = launch('dist/index.js');
    const initialized = await server.request(1, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'installed-smoke', version: '1.0.0' },
    });
    assert.ok(initialized.protocolVersion && initialized.serverInfo && initialized.capabilities?.tools, 'MCP initialization must advertise tools');
    server.notify('notifications/initialized');
    const { tools } = await server.request(2, 'tools/list');
    assert.equal(tools?.length, 14, 'Installed MCP must expose all 14 tools');
    const contract = JSON.parse(await readFile(join(installed, 'contracts/tools.json'), 'utf8'));
    const names = [...contract.tools.map(tool => tool.name), 'encbird_connect', 'encbird_disconnect'].sort();
    assert.deepEqual(tools.map(tool => tool.name).sort(), names);
    await server.finish();
    const cli = 'skills/encbird-learning/scripts/encbird.mjs';
    const listed = JSON.parse(await launch(cli, ['list']).finish());
    assert.equal(listed.data?.tools?.length, 14, 'Installed skill CLI must expose all 14 tools');
    assert.deepEqual(listed.data.tools.map(tool => tool.name).sort(), names);
    const described = JSON.parse(await launch(cli, ['describe', 'encbird_add_expression']).finish());
    assert.deepEqual(described.data, contract.tools.find(tool => tool.name === 'encbird_add_expression'));
    console.log(`Installed MCP initialize/tools/list (14) and skill CLI list/describe passed without node_modules on Node ${process.versions.node}.`);
  } finally {
    await Promise.all(processes.map(process => process.dispose()));
    await rm(scratch, { recursive: true, force: true });
    await isolated?.cleanup();
  }
}

async function main() {
  requireContainer();
  requireNoPublicationCredentials();
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--committed')) throw new Error('Usage: node scripts/runtime-smoke.mjs [--committed]');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const before = await sourceState(root);
  if (args.length) await requireCommittedSource(root, before);
  console.log(`Checking ${args.length ? 'committed' : 'working-tree'} installation before any rebuild.`);
  await smokeInstalledPlugin(root);
  assertUnchanged(before, await sourceState(root));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}
