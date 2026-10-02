import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, readFile, readdir, symlink, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CredentialStore } from '../src/store.js';
import { Secrets } from '../src/errors.js';
import { mock } from './helpers.js';

test('credentials are owner-only atomic files and scope separates host clients and API bases', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  assert.equal((await lstat(m.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(m.store.path)).mode & 0o777, 0o600);
  assert.ok(!(await readdir(m.directory)).some(name => name.endsWith('.tmp')));
  assert.notEqual(new CredentialStore(m.base, 'claude', new Secrets(), m.directory).path, m.store.path);
  assert.notEqual(new CredentialStore('http://127.0.0.1:1/x', 'mock-host', new Secrets(), m.directory).path, m.store.path);
  assert.equal((JSON.parse(await readFile(m.store.path, 'utf8'))).status, 'active');
});

test('unsafe file permissions and symlink credentials are rejected', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  await chmod(m.store.path, 0o644); await assert.rejects(m.read(), { code: 'UNSAFE_CREDENTIALS' }); await chmod(m.store.path, 0o600);
  await unlink(m.store.path); await symlink('/etc/passwd', m.store.path);
  await assert.rejects(m.read(), { code: 'UNSAFE_CREDENTIALS' });
});

test('cross-process locked updates do not lose writes or expose partial JSON', async t => {
  const m = await mock(); t.after(() => m.close()); await m.login();
  await m.store.withLock(async tx => { const value = (await tx.load())!; value.expiresAt = 0; await tx.save(value); });
  const run = promisify(execFile);
  await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ['--import', 'tsx', 'test/lock-worker.ts', m.base, m.directory], { timeout: 15_000 })));
  assert.equal((await m.read())!.expiresAt, 32);
  assert.deepEqual((await readdir(m.directory)).filter(name => name.endsWith('.lock') || name.endsWith('.tmp')), []);
});
