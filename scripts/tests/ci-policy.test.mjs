import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the CI workflow exposes every stable check required by release and protection policy exactly once', async () => {
  const policy = JSON.parse(await readFile('scripts/verification-policy.json', 'utf8'));
  const workflow = await readFile('.github/workflows/ci.yaml', 'utf8');
  assert.equal(policy.schemaVersion, 1);
  assert.deepEqual(Object.keys(policy.checks).sort(), ['build', 'runtime', 'test']);
  const names = [...workflow.matchAll(/^    name: (.+)$/gm)].map(match => match[1].trim().replace(/^['"]|['"]$/g, ''));
  for (const [role, context] of Object.entries(policy.checks)) {
    assert.equal(typeof context, 'string', `${role} must declare a check name`);
    assert.equal(names.filter(name => name === context).length, 1, `${role}: exactly one CI job must expose ${context}`);
  }
});

test('CI verifies every branch and PR without a redundant tag-push run during publication',async()=>{
  const workflow=await readFile('.github/workflows/ci.yaml','utf8');
  assert.match(workflow,/on:\n  push:\n    branches: \['\*\*'\]\n  pull_request:\n  workflow_dispatch:/);
  assert.doesNotMatch(workflow,/^    (?:tags|paths|paths-ignore):/m);
});

test('the dependency audit monitors every locked package on a schedule without gating merges', async () => {
  const workflow = await readFile('.github/workflows/dependency-audit.yaml', 'utf8');
  const policy = JSON.parse(await readFile('scripts/verification-policy.json', 'utf8'));
  const scripts = JSON.parse(await readFile('package.json', 'utf8')).scripts;
  assert.match(workflow, /\non:\n  schedule:\n    - cron: '[^']+'\n  workflow_dispatch:\n\npermissions:\n  contents: read\n/);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|pull_request_target):/m);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /encbird-plugin-check bun run audit:deps\n/);
  assert.match(workflow, /test -z "\$\(git status --porcelain --untracked-files=all\)"/);
  assert(!Object.values(policy.checks).includes('dependency-audit'), 'The audit is monitoring, not a required check');
  assert.equal(scripts['audit:deps'], 'bun audit', 'Every severity is reported and nothing is rewritten');
});
