import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertVersions, bumpVersion, readVersion, updateVersion } from '../lib/version.mjs';

const run = promisify(execFile);
const versionFiles = [
  'package.json', 'plugins/encbird/package.json', 'package-lock.json',
  'plugins/encbird/plugin.json', 'plugins/encbird/.codex-plugin/plugin.json',
  'plugins/encbird/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json',
];
const json = async (root, file) => JSON.parse(await readFile(join(root, file), 'utf8'));
const writeJson = (root, file, value) => writeFile(join(root, file), JSON.stringify(value, null, 2) + '\n');

async function fixture(t, version = '0.1.0') {
  const root = await mkdtemp(join(tmpdir(), 'encbird-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = {
    'package.json': { name: 'encbird-plugin-workspace', version, scripts: { check: 'node check.mjs' }, private: true },
    'plugins/encbird/package.json': { name: 'encbird-learning-plugin', version, dependencies: { example: '0.1.0' } },
    'package-lock.json': { version, lockfileVersion: 3, packages: {
      '': { version, license: 'Apache-2.0' },
      'plugins/encbird': { version, dependencies: { example: '0.1.0' } },
      'node_modules/example': { version: '0.1.0', integrity: 'fixture-only' },
    } },
    'plugins/encbird/plugin.json': { name: 'encbird', version, extensions: { example: { version: '0.1.0' } } },
    'plugins/encbird/.codex-plugin/plugin.json': { name: 'encbird', version, skills: './skills/' },
    'plugins/encbird/.claude-plugin/plugin.json': { name: 'encbird', version, mcpServers: './.mcp.json' },
    '.claude-plugin/marketplace.json': { name: 'catalog', metadata: { version: '0.1.0' }, plugins: [
      { name: 'other', version: '0.1.0', source: './plugins/other' },
      { name: 'encbird', version, source: './plugins/encbird' },
    ] },
    '.agents/plugins/marketplace.json': { plugins: [{ name: 'encbird', source: { path: './plugins/encbird' } }] },
    'plugins/encbird/contracts/tools.json': { contractVersion: '3.1.0' },
    'plugins/encbird/contracts/openapi.json': { openapi: '3.1.0', info: { version: '3.1.0' } },
    'plugins/encbird/test/server.json': { serverInfo: { version: '0.1.0' } },
  };
  for (const [file, data] of Object.entries(documents)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeJson(root, file, data);
  }
  return root;
}

async function bytes(root) {
  const result = {};
  for (const file of (await readdir(root, { recursive: true })).sort()) {
    if ((await stat(join(root, file))).isFile()) result[file] = await readFile(join(root, file), 'utf8');
  }
  return result;
}

async function rejectUnchanged(root, next, error) {
  const before = await bytes(root);
  await assert.rejects(updateVersion(root, next), error);
  assert.deepEqual(await bytes(root), before);
}

test('reads the authoritative root version and checks every synchronized version', async t => {
  const root = await fixture(t);
  assert.equal(await readVersion(root), '0.1.0');
  assert.equal(await assertVersions(pathToFileURL(root)), '0.1.0');
  await writeJson(root, 'plugins/encbird/plugin.json', { version: '0.2.0' });
  assert.equal(await readVersion(root), '0.1.0');
  await assert.rejects(assertVersions(root), /plugin.json.version is 0.2.0; expected 0.1.0/);
});

test('updates all nine version fields, selects encbird by name, and preserves unrelated keys and files', async t => {
  const root = await fixture(t);
  const before = await bytes(root);
  assert.equal(await updateVersion(root, '1.2.3'), '1.2.3');
  assert.equal(await assertVersions(root), '1.2.3');
  const after = await bytes(root);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const [file, content] of Object.entries(before)) {
    if (!versionFiles.includes(file)) { assert.equal(after[file], content); continue; }
    const expected = JSON.parse(content);
    if (file === '.claude-plugin/marketplace.json') expected.plugins[1].version = '1.2.3';
    else expected.version = '1.2.3';
    if (file === 'package-lock.json') {
      expected.packages[''].version = '1.2.3';
      expected.packages['plugins/encbird'].version = '1.2.3';
    }
    assert.deepEqual(JSON.parse(after[file]), expected, file);
  }
});

