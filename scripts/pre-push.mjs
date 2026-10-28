#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  assertUnchanged, git, hasPublicationCredentials, requireCommittedSource, requireContainer,
  sourceState, verifyReceipt,
} from './check-source.mjs';

export function parseUpdates(input) {
  return input.split('\n').filter(Boolean).map(line => {
    const parts = line.split(' ');
    if (parts.length !== 4 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parts[1]) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parts[3])) throw new Error('Malformed Git pre-push update; refusing to verify a different ref.');
    return { localRef: parts[0], localOid: parts[1], remoteRef: parts[2], remoteOid: parts[3] };
  });
}

async function main() {
  requireContainer();
  const args = process.argv.slice(2);
  const receiptOnly = args[0] === '--receipt-only';
  if (receiptOnly) args.shift();
  if (args.length !== 2) throw new Error('Expected Git pre-push remote name and URL.');
  const updates = parseUpdates(readFileSync(0, 'utf8')).filter(update => !/^0+$/.test(update.localOid));
  if (!updates.length) return;
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel');
  const before = await sourceState(root);
  await requireCommittedSource(root, before);
  for (const update of updates) {
    const commit = git(root, 'rev-parse', '--verify', `${update.localOid}^{commit}`);
    if (commit !== before.head) {
      throw new Error(`Push ref ${update.localRef} resolves to ${commit}, but the checked-out commit is ${before.head}. Verify that exact commit in its own container checkout with npm run check:push, then push from there. Multiple refs must all resolve to the current checked commit.`);
    }
  }
  try { await verifyReceipt(root, before); }
  catch (error) {
    if (receiptOnly || hasPublicationCredentials()) throw error;
    console.log('No matching local receipt; running credential-free verification of the exact push source.');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('check.mjs', import.meta.url)), 'push'], { cwd: root, env: process.env, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Credential-free pre-push verification failed. Fix the reported checks before retrying; no refs were approved by this hook.');
  }
  assertUnchanged(before, await sourceState(root));
  await verifyReceipt(root);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}
