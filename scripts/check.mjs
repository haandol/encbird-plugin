#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertUnchanged, removeReceipt, requireCommittedSource, requireContainer, requireNoPublicationCredentials,
  sourceState, verificationEnvironment, writeReceipt,
} from './check-source.mjs';
import { smokeInstalledPlugin } from './runtime-smoke.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function main() {
  requireContainer();
  requireNoPublicationCredentials();
  const args = process.argv.slice(2);
  const committedOnly = args.includes('--committed');
  const modes = args.filter(arg => arg !== '--committed');
  const mode = modes[0] ?? 'all';
  if (modes.length > 1 || !['all', 'test', 'build', 'push'].includes(mode) || args.filter(arg => arg === '--committed').length > 1) {
    throw new Error('Usage: node scripts/check.mjs [test|build|push] [--committed]');
  }
  const before = await sourceState(root);
  const committed = mode === 'push' || committedOnly ? await requireCommittedSource(root, before) : null;
  if (mode === 'push') await removeReceipt(root, before.head);
  const isolated = await verificationEnvironment();
  const run = async (...command) => {
    console.log(`Verification: npm ${command.join(' ')}`);
    const result = spawnSync('npm', command, { cwd: root, env: isolated.env, stdio: 'inherit', timeout: 10 * 60_000, killSignal: 'SIGKILL' });
    if (result.error || result.status !== 0) throw new Error(`npm ${command.join(' ')} failed (${result.error?.code ?? result.status}).`);
    assertUnchanged(before, await sourceState(root));
  };
  try {
    if (mode !== 'test') {
      console.log(`Checking ${committed ? 'committed' : 'working-tree'} installation before any rebuild.`);
      await smokeInstalledPlugin(root, { env: isolated.env });
      assertUnchanged(before, await sourceState(root));
    }
    if (mode === 'push') await run('ci', '--ignore-scripts', '--no-audit', '--no-fund');
    if (mode !== 'build') {
      await run('run', 'version:check');
      await run('run', 'typecheck');
    }
    if (mode !== 'test') {
      // A rebuilt file is a failure, even when it fixes a bad committed bundle or metadata.
      await run('run', 'build');
    }
    if (mode !== 'build') {
      for (const script of ['test', 'test:release', 'test:eval', 'validate:docs']) await run('run', script);
    }
    await run('run', 'validate');
    assertUnchanged(before, await sourceState(root));
    if (mode === 'push') {
      await requireCommittedSource(root);
      const receipt = await writeReceipt(root, committed);
      try { assertUnchanged(before, await sourceState(root)); }
      catch (error) { await removeReceipt(root, before.head); throw error; }
      console.log(`Local verification receipt: ${receipt}\nThis receipt does not report or replace remote CI results.`);
    }
    console.log(committed
      ? `Verification passed for committed source ${before.head}.`
      : `Verification passed for working-tree snapshot ${before.digest} (based on ${before.head}; no push receipt).`);
  } finally { await isolated.cleanup(); }
}

main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
