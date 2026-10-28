import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const scripts = resolve('scripts');
function inspect(files, excluded = []) {
  const python = "import json,sys; sys.path.insert(0,sys.argv[1]); from lib.doc_links import validate_documents; value=json.load(sys.stdin); print(json.dumps(validate_documents(value['files'],value['excluded'])))";
  return JSON.parse(execFileSync('python3', ['-c', python, scripts], { input: JSON.stringify({ files, excluded }), encoding: 'utf8' }));
}

test('checks shipped Markdown, image and HTML paths relative to each source', () => {
  const result = inspect({
    'README.md': '[Read](plugins/encbird/README.md) <img src="plugins/encbird/assets/icon.png">',
    'plugins/encbird/README.md': '[License](../../LICENSE) ![Icon](assets/icon.png)',
    'plugins/encbird/assets/icon.png': '', LICENSE: '',
  });
  assert.deepEqual(result, { checked: 4, problems: [] });
});

test('rejects the three missing v0.1.0 README targets even when the README itself exists', () => {
  const result = inspect({ 'README.md': '[Development](docs/development.md), [releases](docs/releases.md), [instructions](AGENTS.md)' });
  assert.deepEqual(result.problems.map(item => item.resolved), ['docs/development.md', 'docs/releases.md', 'AGENTS.md']);
});

test('fenced examples, inline code and escaped link labels do not become live references', () => {
  const result = inspect({ 'README.md': '```md\n[x](missing-one.md)\n```\n`[y](missing-two.md)`\n\\[z](missing-three.md)\n~~~html\n<img src="missing.png">\n~~~\n[real](LICENSE)', LICENSE: '' });
  assert.deepEqual(result, { checked: 1, problems: [] });
});

test('reference, collapsed and shortcut references count actual uses once', () => {
  const result = inspect({ 'README.md': '[first][guide]\n[guide][]\n[guide]\n[guide]: <guide file.md> "Guide"', 'guide file.md': '' });
  assert.deepEqual(result, { checked: 3, problems: [] });
});

test('linked images retain their local inline and reference targets inside an external link', () => {
  const result = inspect({ 'README.md': '[![Icon](missing.png)](https://example.invalid)\n[![Badge][badge]](LICENSE)\n[badge]: assets/badge.png', LICENSE: '', 'assets/badge.png': '' });
  assert.equal(result.checked, 3);
  assert.deepEqual(result.problems, [{ file: 'README.md', line: 1, target: 'missing.png', resolved: 'missing.png', reason: 'missing file target' }]);
});

test('balanced labels and paths, angle spaces, URL encoding, queries and fragments retain file identity', () => {
  const result = inspect({
    'README.md': '[a [label]](guide(1).md) [b](<a b.md>) [c](a%20b.md?view=1#intro) [d](guide\\(1\\).md) <a href="a%20b.md?x=1&amp;y=2">link</a>',
    'guide(1).md': '', 'a b.md': '',
  });
  assert.deepEqual(result, { checked: 5, problems: [] });
});

test('directories are inferred from ZIP files; an absent directory is rejected', () => {
  const result = inspect({ 'README.md': '[dir](./skills/) [bad](./missing/)', 'skills/learn/SKILL.md': '[root](../../)' });
  assert.equal(result.checked, 3);
  assert.deepEqual(result.problems.map(item => item.resolved), ['missing']);
});

test('external URLs and local fragments are not fetched, while filesystem escapes are rejected', () => {
  const result = inspect({ 'README.md': '[web](https://example.invalid/no-request) [mail](mailto:nobody@example.invalid) [here](#title) [escape](../outside) [encoded](%2e%2e/outside) [absolute](/etc/passwd) [file](file:///etc/passwd) [windows](C:/private/file)' });
  assert.equal(result.problems.length, 5);
  assert.ok(result.problems.every(item => /absolute|escapes/.test(item.reason)));
});

test('uninstantiated source templates can be excluded, but packaged templates are checked', () => {
  const files = { 'README.md': '[Template](change.template.md)', 'change.template.md': '[Placeholder](NNNN-title.md)' };
  assert.equal(inspect(files).problems.length, 1);
  assert.deepEqual(inspect(files, ['change.template.md']), { checked: 1, problems: [] });
});

test('CLI checks new source documents, rejects symlinks, and never changes source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'encbird-document-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'README.md'), '[Guide](docs/guide.md)');
  await writeFile(join(root, 'docs/guide.md'), '[Root](../README.md)');
  const command = ['python3', [join(scripts, 'validate-doc-links.py'), '--root', root]];
  let result = spawnSync(...command, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).checkedRelativeFileTargets, 2);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '[Guide](docs/guide.md)');
  await symlink(join(root, 'README.md'), join(root, 'linked.md'));
  result = spawnSync(...command, { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Symlink/);
});
