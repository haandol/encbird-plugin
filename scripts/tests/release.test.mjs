import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { publicationCredentialNames } from '../check-source.mjs';

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inside = spawnSync('sh', [join(scripts, 'require-container.sh')]).status === 0;
const containerTest = (name, fn) => test(name, { skip: inside ? false : 'Requires the real repository Docker image; parent runs these offline.' }, fn);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const fakeGit = `#!/usr/bin/env python3
import json, os, subprocess, sys
args = sys.argv[1:]
for verb in ('push', 'fetch', 'ls-remote'):
    if verb in args:
        with open(os.environ['TEST_GIT_LOG'], 'a') as log: log.write(json.dumps(args) + '\\n')
        url = 'https://github.com/haandol/encbird-plugin.git'
        if url not in args: sys.exit('unexpected outbound destination')
        if verb in ('push', 'fetch') and os.environ.get('TEST_DENY_WRITES'): sys.exit('unexpected Git mutation')
        args = [os.environ['TEST_REMOTE'] if a == url else a for a in args]
        if verb == 'push' and any(a.startswith('--force') or a in ('--no-verify', '--all', '--mirror') or 'refs/heads/' in a for a in args): sys.exit('unsafe push')
        break
sys.exit(subprocess.call([os.environ['TEST_REAL_GIT'], *args]))
`;
const fakeGh = `#!/usr/bin/env python3
import json, os, pathlib, shutil, subprocess, sys
args = sys.argv[1:]
base = pathlib.Path(os.environ['TEST_STATE'])
with open(os.environ['TEST_GH_LOG'], 'a') as log: log.write(json.dumps(args) + '\\n')
def option(name): return args[args.index(name) + 1]
def save(value): base.write_text(json.dumps(value))
def git(*a): return subprocess.check_output([os.environ['TEST_REAL_GIT'], '--git-dir', os.environ['TEST_REMOTE'], *a], text=True).strip()
def emit(value): print(json.dumps(value))
state = json.loads(base.read_text()) if base.exists() else None
if args[:2] == ['auth', 'status']:
    if os.environ.get('TEST_AUTH_FAIL'): sys.exit('authentication failed')
    if os.environ.get('TEST_REQUIRE_GH_TOKEN') and os.environ.get('GH_TOKEN') != 'fixture-token-never-real': sys.exit('publisher authentication was removed')
elif args[0] == 'api':
    if option('--hostname') != 'github.com': sys.exit('wrong host')
    endpoint = next(a for a in args if a.startswith('repos/'))
    if endpoint != 'repos/haandol/encbird-plugin' and not endpoint.startswith('repos/haandol/encbird-plugin/'): sys.exit('wrong repository')
    if os.environ.get('TEST_API_FAIL'): sys.exit('API unavailable')
    if endpoint == 'repos/haandol/encbird-plugin':
        metadata = {'full_name': 'haandol/encbird-plugin', 'private': False, 'default_branch': 'main', 'archived': False, 'disabled': False}
        metadata.update(json.loads(os.environ.get('TEST_REPOSITORY_METADATA', '{}')))
        emit(metadata)
    elif '/compare/' in endpoint:
        left, right = endpoint.split('/compare/')[1].split('...')
        merge = git('merge-base', left, right)
        emit({'base_commit': {'sha': left}, 'merge_base_commit': {'sha': merge}, 'status': 'identical' if left == right else 'ahead' if merge == left else 'diverged'})
    elif endpoint.endswith('/status'):
        status = os.environ.get('TEST_STATUS', 'success')
        emit({'state': status, 'total_count': 0 if status == 'absent' else 1, 'statuses': [] if status == 'absent' else [{'state': status}]})
    elif '/check-runs?' in endpoint:
        result = os.environ.get('TEST_CHECK', 'success')
        names = json.loads(os.environ.get('TEST_CHECK_NAMES', '["test","build","runtime"]'))
        emit({'check_runs': [] if result == 'absent' else [{'name': name, 'status': 'in_progress' if result == 'pending' else 'completed', 'conclusion': result} for name in names]})
    elif '/git/tags/' in endpoint:
        oid = endpoint.rsplit('/', 1)[1]
        lines = git('cat-file', 'tag', oid).splitlines()
        emit({'sha': oid, 'tag': lines[2][4:], 'object': {'sha': lines[0][7:], 'type': lines[1][5:]}})
    elif endpoint.endswith('/releases/latest'):
        print(os.environ.get('TEST_LATEST', state['tag_name']))
    elif '/releases?' in endpoint:
        other = json.loads(os.environ.get('TEST_PUBLISHED_RELEASES', '[]'))
        if state and len(state['assets']) == 4:
            other += json.loads(os.environ.get('TEST_PUBLISHED_AFTER_UPLOADS', '[]'))
        hidden = pathlib.Path(str(base) + '.list-hides')
        remaining = int(hidden.read_text()) if hidden.exists() else 0
        if state and remaining > 0:
            hidden.write_text(str(remaining - 1))
            emit(other)
        else:
            emit(([state] if state else []) + other)
    elif endpoint.endswith('/releases/1'):
        if not state: sys.exit('missing release')
        emit(state)
    else: sys.exit('unsupported API: ' + endpoint)
elif args[0] == 'release':
    if option('--repo') != 'github.com/haandol/encbird-plugin': sys.exit('wrong repository')
    verb = args[1]
    if verb in ('create', 'edit', 'upload') and os.environ.get('TEST_DENY_WRITES'): sys.exit('unexpected GitHub mutation')
    if verb == 'create':
        if state: sys.exit('release already exists')
        if '--draft' not in args or '--verify-tag' not in args: sys.exit('unsafe create')
        state = {'id': 1, 'tag_name': args[2], 'name': option('--title'), 'body': pathlib.Path(option('--notes-file')).read_text(), 'target_commitish': option('--target'), 'draft': True, 'prerelease': False, 'assets': [], 'html_url': 'https://github.com/haandol/encbird-plugin/releases/tag/' + args[2]}
        save(state)
        pathlib.Path(str(base) + '.list-hides').write_text(os.environ.get('TEST_HIDE_CREATED_LISTS', '0'))
    elif verb == 'upload':
        source = pathlib.Path(args[3]); name = source.name
        if any(a['name'] == name for a in state['assets']): sys.exit('asset exists')
        if os.environ.get('TEST_UPLOAD_FAIL') == name: sys.exit('interrupted upload')
        if os.environ.get('TEST_MUTATE_ARCHIVE'): pathlib.Path(os.environ['TEST_MUTATE_ARCHIVE']).write_bytes(b'concurrent edit')
        shutil.copyfile(source, str(base) + '.' + name)
        state['assets'].append({'name': name, 'state': 'uploaded', 'size': source.stat().st_size})
        save(state)
    elif verb == 'download':
        name = option('--pattern')
        shutil.copyfile(str(base) + '.' + name, pathlib.Path(option('--dir')) / name)
    elif verb == 'edit':
        if not state['draft'] or '--draft=false' not in args or '--latest' not in args or '--verify-tag' not in args: sys.exit('unsafe edit')
        state['draft'] = False; save(state)
    else: sys.exit('unsupported release verb')
else: sys.exit('unsupported fake gh call: ' + repr(args))
`;