test('setting the same version leaves bytes and modification times unchanged', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'package.json'), '{ "version": "0.1.0", "keep": true }');
  const before = await bytes(root);
  const times = await Promise.all(versionFiles.map(file => stat(join(root, file), { bigint: true })));
  assert.equal(await updateVersion(root, '0.1.0'), '0.1.0');
  assert.deepEqual(await bytes(root), before);
  assert.deepEqual(await Promise.all(versionFiles.map(async file => (await stat(join(root, file), { bigint: true })).mtimeNs)), times.map(value => value.mtimeNs));
});

test('stable SemVer rejects leading zeros, prefixes, missing parts, suffixes, whitespace, and nonstrings', async t => {
  const root = await fixture(t);
  for (const invalid of ['01.2.3', '1.02.3', '1.2.03', 'v1.2.3', '1.2', '1.2.3.4', '-1.2.3',
    '1.2.3-rc.1', '1.2.3+build', ' 1.2.3', '1.2.3\n', '', 123, null]) {
    await rejectUnchanged(root, invalid, /stable SemVer/);
  }
  await writeJson(root, 'package.json', { version: '01.2.3' });
  await assert.rejects(readVersion(root), /package.json.version must be stable SemVer/);
});

test('compares and increments numeric components without lexicographic ordering or precision loss', async t => {
  assert.equal(bumpVersion('1.9.9'), '1.9.10');
  assert.equal(bumpVersion('1.9.9', 'minor'), '1.10.0');
  assert.equal(bumpVersion('1.9.9', 'major'), '2.0.0');
  assert.equal(bumpVersion('0.0.0'), '0.0.1');
  assert.equal(bumpVersion('0.0.9007199254740992'), '0.0.9007199254740993');
  assert.throws(() => bumpVersion('1.2.3', 'prerelease'), /patch, minor, or major/);
  const root = await fixture(t, '1.9.9');
  await updateVersion(root, '1.10.0');
  for (const lower of ['1.9.99', '0.99.99']) {
    await rejectUnchanged(root, lower, /Cannot downgrade/);
  }
  await updateVersion(root, '2.0.0');
  await rejectUnchanged(root, '1.99.99', /Cannot downgrade/);
  await updateVersion(root, '2.0.9007199254740993');
  await rejectUnchanged(root, '2.0.9007199254740992', /Cannot downgrade/);
});

test('validates every file before writing, including same-version requests', async t => {
  for (const file of versionFiles) {
    await t.test(file, async t => {
      const root = await fixture(t);
      await writeFile(join(root, file), '{broken');
      await rejectUnchanged(root, '0.2.0', /valid JSON/);
      await rejectUnchanged(root, '0.1.0', /valid JSON/);
      await writeFile(join(root, file), 'null');
      await rejectUnchanged(root, '0.2.0', /must be an object/);
      await rm(join(root, file));
      await rejectUnchanged(root, '0.2.0', /ENOENT/);
    });
  }
});

test('rejects every missing, malformed, or mismatched version target before writing', async t => {
  const selections = [
    ...versionFiles.filter(file => !file.includes('marketplace')).map(file => [file, data => data]),
    ['package-lock.json', data => data.packages['']],
    ['package-lock.json', data => data.packages['plugins/encbird']],
    ['.claude-plugin/marketplace.json', data => data.plugins[1]],
  ];
  for (const [file, select] of selections) {
    const root = await fixture(t);
    const original = await json(root, file);
    for (const version of [undefined, '0.01.0', '0.2.0']) {
      const data = structuredClone(original);
      select(data).version = version;
      await writeJson(root, file, data);
      await assert.rejects(assertVersions(root));
      await rejectUnchanged(root, '0.3.0', /stable SemVer|expected/);
    }
  }
});

