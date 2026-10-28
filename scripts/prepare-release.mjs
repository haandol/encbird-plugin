#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, '..');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const archive = (...args) => execFileSync('python3', ['-B', join(scripts, 'release-archive.py'), ...args], { encoding: 'utf8' }).trim();

function validateOrigin() {
  const config = (...args) => {
    try { return git('config', ...args); }
    catch (error) { if (error.status === 1) return ''; throw error; }
  };
  if (config('--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$')) throw new Error('Git URL rewrite configuration is not allowed for a release.');
  const repository = 'haandol/encbird-plugin';
  const allowed = ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/']
    .flatMap(prefix => [prefix + repository, prefix + repository + '.git']);
  const push = config('--get-all', 'remote.origin.pushurl');
  for (const url of [config('--get-all', 'remote.origin.url'), ...(push ? [push] : []),
    git('remote', 'get-url', '--all', 'origin'), git('remote', 'get-url', '--push', '--all', 'origin')]) {
    if (!allowed.includes(url)) throw new Error('origin must have exactly one URL and one push URL for haandol/encbird-plugin.');
  }
}

function cleanHead(commit, version) {
  if (git('rev-parse', 'HEAD') !== commit) throw new Error('HEAD differs from COMMIT_SHA.');
  if (git('--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all')) {
    throw new Error('Expected a clean committed source tree, including committed dist; check/build must not change it.');
  }
  archive('worktree', root, version, commit, '-');
}

async function main() {
  execFileSync('sh', [join(scripts, 'require-container.sh')], { stdio: 'inherit' });
  const args = process.argv.slice(2);
  const verify = args[0] === '--verify';
  if (verify) args.shift();
  if (args.length !== 3) throw new Error('Usage: node scripts/prepare-release.mjs VERSION FULL_COMMIT_SHA REVIEWED_NOTES_FILE\n       node scripts/prepare-release.mjs --verify VERSION FULL_COMMIT_SHA ZIP_SHA256');
  const [version, commit, argument] = args;
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version) || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('Expected stable VERSION and full COMMIT_SHA.');
  }
  validateOrigin();
  if (git('rev-parse', `${commit}^{commit}`) !== commit) throw new Error('COMMIT_SHA must identify the exact source commit.');
  const { assertVersions } = await import('./lib/version.mjs');
  const scratch = await mkdtemp(join(tmpdir(), 'encbird-release-'));
  try {
    archive('versions', root, version, commit, scratch);
    if (await assertVersions(scratch) !== version) throw new Error('VERSION differs from the committed product version.');
    if (verify) {
      if (!/^[0-9a-f]{64}$/.test(argument)) throw new Error('ZIP_SHA256 must be lowercase SHA-256.');
      console.log(archive('verify', root, version, commit, argument));
      return;
    }
    cleanHead(commit, version);
    if (await assertVersions(root) !== version) throw new Error('Working tree version differs.');
    const notes = resolve(argument);
    if (!(await readFile(notes, 'utf8')).trim()) throw new Error('Reviewed release notes must not be empty.');
    await writeFile(join(scratch, 'npm-user.conf'), '');
    await writeFile(join(scratch, 'npm-global.conf'), '');
    // Build code receives a token-free environment and isolated npm/XDG configuration.
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: scratch, LANG: 'C.UTF-8', CI: 'true',
      XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
      NPM_CONFIG_USERCONFIG: join(scratch, 'npm-user.conf'), NPM_CONFIG_GLOBALCONFIG: join(scratch, 'npm-global.conf'),
      NPM_CONFIG_CACHE: join(scratch, 'npm-cache'),
    };
    execFileSync('npm', ['run', 'check'], { cwd: root, env, stdio: 'inherit' });
    cleanHead(commit, version);
    if (await assertVersions(root) !== version) throw new Error('Build changed the product version.');
    const checksum = archive('create', root, version, commit, notes);
    console.log(`Prepared .release/${version}/${commit}/\nZIP SHA-256: ${checksum}`);
    console.log(`Explicit tag-only push: bash scripts/publish-release.sh ${version} ${commit} ${checksum} --push`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