async function fixture(t, { checkCode = '', prepare = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'encbird-release-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo'); const bin = join(base, 'bin'); const remote = join(base, 'remote.git');
  await mkdir(join(root, 'scripts/lib'), { recursive: true }); await mkdir(bin);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GIT_|GH_|GITHUB_|AWS_|NPM_|npm_|NODE_OPTIONS|NODE_PATH|ENCBIRD_)/.test(key) || publicationCredentialNames.includes(key)) delete env[key];
  }
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    TEST_REAL_GIT: execFileSync('which', ['git'], { encoding: 'utf8' }).trim(),
    TEST_REMOTE: remote, TEST_STATE: join(base, 'release.json'), TEST_GH_LOG: join(base, 'gh.log'), TEST_GIT_LOG: join(base, 'git.log'),
    PATH: bin + ':' + process.env.PATH, GH_TOKEN: 'fixture-token-never-real', GITHUB_TOKEN: 'fixture-token-never-real', AWS_SECRET_ACCESS_KEY: 'fixture-secret',
  });
  const git = (...args) => execFileSync(env.TEST_REAL_GIT, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const name of ['prepare-release.mjs', 'publish-release.sh', 'push-version.sh', 'require-container.sh', 'release-archive.py', 'verification-policy.json', 'lib/version.mjs', 'lib/__init__.py', 'lib/doc_links.py']) {
    await cp(join(scripts, name), join(root, 'scripts', name));
  }
  const files = {
    'package.json': JSON.stringify({ name: 'release-fixture', version: '0.1.0', scripts: { check: 'node check.cjs' }, private: true }),
    'package-lock.json': JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' }, 'plugins/encbird': { version: '0.1.0' } } }),
    'plugins/encbird/package.json': JSON.stringify({ name: 'encbird', version: '0.1.0' }),
    'plugins/encbird/plugin.json': JSON.stringify({ name: 'encbird', version: '0.1.0' }),
    'plugins/encbird/.codex-plugin/plugin.json': JSON.stringify({ name: 'encbird', version: '0.1.0' }),
    'plugins/encbird/.claude-plugin/plugin.json': JSON.stringify({ name: 'encbird', version: '0.1.0' }),
    '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'encbird', version: '0.1.0', source: './plugins/encbird' }] }),
    '.agents/plugins/marketplace.json': JSON.stringify({ plugins: [{ name: 'encbird', source: { path: './plugins/encbird' } }] }),
    'README.md': 'Fixture root readme\n', LICENSE: 'Fixture license\n', NOTICE: 'Fixture notice\n',
    'plugins/encbird/README.md': 'Fixture plugin\n', 'plugins/encbird/LICENSE': 'Fixture license\n', 'plugins/encbird/NOTICE': 'Fixture notice\n',
    'plugins/encbird/mcp.json': '{}\n', 'plugins/encbird/.mcp.json': '{}\n',
    'plugins/encbird/dist/index.js': 'console.log("committed bundle");\n', 'plugins/encbird/dist/cli.js': 'console.log("CLI");\n',
    'plugins/encbird/dist/build-info.json': '{}\n', 'plugins/encbird/dist/THIRD_PARTY_LICENSES.txt': 'Fixture licenses\n',
    'plugins/encbird/assets/icon.png': 'fixture bytes', 'plugins/encbird/skills/encbird-learning/SKILL.md': 'Fixture skill\n',
    'plugins/encbird/src/index.ts': '// excluded source\n', 'plugins/encbird/test/test.ts': '// excluded test\n',
    'plugins/encbird/contracts/tools.json': '{"contractVersion":"3.1.0"}',
    'plugins/encbird/contracts/openapi.json': '{"openapi":"3.1.0"}',
    'plugins/encbird/contracts/serialization-samples.json': '{"samples":[]}',
    'plugins/encbird/assets/env/development.env': 'EXCLUDED_FIXTURE=1\n',
    '.gitignore': '.release/\n.check-env.json\nnode_modules/\n.env*\n',
    'check.cjs': `const fs = require('node:fs');
if (Object.keys(process.env).some(k => /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|AWS_|TEST_|NODE_OPTIONS)/.test(k))) throw Error('credentials leaked');
fs.writeFileSync('.check-env.json', JSON.stringify({home: process.env.HOME}));
${checkCode}\n`,
  };
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), body);
  }
  await writeFile(join(bin, 'git'), fakeGit, { mode: 0o755 }); await writeFile(join(bin, 'gh'), fakeGh, { mode: 0o755 });
  await writeFile(env.TEST_GH_LOG, ''); await writeFile(env.TEST_GIT_LOG, '');
  const notes = join(base, 'reviewed-notes.md'); await writeFile(notes, 'Reviewed fixture changes.\n');
  git('init', '-b', 'main'); git('config', 'user.name', 'Release Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgSign', 'false'); git('config', 'tag.gpgSign', 'false');
  git('add', '.'); git('commit', '-m', 'fixture source'); git('init', '--bare', remote);
  git('push', remote, 'HEAD:refs/heads/main'); git('remote', 'add', 'origin', 'git@github.com:haandol/encbird-plugin.git');
  const f = { base, root, env, git, notes, commit: git('rev-parse', 'HEAD') };
  f.run = (script, args, success = true, extraEnv = {}) => {
    const command = script.endsWith('.mjs') ? process.execPath : 'bash';
    const result = spawnSync(command, [join(root, 'scripts', script), ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30_000 });
    if (success) assert.equal(result.status, 0, result.stdout + result.stderr);
    else assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  f.prepare = (success = true) => f.run('prepare-release.mjs', ['0.1.0', f.commit, notes], success);
  f.folder = () => join(root, '.release/0.1.0', f.commit);
  f.checksum = async () => hash(await readFile(join(f.folder(), 'encbird-plugin-0.1.0.zip')));
  f.publish = async (mode = '--check', success = true, extraEnv = {}) => f.run('publish-release.sh', ['0.1.0', f.commit, await f.checksum(), mode], success, extraEnv);
  f.state = () => json(env.TEST_STATE);
  f.calls = async () => (await readFile(env.TEST_GH_LOG, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  f.tag = () => git('tag', '-a', 'v0.1.0', f.commit, '-m', 'Prepared fixture release');
  f.remoteTag = () => git('push', remote, 'refs/tags/v0.1.0:refs/tags/v0.1.0');
  if (prepare) f.prepare();
  return f;
}

test('host release entrypoints reject before doing any work, even with spoofed environment flags', { skip: inside }, () => {
  for (const [name, args] of [['prepare-release.mjs', ['0.1.0', 'a'.repeat(40), '/tmp/notes']],
    ['publish-release.sh', ['0.1.0', 'a'.repeat(40), 'b'.repeat(64), '--check']],
    ['publish-release.sh', ['0.1.0', 'a'.repeat(40), 'b'.repeat(64), '--publish']], ['push-version.sh', ['0.1.0', '--check']]]) {
    const result = spawnSync(name.endsWith('.mjs') ? process.execPath : 'bash', [join(scripts, name), ...args], {
      encoding: 'utf8', env: { ...process.env, ENCBIRD_CONTAINER: '1', REMOTE_CONTAINERS: 'true' },
    });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /devcontainer/);
  }
});

containerTest('publisher verification drops all publication credentials while the caller retains GitHub authentication',async t=>{
  const f=await fixture(t);
  const verifier=join(f.root,'scripts/prepare-release.mjs');
  const original=(await readFile(verifier,'utf8')).replace(/^#![^\n]*\n/,'');
  const probe=`import { writeFileSync as recordVerifierEnv } from 'node:fs';
if(process.argv[2]==='--verify'){
  const observed=Object.fromEntries(${JSON.stringify(publicationCredentialNames)}.map(name=>[name,Boolean(process.env[name])]));
  recordVerifierEnv(new URL('../.release/verifier-env.json',import.meta.url),JSON.stringify(observed));
  if(Object.values(observed).some(Boolean))throw new Error('Publication credentials reached the local verifier');
}
`;
  await writeFile(verifier,'#!/usr/bin/env node\n'+probe+original);
  const before=f.git('show-ref');
  const extra=Object.fromEntries(publicationCredentialNames.map(name=>[name,'fixture-token-never-real']));
  await f.publish('--check',true,{...extra,TEST_REQUIRE_GH_TOKEN:'1',TEST_DENY_WRITES:'1'});
  assert.deepEqual(await json(join(f.root,'.release/verifier-env.json')),Object.fromEntries(publicationCredentialNames.map(name=>[name,false])));
  assert.equal(f.git('show-ref'),before);
  assert.ok((await f.calls()).some(args=>args[0]==='auth'&&args[1]==='status'));
});

containerTest('prepare is deterministic, source-bound, credential-free, and leaves versions and tags untouched', async t => {
  const f = await fixture(t);
  const manifest = await json(join(f.folder(), 'manifest.json'));
  assert.equal(manifest.sourceCommit, f.commit); assert.equal(manifest.sourceTree, f.git('rev-parse', 'HEAD^{tree}'));
  assert.equal(manifest.repository, 'haandol/encbird-plugin'); assert.equal(manifest.version, '0.1.0');
  assert(manifest.files.some(file => file.path === 'plugins/encbird/dist/index.js'));
  assert.equal(manifest.files.filter(file => file.path.startsWith('plugins/encbird/contracts/')).length, 3);
  assert(manifest.files.every(file => !/node_modules|\/src\/|\/test\/|\/env\/|\.env|\.git\//.test(file.path)));
  const before = await Promise.all(['encbird-plugin-0.1.0.zip', 'manifest.json', 'SHA256SUMS', 'release-notes-v0.1.0.md'].map(name => readFile(join(f.folder(), name))));
  f.prepare();
  const after = await Promise.all(['encbird-plugin-0.1.0.zip', 'manifest.json', 'SHA256SUMS', 'release-notes-v0.1.0.md'].map(name => readFile(join(f.folder(), name))));
  assert.deepEqual(after, before); assert.equal(f.git('status', '--porcelain'), ''); assert.equal(f.git('tag', '--list'), '');
  assert.equal((await json(join(f.root, 'package.json'))).version, '0.1.0');
  assert.equal((await json(join(f.root, 'plugins/encbird/contracts/tools.json'))).contractVersion, '3.1.0');
  assert.equal((await json(join(f.root, '.check-env.json'))).home, process.env.HOME);
});

containerTest('prepare rejects dirty, stale HEAD, empty notes, version drift, and changed build outputs', async t => {
  const f = await fixture(t, { prepare: false });
  await writeFile(join(f.root, 'pending'), 'user change'); assert.match(f.prepare(false).stderr, /clean committed/); await rm(join(f.root, 'pending'));
  f.git('update-index', '--assume-unchanged', 'plugins/encbird/dist/index.js');
  const originalBundle = await readFile(join(f.root, 'plugins/encbird/dist/index.js'));
  await writeFile(join(f.root, 'plugins/encbird/dist/index.js'), 'hidden change');
  assert.match(f.prepare(false).stderr, /Working source differs/);
  await writeFile(join(f.root, 'plugins/encbird/dist/index.js'), originalBundle);
  f.git('update-index', '--no-assume-unchanged', 'plugins/encbird/dist/index.js');
  await writeFile(f.notes, ' \n'); assert.match(f.prepare(false).stderr, /must not be empty/); await writeFile(f.notes, 'Reviewed notes\n');
  f.git('commit', '--allow-empty', '-m', 'later'); assert.match(f.prepare(false).stderr, /HEAD differs/);
  f.commit = f.git('rev-parse', 'HEAD');
  await writeFile(join(f.root, 'plugins/encbird/plugin.json'), '{"version":"0.2.0"}');
  f.git('add', '.'); f.git('commit', '-m', 'drift'); f.commit = f.git('rev-parse', 'HEAD');
  assert.match(f.prepare(false).stderr, /expected 0.1.0/);
  const changed = await fixture(t, { prepare: false, checkCode: "fs.writeFileSync('plugins/encbird/dist/index.js', 'changed by build');" });
  assert.match(changed.prepare(false).stderr, /clean committed/);
  const failed = await fixture(t, { prepare: false, checkCode: "throw Error('failing check');" });
  assert.match(failed.prepare(false).stderr, /failing check/);
});

containerTest('symlink sources and artifact paths are rejected; an existing preparation is never overwritten', async t => {
  const f = await fixture(t, { prepare: false });
  await symlink('/etc/passwd', join(f.root, 'plugins/encbird/assets/link'));
  f.git('add', '.'); f.git('commit', '-m', 'symlink fixture'); f.commit = f.git('rev-parse', 'HEAD');
  assert.match(f.prepare(false).stderr, /Symlink/);
  const g = await fixture(t);
  await writeFile(g.notes, 'Different reviewed notes\n'); assert.match(g.prepare(false).stderr, /will not be overwritten/);
  const original = await readFile(join(g.folder(), 'manifest.json')); await rm(join(g.folder(), 'manifest.json'));
  const outside = join(g.base, 'manifest.json'); await writeFile(outside, original); await symlink(outside, join(g.folder(), 'manifest.json'));
  assert.match((await g.publish('--check', false)).stderr, /Symlink/);
});

containerTest('--check performs no local or remote mutations, with or without an annotated tag', async t => {
  const f = await fixture(t);
  await f.publish('--check', true, { TEST_DENY_WRITES: '1', TEST_STATUS: 'absent' });
  assert.equal(f.git('tag', '--list'), ''); assert.equal(f.git('--git-dir', f.env.TEST_REMOTE, 'tag', '--list'), '');
  f.tag(); f.remoteTag(); await f.publish('--check', true, { TEST_DENY_WRITES: '1' });
  f.run('push-version.sh', ['v0.1.0', '--check'], true, { TEST_DENY_WRITES: '1' });
  assert((await f.calls()).every(call => !['create', 'upload', 'edit'].includes(call[1])));
});

containerTest('only the fixed repository identity is accepted; SSH origin still uses HTTPS transport', async t => {
  const f = await fixture(t);
  for (const url of ['https://github.com/haandol/encbird-plugin.git', 'git@github.com:haandol/encbird-plugin', 'ssh://git@github.com/haandol/encbird-plugin.git']) {
    f.git('remote', 'set-url', 'origin', url); await f.publish();
  }
  for (const url of ['https://github.com/other/encbird-plugin.git', 'https://example.invalid/haandol/encbird-plugin.git', 'https://token@github.com/haandol/encbird-plugin.git']) {
    f.git('remote', 'set-url', 'origin', url); assert.match((await f.publish('--push', false)).stderr, /origin must/);
    assert.match(f.prepare(false).stderr, /origin must/);
  }
  f.git('remote', 'set-url', 'origin', 'https://github.com/haandol/encbird-plugin.git');
  f.git('config', '--add', 'remote.origin.pushurl', 'https://github.com/haandol/encbird-plugin.git');
  f.git('config', '--add', 'remote.origin.pushurl', 'git@github.com:haandol/encbird-plugin.git');
  assert.match((await f.publish('--push', false)).stderr, /origin must/);
  f.git('config', '--unset-all', 'remote.origin.pushurl');
  f.git('config', 'url.https://example.invalid/.insteadOf', 'https://github.com/');
  assert.match((await f.publish('--push', false)).stderr, /URL rewrite/);
  assert.equal(f.git('tag', '--list'), '');
});

containerTest('online repository metadata rejects private, mismatched, or unavailable public targets without mutations', async t => {
  const f = await fixture(t);
  const localRefs = f.git('for-each-ref');
  const remoteRefs = f.git('--git-dir', f.env.TEST_REMOTE, 'for-each-ref');
  for (const metadata of [{ private: true }, { full_name: 'another/encbird-plugin' },
    { default_branch: 'develop' }, { archived: true }, { disabled: true }, { private: null }]) {
    for (const mode of ['--check', '--push', '--draft', '--publish']) {
      const result = await f.publish(mode, false, { TEST_REPOSITORY_METADATA: JSON.stringify(metadata) });
      assert.match(result.stderr, /Repository metadata must identify public haandol\/encbird-plugin/);
      assert.equal(f.git('for-each-ref'), localRefs);
      assert.equal(f.git('--git-dir', f.env.TEST_REMOTE, 'for-each-ref'), remoteRefs);
    }
  }
  assert.equal(await readFile(f.env.TEST_GIT_LOG, 'utf8'), '');
  assert((await f.calls()).every(call => !['create', 'upload', 'edit'].includes(call[1])));
  await assert.rejects(f.state(), { code: 'ENOENT' });
});

containerTest('tag push requires source on remote main and all declared CI checks', async t => {
  const f = await fixture(t);
  for (const extraEnv of [{ TEST_STATUS: 'pending' }, { TEST_STATUS: 'failure' }, { TEST_CHECK: 'pending' }, { TEST_CHECK: 'failure' }, { TEST_CHECK: 'absent' }, { TEST_CHECK: 'skipped' }, { TEST_CHECK_NAMES: '["test","build"]' }, { TEST_API_FAIL: '1' }, { TEST_AUTH_FAIL: '1' }]) {
    await f.publish('--push', false, extraEnv); assert.equal(f.git('tag', '--list'), '');
  }
  f.git('commit', '--allow-empty', '-m', 'not on remote main'); f.commit = f.git('rev-parse', 'HEAD'); f.prepare();
  await f.publish('--push', false); assert.equal(f.git('tag', '--list'), '');
  f.git('push', f.env.TEST_REMOTE, 'HEAD:refs/heads/main');
  await f.publish('--push', true, { TEST_STATUS: 'absent' });
  assert.equal(f.git('--git-dir', f.env.TEST_REMOTE, 'rev-parse', 'v0.1.0^{}'), f.commit);
});

containerTest('push creates one annotated tag, never branches or unrelated tags, and reuses identical remote objects', async t => {
  const f = await fixture(t);
  f.git('config', 'push.followTags', 'true'); f.git('tag', '-a', 'unrelated', '-m', 'stay local');
  await f.publish('--push');
  assert.equal(f.git('cat-file', '-t', 'refs/tags/v0.1.0'), 'tag');
  assert.equal(f.git('--git-dir', f.env.TEST_REMOTE, 'tag', '--list'), 'v0.1.0');
  await f.publish('--push', true, { TEST_DENY_WRITES: '1' });
  const object = f.git('rev-parse', 'v0.1.0'); f.git('tag', '-d', 'v0.1.0');
  await f.publish('--push'); assert.equal(f.git('rev-parse', 'v0.1.0'), object);
  assert.equal(f.git('--git-dir', f.env.TEST_REMOTE, 'rev-parse', 'main'), f.commit);
});

containerTest('configured tag signing refusal aborts before creating a tag or mutating the remote', async t => {
  const f = await fixture(t);
  const signer = join(f.base, 'bin', 'refuse-gpg');
  const called = join(f.base, 'gpg-called');
  await writeFile(signer, '#!/bin/sh\n: > "$TEST_GPG_CALLED"\nexit 1\n', { mode: 0o755 });
  f.git('config', 'tag.gpgSign', 'true');
  f.git('config', 'gpg.program', signer);
  f.git('config', 'user.signingkey', 'fixture-signing-key');
  const remoteRefs = f.git('--git-dir', f.env.TEST_REMOTE, 'for-each-ref');
  const result = await f.publish('--push', false, { TEST_GPG_CALLED: called });
  assert.match(result.stderr, /unable to sign|failed to sign/);
  assert.equal(await readFile(called, 'utf8'), '');
  assert.equal(f.git('config', '--get', 'tag.gpgSign'), 'true');
  assert.equal(f.git('tag', '--list'), '');
  assert.equal(f.git('--git-dir', f.env.TEST_REMOTE, 'for-each-ref'), remoteRefs);
  const outbound = (await readFile(f.env.TEST_GIT_LOG, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert(outbound.every(args => !args.includes('push') && !args.includes('fetch')));
  assert((await f.calls()).every(call => !['create', 'upload', 'edit'].includes(call[1])));
  await assert.rejects(f.state(), { code: 'ENOENT' });
});

containerTest('lightweight, mismatched version/commit, and conflicting annotated tag objects are immutable failures', async t => {
  const f = await fixture(t);
  f.git('tag', 'v0.1.0'); assert.match((await f.publish('--push', false)).stderr, /annotated/); f.git('tag', '-d', 'v0.1.0');
  f.tag(); f.remoteTag(); const remoteObject = f.git('rev-parse', 'v0.1.0');
  f.git('tag', '-d', 'v0.1.0'); f.git('tag', '-a', 'v0.1.0', '-m', 'different metadata');
  assert.match((await f.publish('--push', false)).stderr, /tag objects differ/);
  assert.equal(f.git('--git-dir', f.env.TEST_REMOTE, 'rev-parse', 'v0.1.0'), remoteObject);
  f.git('tag', '-a', 'v9.0.0', '-m', 'wrong product version');
  f.run('push-version.sh', ['9.0.0'], false);
  f.git('tag', '-d', 'v0.1.0'); f.git('commit', '--allow-empty', '-m', 'later'); f.tag = () => f.git('tag', '-a', 'v0.1.0', '-m', 'wrong commit'); f.tag();
  assert.match((await f.publish('--push', false)).stderr, /another commit/);
});

containerTest('publisher verifies the requested source after later local changes without building again', async t => {
  const f = await fixture(t); await f.publish('--push');
  f.git('commit', '--allow-empty', '-m', 'later tooling');
  await writeFile(join(f.root, 'plugins/encbird/dist/index.js'), 'unrelated working tree change');
  await writeFile(join(f.root, 'check.cjs'), "throw Error('publisher must never build');");
  await f.publish('--publish'); assert.equal((await f.state()).draft, false);
});

containerTest('publication verifies all uploaded bytes before public Latest and retries do not reclaim Latest', async t => {
  const f = await fixture(t); await f.publish('--push'); await f.publish('--publish');
  const state = await f.state(); assert.equal(state.draft, false); assert.equal(state.assets.length, 4);
  const calls = await f.calls(); const edit = calls.findIndex(call => call[1] === 'edit');
  assert.equal(calls.slice(0, edit).filter(call => call[1] === 'download').length, 4);
  assert(calls[edit].includes('--latest')); assert(calls[edit].includes('--draft=false'));
  await writeFile(f.env.TEST_GH_LOG, '');
  await f.publish('--publish', true, { TEST_DENY_WRITES: '1', TEST_LATEST: 'v99.0.0',
    TEST_PUBLISHED_RELEASES: JSON.stringify([{ tag_name: 'v99.0.0', draft: false, prerelease: false }]) });
  assert.deepEqual(await f.state(), state);
  assert((await f.calls()).every(call => !['edit', 'create', 'upload'].includes(call[1]) && !call.some(arg => arg.endsWith('/releases/latest'))));
});

containerTest('newer published release blocks first publication before draft creation or partial uploads', async t => {
  const newer = JSON.stringify([{ tag_name: 'v0.2.0', draft: false, prerelease: false }]);
  for (const partial of [false, true]) {
    const f = await fixture(t); await f.publish('--push');
    if (partial) await f.publish('--draft', false, { TEST_UPLOAD_FAIL: 'manifest.json' });
    const before = partial ? await f.state() : null;
    const refs = f.git('--git-dir', f.env.TEST_REMOTE, 'for-each-ref');
    await writeFile(f.env.TEST_GH_LOG, '');
    const result = await f.publish('--publish', false, { TEST_PUBLISHED_RELEASES: newer, TEST_DENY_WRITES: '1' });
    assert.match(result.stderr, /Newer published release v0.2.0 exists/);
    if (partial) assert.deepEqual(await f.state(), before);
    else await assert.rejects(f.state(), { code: 'ENOENT' });
    assert.equal(f.git('--git-dir', f.env.TEST_REMOTE, 'for-each-ref'), refs);
    assert((await f.calls()).every(call => !['create', 'upload', 'edit'].includes(call[1])));
  }
});

containerTest('newer release discovered after uploads preserves the completed draft without publishing', async t => {
  const f = await fixture(t); await f.publish('--push');
  await f.publish('--draft', false, { TEST_UPLOAD_FAIL: 'manifest.json' });
  const originalZip = await readFile(f.env.TEST_STATE + '.encbird-plugin-0.1.0.zip');
  await writeFile(f.env.TEST_GH_LOG, '');
  const newer = JSON.stringify([{ tag_name: 'v0.2.0', draft: false, prerelease: false }]);
  const result = await f.publish('--publish', false, { TEST_PUBLISHED_AFTER_UPLOADS: newer });
  assert.match(result.stderr, /Newer published release v0.2.0 exists/);
  const state = await f.state();
  assert.equal(state.draft, true); assert.equal(state.assets.length, 4);
  assert.deepEqual(await readFile(f.env.TEST_STATE + '.encbird-plugin-0.1.0.zip'), originalZip);
  const calls = await f.calls();
  assert.equal(calls.filter(call => call[1] === 'upload').length, 3);
  assert(calls.every(call => !['create', 'edit'].includes(call[1])));
  await f.publish('--publish', false, { TEST_PUBLISHED_RELEASES: newer, TEST_DENY_WRITES: '1' });
  assert.deepEqual(await f.state(), state);
});

containerTest('older-release guard ignores drafts and prereleases, allows upgrades, and leaves explicit draft mode available', async t => {
  const f = await fixture(t); await f.publish('--push');
  await writeFile(join(f.root, 'json.py'), "raise RuntimeError('publisher must not import checkout code')\n");
  const newer = JSON.stringify([{ tag_name: 'v0.2.0', draft: false, prerelease: false }]);
  await f.publish('--draft', true, { TEST_PUBLISHED_RELEASES: newer });
  assert.equal((await f.state()).draft, true);
  await f.publish('--publish', true, { TEST_PUBLISHED_RELEASES: JSON.stringify([
    { tag_name: 'v0.2.0', draft: true, prerelease: false },
    { tag_name: 'v1.0.0-rc.1', draft: false, prerelease: true },
    { tag_name: 'v0.0.99999999999999999999', draft: false, prerelease: false },
  ]) });
  assert.equal((await f.state()).draft, false);
});

containerTest('older-release guard refuses unorderable published stable tags before creating a draft', async t => {
  const f = await fixture(t); await f.publish('--push');
  await writeFile(f.env.TEST_GH_LOG, '');
  const result = await f.publish('--publish', false, { TEST_DENY_WRITES: '1',
    TEST_PUBLISHED_RELEASES: JSON.stringify([{ tag_name: 'legacy-latest', draft: false, prerelease: false }]) });
  assert.match(result.stderr, /Cannot compare published release tag/);
  await assert.rejects(f.state(), { code: 'ENOENT' });
  assert((await f.calls()).every(call => !['create', 'upload', 'edit'].includes(call[1])));
});

containerTest('uploads use the verified snapshot if local prepared bytes change during publication', async t => {
  const f = await fixture(t); await f.publish('--push');
  const checksum = await f.checksum();
  await f.publish('--publish', true, { TEST_MUTATE_ARCHIVE: join(f.folder(), 'encbird-plugin-0.1.0.zip') });
  assert.equal(hash(await readFile(f.env.TEST_STATE + '.encbird-plugin-0.1.0.zip')), checksum);
  assert.equal((await f.state()).draft, false);
});

containerTest('explicit draft stays draft and matching partial uploads resume without replacement', async t => {
  const f = await fixture(t); await f.publish('--push');
  await f.publish('--draft', false, { TEST_UPLOAD_FAIL: 'manifest.json' });
  assert.equal((await f.state()).assets.length, 1); assert.equal((await f.state()).draft, true);
  await f.publish('--check', true, { TEST_DENY_WRITES: '1' });
  await f.publish('--draft'); assert.equal((await f.state()).draft, true);
  await f.publish('--publish'); assert.equal((await f.state()).draft, false);
  assert.equal((await f.calls()).filter(call => call[1] === 'upload' && call[3].endsWith('.zip')).length, 1);
});

containerTest('modified metadata, unexpected assets, and corrupt uploaded bytes prevent draft resume and published retries', async t => {
  const f = await fixture(t); await f.publish('--push'); await f.publish('--draft');
  const state = await f.state();
  for (const changed of [{ ...state, body: state.body + 'altered' }, { ...state, target_commitish: 'main' },
    { ...state, assets: [...state.assets, { name: 'unexpected.zip', state: 'uploaded' }] }]) {
    await writeFile(f.env.TEST_STATE, JSON.stringify(changed)); await f.publish('--publish', false); assert.deepEqual(await f.state(), changed);
  }
  await writeFile(f.env.TEST_STATE, JSON.stringify(state));
  await writeFile(f.env.TEST_STATE + '.encbird-plugin-0.1.0.zip', 'corrupt');
  assert.match((await f.publish('--publish', false)).stderr, /Uploaded asset SHA-256 mismatch/);
  await writeFile(f.env.TEST_STATE, JSON.stringify({ ...state, draft: false }));
  assert.match((await f.publish('--publish', false)).stderr, /Uploaded asset SHA-256 mismatch/);
});

containerTest('ZIP provenance rejects changed blobs, extra traversal entries, and appended data despite a matching caller checksum', async t => {
  const f = await fixture(t); const archive = join(f.folder(), 'encbird-plugin-0.1.0.zip'); const original = await readFile(archive);
  for (const attack of ['blob', 'traversal', 'append']) {
    await writeFile(archive, original);
    execFileSync('python3', ['-c', `import pathlib,sys,zipfile,io\np=pathlib.Path(sys.argv[1]); b=p.read_bytes()\nif sys.argv[2]=='append': p.write_bytes(b+b'junk')\nelse:\n z=zipfile.ZipFile(io.BytesIO(b)); o=io.BytesIO()\n with zipfile.ZipFile(o,'w') as out:\n  for e in z.infolist(): out.writestr(e, b'forged' if sys.argv[2]=='blob' and e.filename.endswith('/dist/index.js') else z.read(e))\n  if sys.argv[2]=='traversal': out.writestr('../outside',b'bad')\n p.write_bytes(o.getvalue())`, archive, attack]);
    assert.match((await f.publish('--push', false)).stderr, /ZIP (content|paths|is not)/);
    assert.equal(f.git('tag', '--list'), '');
  }
});

containerTest('new release preparation rejects missing README and Skill references in the actual package', async t => {
  for (const [file, body, missing] of [
    ['README.md', '[Development](docs/development.md)', 'docs/development.md'],
    ['plugins/encbird/skills/encbird-learning/SKILL.md', '[Privacy](references/privacy.md)', 'references/privacy.md'],
  ]) {
    const f = await fixture(t, { prepare: false });
    await writeFile(join(f.root, file), body);
    f.git('add', '.'); f.git('commit', '-m', 'missing document reference'); f.commit = f.git('rev-parse', 'HEAD');
    const result = f.prepare(false);
    assert.match(result.stderr, /Unresolved document links/);
    assert.ok(result.stderr.includes(missing));
    assert.equal(f.git('tag', '--list'), '');
  }
});

containerTest('new release preparation accepts included file targets and public documentation URLs', async t => {
  const f = await fixture(t, { prepare: false });
  await writeFile(join(f.root, 'README.md'), '[Plugin](plugins/encbird/README.md) [Development](https://github.com/haandol/encbird-plugin/blob/main/docs/development.md)');
  const reference = join(f.root, 'plugins/encbird/skills/encbird-learning/references/privacy.md');
  await mkdir(dirname(reference), { recursive: true });
  await writeFile(reference, '[Skill](../SKILL.md)');
  await writeFile(join(f.root, 'plugins/encbird/skills/encbird-learning/SKILL.md'), '[Privacy](references/privacy.md)');
  f.git('add', '.'); f.git('commit', '-m', 'complete packaged documents'); f.commit = f.git('rev-parse', 'HEAD');
  f.prepare();
  assert.ok((await json(join(f.folder(), 'manifest.json'))).files.some(item => item.path.endsWith('/references/privacy.md')));
});

containerTest('a created draft can appear after read-only rechecks without a second create', async t => {
  const f = await fixture(t);
  await f.publish('--push');
  await f.publish('--publish', true, { TEST_HIDE_CREATED_LISTS: '2' });
  const calls = await f.calls();
  assert.equal(calls.filter(call => call[0] === 'release' && call[1] === 'create').length, 1);
  assert.equal(calls.filter(call => call[0] === 'release' && call[1] === 'upload').length, 4);
  assert.equal((await f.state()).draft, false);
});

containerTest('a created draft that stays invisible stops with its draft intact and no uploads', async t => {
  const f = await fixture(t);
  await f.publish('--push');
  const result = await f.publish('--publish', false, { TEST_HIDE_CREATED_LISTS: '99' });
  assert.match(result.stderr, /Draft was not found after create/);
  const calls = await f.calls();
  assert.equal(calls.filter(call => call[0] === 'release' && call[1] === 'create').length, 1);
  assert.equal(calls.filter(call => call[0] === 'release' && ['upload', 'edit'].includes(call[1])).length, 0);
  assert.equal((await f.state()).draft, true);
  assert.deepEqual((await f.state()).assets, []);
});

containerTest('published releases remain verifiable after older CI checks are absent', async t => {
  const f = await fixture(t);
  await f.publish('--push');
  await f.publish('--publish');
  const before = await f.state();
  const result = await f.publish('--publish', true, { TEST_CHECK: 'absent', TEST_STATUS: 'absent', TEST_DENY_WRITES: '1' });
  assert.match(result.stdout, /Already published and verified/);
  assert.deepEqual(await f.state(), before);
});
