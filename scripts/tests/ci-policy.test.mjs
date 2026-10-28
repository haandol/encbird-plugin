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
