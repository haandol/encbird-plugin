import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'encbird-behavior-'));
  t.after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function writable(root) {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await writable(file); else await chmod(file, 0o600);
  }
}

export async function fakeCLI(root, options = {}) {
  const home = path.join(root, `cli-${options.label ?? 'default'}`);
  await mkdir(home);
  const file = path.join(home, 'claude-fixture.mjs');
  const auditFile = path.join(home, 'invocations.jsonl');
  await writeFile(file, `#!${process.execPath}\nimport { runFake } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'evals/tests/fixtures/fake-claude.mjs')).href)};\nawait runFake(${JSON.stringify({ ...options, auditFile })});\n`, { mode: 0o700 });
  return { file, auditFile };
}

export async function command(args, { environment = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'evals/run.mjs'), ...args], { cwd: repoRoot, env: { PATH: process.env.PATH, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('TEST_CLI_TIMEOUT')); }, timeoutMs);
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export async function live(root, fake, { model = 'agent-good', cases = [], judge, extra = [], environment = {} } = {}) {
  const output = path.join(root, `run-${Math.random().toString(36).slice(2)}`);
  const args = ['--live', '--cli', fake.file, '--model', model, '--provider', 'anthropic', '--output', output, ...cases.flatMap(id => ['--case', id]),
    ...(judge ? ['--judge', '--judge-cli', judge.file ?? fake.file, '--judge-model', judge.model ?? 'judge-good', '--judge-provider', 'anthropic'] : []), ...extra];
  const result = await command(args, { environment: { ANTHROPIC_API_KEY: 'synthetic-fixture-auth-only', ...environment } });
  const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'));
  return { ...result, output, report };
}

export async function audit(fake) {
  try { return (await readFile(fake.auditFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