test('rejects incomplete lockfile structures and missing or ambiguous marketplace entries', async t => {
  for (const packages of [undefined, [], {}, { '': { version: '0.1.0' } }]) {
    const root = await fixture(t);
    await writeJson(root, 'package-lock.json', { version: '0.1.0', packages });
    await rejectUnchanged(root, '0.2.0', /must be an object/);
  }
  for (const plugins of [undefined, {}, [], [{ name: 'other', version: '0.1.0' }],
    [{ name: 'encbird', version: '0.1.0' }, { name: 'encbird', version: '0.1.0' }]]) {
    const root = await fixture(t);
    await writeJson(root, '.claude-plugin/marketplace.json', { plugins });
    await rejectUnchanged(root, '0.2.0', /must be an array|exactly one encbird/);
  }
});

async function cliFixture(t) {
  const root = await fixture(t, '1.2.3');
  await mkdir(join(root, 'scripts/lib'), { recursive: true });
  await cp(new URL('../version.mjs', import.meta.url), join(root, 'scripts/version.mjs'));
  await cp(new URL('../lib/version.mjs', import.meta.url), join(root, 'scripts/lib/version.mjs'));
  return root;
}

test('CLI check, default patch, minor, major, and explicit set work without git or network', async t => {
  const root = await cliFixture(t);
  const command = (...args) => run(process.execPath, [join(root, 'scripts/version.mjs'), ...args], { cwd: tmpdir(), env: { PATH: root } });
  const before = await bytes(root);
  assert.match((await command('check')).stdout, /1.2.3/);
  assert.deepEqual(await bytes(root), before);
  for (const [args, expected] of [[['bump'], '1.2.4'], [['bump', 'patch'], '1.2.5'],
    [['bump', 'minor'], '1.3.0'], [['bump', 'major'], '2.0.0'], [['set', '3.2.1'], '3.2.1']]) {
    assert.match((await command(...args)).stdout, new RegExp(expected.replaceAll('.', '\\.')));
    assert.equal(await assertVersions(root), expected);
  }
  const after = await bytes(root);
  await command('set', '3.2.1');
  assert.deepEqual(await bytes(root), after);
  assert.deepEqual(Object.keys(after), Object.keys(before));
});

test('CLI rejects invalid arguments, drift, and explicit downgrades without writes', async t => {
  const root = await cliFixture(t);
  for (const args of [[], ['publish'], ['check', 'patch'], ['bump', 'beta'], ['bump', 'patch', 'extra'],
    ['set'], ['set', '1.2.4', 'extra'], ['set', '01.2.4'], ['set', '1.2.2']]) {
    const before = await bytes(root);
    await assert.rejects(run(process.execPath, [join(root, 'scripts/version.mjs'), ...args], { env: { PATH: root } }), error => error.code === 1 && Boolean(error.stderr));
    assert.deepEqual(await bytes(root), before);
  }
  await writeJson(root, 'plugins/encbird/plugin.json', { version: '9.0.0' });
  const before = await bytes(root);
  await assert.rejects(run(process.execPath, [join(root, 'scripts/version.mjs'), 'check'], { env: { PATH: root } }), error => error.code === 1 && /expected 1.2.3/.test(error.stderr));
  assert.deepEqual(await bytes(root), before);
});

test('runtime product version is derived from plugin package metadata after a fixture bump', async t => {
  const root = await fixture(t);
  await updateVersion(root, '0.2.0');
  await mkdir(join(root, 'plugins/encbird/src'), { recursive: true });
  const module = join(root, 'plugins/encbird/src/version.mjs');
  await cp(new URL('../../plugins/encbird/src/version.ts', import.meta.url), module);
  assert.equal((await import(pathToFileURL(module).href)).pluginVersion, '0.2.0');
});
