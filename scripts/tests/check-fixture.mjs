import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gitEnvironment, publicationCredentialNames } from '../check-source.mjs';

export function run(command, args, cwd, extra = {}) {
  const env = gitEnvironment();
  for (const name of publicationCredentialNames) delete env[name];
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000, ...extra, env: { ...env, ...extra.env } });
}

export function checked(command, args, cwd, extra) {
  const result = run(command, args, cwd, extra);
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

export async function fixture(t, { npmBody = '' } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'encbird-verification-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'work');
  const bin = join(base, 'bin');
  const log = join(base, 'npm-log.jsonl');
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(bin);
  for (const name of ['check-source.mjs', 'check.mjs', 'runtime-smoke.mjs', 'pre-push.mjs', 'install-hooks.mjs', 'require-container.sh', 'verification-policy.json']) {
    await cp(resolve('scripts', name), join(root, 'scripts', name));
  }
  for (const name of ['package.json', 'package-lock.json']) await cp(resolve(name), join(root, name));
  await mkdir(join(root, 'plugins/encbird'), { recursive: true });
  for (const name of ['package.json', 'dist', 'contracts', 'skills']) await cp(resolve('plugins/encbird', name), join(root, 'plugins/encbird', name), { recursive: true });
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await cp(resolve('.github/workflows/ci.yaml'), join(root, '.github/workflows/ci.yaml'));
  await writeFile(join(root, '.gitignore'), 'node_modules/\n.test-tmp/\n');
  await writeFile(join(root, 'source.txt'), 'synthetic checked source\n');
  await writeFile(log, '');
  await writeFile(join(bin, 'npm'), `#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = ${JSON.stringify(root)};
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({ args,
  credentials: ${JSON.stringify(publicationCredentialNames)}.filter(name => process.env[name]),
  gitDir: process.env.GIT_DIR ?? null, gitIndex: process.env.GIT_INDEX_FILE ?? null,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  nodePath: process.env.NODE_PATH ?? null,
  userConfig: fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, 'utf8'),
}) + '\\n');
${npmBody}
`, { mode: 0o755 });
  await chmod(join(bin, 'npm'), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const localGit = (...args) => checked('git', args, root);
  localGit('init', '-q', '-b', 'main');
  localGit('config', 'user.name', 'Fixture');
  localGit('config', 'user.email', 'fixture@example.invalid');
  localGit('add', '.');
  localGit('commit', '-qm', 'test: synthetic verification source');
  return {
    base, root, log, env, git: localGit,
    check: (args = [], extra = {}) => run(process.execPath, [join(root, 'scripts/check.mjs'), ...args], root, { ...extra, env: { ...env, ...extra.env } }),
    commands: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    async install() { checked(process.execPath, [join(root, 'scripts/install-hooks.mjs')], root); },
    push(input, { remoteUrl = 'https://example.invalid/fixture.git', ...extra } = {}) {
      const refs = join(base, 'push-refs');
      writeFileSync(refs, input, { mode: 0o600 });
      return run('git', ['hook', 'run', `--to-stdin=${refs}`, 'pre-push', '--', 'origin', remoteUrl], root,
        { ...extra, env: { ...env, ...extra.env } });
    },
  };
}

export function updates(commit, local = 'refs/heads/main', remote = local) {
  return `${local} ${commit} ${remote} ${'0'.repeat(commit.length)}\n`;
}
