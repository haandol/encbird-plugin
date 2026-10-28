import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  committedState, publicationCredentialNames, receiptPath, requireCommittedSource, sourceState, verifyReceipt,
} from '../check-source.mjs';
import { fixture } from './check-fixture.mjs';

test('working-tree checks run before commit without issuing a push receipt', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'draft.md'), 'Uncommitted development fixture.\n');
  const result = f.check();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const commands = await f.commands();
  assert.deepEqual(commands.map(command => command.args), [
    ['run', 'version:check'], ['run', 'typecheck'], ['run', 'build'], ['run', 'test'],
    ['run', 'test:release'], ['run', 'test:eval'], ['run', 'validate:docs'], ['run', 'validate'],
  ]);
  assert(commands.every(command => command.credentials.length === 0 && command.gitDir === null && command.userConfig === ''));
  assert(result.stdout.indexOf('Installed MCP initialize') < result.stdout.indexOf('Verification: npm run build'));
  await assert.rejects(readFile(receiptPath(f.root, f.git('rev-parse', 'HEAD'))), { code: 'ENOENT' });
});

test('broken committed bundle fails before a build could repair it', async t => {
  const f = await fixture(t, { npmBody: "if (args.includes('build')) fs.writeFileSync(root + '/plugins/encbird/dist/index.js', '// repaired');" });
  await writeFile(join(f.root, 'plugins/encbird/dist/index.js'), 'this is not JavaScript!');
  f.git('commit', '-am', 'test: broken committed bundle');
  const result = f.check(['push']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Runtime closed/);
  assert.deepEqual(await f.commands(), []);
  assert.equal(await readFile(join(f.root, 'plugins/encbird/dist/index.js'), 'utf8'), 'this is not JavaScript!');
});

test('a rebuild repairing committed metadata is a failure and never creates a receipt', async t => {
  const f = await fixture(t, { npmBody: "if (args.includes('build')) fs.writeFileSync(root + '/plugins/encbird/dist/build-info.json', '{}\\n');" });
  await writeFile(join(f.root, 'plugins/encbird/dist/build-info.json'), '{"stale":true}\n');
  f.git('commit', '-am', 'test: stale build metadata');
  const result = f.check(['push']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source changed during verification.*build-info.json/);
  await assert.rejects(verifyReceipt(f.root), /clean committed source/);
  await assert.rejects(readFile(receiptPath(f.root, f.git('rev-parse', 'HEAD'))), { code: 'ENOENT' });
});

test('push verification rejects every nonempty publication credential before running npm', async t => {
  const f = await fixture(t);
  for (const name of publicationCredentialNames) {
    const secret = 'ghp_synthetic_but_treated_as_a_real_credential';
    const result = f.check(['push'], { env: { [name]: secret } });
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /Publication credentials are present/);
    assert(!result.stdout.includes(secret) && !result.stderr.includes(secret));
  }
  assert.deepEqual(await f.commands(), []);
});

test('a successful receipt binds the exact commit and all source, definitions, dependencies, and Git modes', async t => {
  const f = await fixture(t);
  const result = f.check(['push']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual((await f.commands())[0].args, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  const original = await verifyReceipt(f.root);
  assert.equal(original.commit, f.git('rev-parse', 'HEAD'));
  assert.equal(original.tree, f.git('rev-parse', 'HEAD^{tree}'));
  assert.equal(original.sourceSha256, (await sourceState(f.root)).digest);
  const oldPath = receiptPath(f.root, original.commit);
  for (const path of ['scripts/check.mjs', '.github/workflows/ci.yaml', 'scripts/verification-policy.json', 'package-lock.json']) {
    const file = join(f.root, path);
    const content = await readFile(file, 'utf8');
    await writeFile(file, content + '\n');
    f.git('commit', '-am', `test: change ${path}`);
    const current = f.git('rev-parse', 'HEAD');
    await copyFile(oldPath, receiptPath(f.root, current));
    await assert.rejects(verifyReceipt(f.root), /No matching verification receipt/);
  }
});

test('Git ignoring a working file mode does not hide a changed executable from verification', async t => {
  const f = await fixture(t);
  f.git('config', 'core.filemode', 'false');
  assert.equal((await sourceState(f.root)).digest, committedState(f.root, f.git('rev-parse', 'HEAD')).digest);
  await chmod(join(f.root, 'source.txt'), 0o755);
  assert.equal(f.git('status', '--porcelain'), '');
  await assert.rejects(requireCommittedSource(f.root), /executable modes/);
  assert.notEqual(f.check(['push']).status, 0);
  assert.deepEqual(await f.commands(), []);
});

test('changed source during checks invalidates the run instead of describing the old commit as passed', async t => {
  const f = await fixture(t, { npmBody: "if (args.includes('test:eval')) fs.appendFileSync(root + '/source.txt', 'changed during checks\\n');" });
  const head = f.git('rev-parse', 'HEAD');
  const result = f.check(['push']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source changed during verification.*source.txt/);
  await assert.rejects(readFile(receiptPath(f.root, head)), { code: 'ENOENT' });
});

test('a failed repeat verification removes the older receipt for the same source', async t => {
  const f = await fixture(t, { npmBody: "if (fs.existsSync(log + '.fail') && args.includes('test:eval')) process.exit(9);" });
  assert.equal(f.check(['push']).status, 0);
  await verifyReceipt(f.root);
  await writeFile(f.log + '.fail', 'fail');
  const result = f.check(['push']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /test:eval failed \(9\)/);
  await assert.rejects(verifyReceipt(f.root), /No matching verification receipt/);
});

test('committed mode cannot silently substitute HEAD for an uncommitted working tree', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'source.txt'), 'new intended source\n');
  const result = f.check(['build', '--committed']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /clean committed source/);
  assert.deepEqual(await f.commands(), []);
});
