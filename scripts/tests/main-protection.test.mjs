import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { configureProtection, desiredProtection, inspectProtection, repository, requiredChecks, satisfiesProtection, workflow } from '../configure-main-protection.mjs';

function fixture() {
  const head = 'a'.repeat(40), blob = 'b'.repeat(40);
  const state = {
    local: { head, workflowOid: blob, dirty: false },
    info: { full_name: repository, private: false, default_branch: 'main', archived: false, disabled: false },
    head, tree: { tree: [{ path: workflow, type: 'blob', sha: blob }], truncated: false },
    history: { workflow_runs: [{ id: 12, path: workflow, head_sha: head, head_branch: 'main', status: 'completed', conclusion: 'success' }] },
    jobs: requiredChecks.map(name => ({ name, status: 'completed', conclusion: 'success' })),
    rulesets: [], existing: null, created: [], reads: [], localCalls: 0,
  };
  const io = {
    local() { state.localCalls++; state.beforeLocal?.(); return structuredClone(state.local); },
    read(endpoint) {
      state.reads.push(endpoint);
      if (endpoint === `repos/${repository}`) return structuredClone(state.info);
      if (endpoint.endsWith('/branches/main')) return { commit: { sha: state.head } };
      if (endpoint.includes('/git/trees/')) return structuredClone(state.tree);
      if (endpoint.includes('/actions/workflows/')) return structuredClone(state.history);
      if (/\/rulesets\/\d+$/.test(endpoint)) return structuredClone(state.existing);
      throw new Error('Unexpected read: ' + endpoint);
    },
    jobs: () => structuredClone(state.jobs), rulesets: () => structuredClone(state.rulesets),
    create(endpoint, body) {
      assert.equal(endpoint, `repos/${repository}/rulesets`);
      state.created.push(structuredClone(body));
      state.existing = { ...structuredClone(body), id: 31 };
      state.rulesets = [{ id: 31, name: body.name }];
      state.afterCreate?.();
      return { id: 31 };
    },
  };
  return { state, io };
}

test('default plan is concrete and read-only even when activation is ready', () => {
  const { state, io } = fixture();
  const result = configureProtection(io);
  assert.equal(result.ready, true); assert.equal(result.applied, false);
  assert.deepEqual(result.proposedRuleset, desiredProtection());
  assert.deepEqual(state.created, []);
});

for (const [name, change] of [
  ['uncommitted source', s => { s.local.dirty = true; }],
  ['unpublished local commit', s => { s.local.head = 'c'.repeat(40); }],
  ['missing workflow', s => { s.tree.tree = []; }],
  ['different workflow bytes', s => { s.tree.tree[0].sha = 'c'.repeat(40); }],
  ['pending run', s => { s.history.workflow_runs[0].status = 'in_progress'; }],
  ['failed run', s => { s.history.workflow_runs[0].conclusion = 'failure'; }],
  ['wrong workflow', s => { s.history.workflow_runs[0].path = '.github/workflows/other.yaml'; }],
  ['wrong source', s => { s.history.workflow_runs[0].head_sha = 'c'.repeat(40); }],
  ['missing runtime job', s => { s.jobs.pop(); }],
  ['skipped job', s => { s.jobs[0].conclusion = 'skipped'; }],
  ['duplicate job name', s => { s.jobs.push(s.jobs[0]); }],
]) {
  test(`activation refuses ${name} before any settings write`, () => {
    const { state, io } = fixture(); change(state);
    assert.equal(inspectProtection(io).ready, false);
    assert.throws(() => configureProtection(io, true));
    assert.deepEqual(state.created, []);
  });
}

test('repository identity, missing metadata and incomplete inventories fail closed', () => {
  for (const change of [s => { s.info.private = true; }, s => { delete s.info.disabled; }, s => { s.info.full_name = 'other/repository'; }, s => { s.tree.truncated = true; }]) {
    const { state, io } = fixture(); change(state);
    assert.throws(() => configureProtection(io, true));
    assert.deepEqual(state.created, []);
  }
});

test('activation rechecks source, creates only its own ruleset and verifies the saved result', () => {
  const { state, io } = fixture();
  state.rulesets.push({ id: 6, name: 'independent-policy' });
  const result = configureProtection(io, true);
  assert.equal(result.applied, true); assert.equal(result.existingRulesetId, 31);
  assert.equal(state.localCalls, 2); assert.equal(state.created.length, 1);
  assert.ok(satisfiesProtection(state.existing));
  assert.equal(state.reads.at(-1), `repos/${repository}/rulesets/31`);
});

test('an existing stricter managed ruleset is reused without replacing its extra requirements', () => {
  const { state, io } = fixture();
  state.existing = { ...desiredProtection(), id: 31 };
  state.existing.rules.find(rule => rule.type === 'pull_request').parameters.required_approving_review_count = 2;
  state.existing.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks.push({ context: 'security' });
  state.rulesets = [{ name: state.existing.name, id: 31 }];
  assert.equal(configureProtection(io, true).action, 'unchanged');
  assert.equal(state.created.length, 0);
});

test('different or duplicate managed rulesets are never overwritten', () => {
  for (const duplicate of [false, true]) {
    const { state, io } = fixture();
    state.existing = { ...desiredProtection(), id: 31, enforcement: 'disabled' };
    state.rulesets = [{ name: state.existing.name, id: 31 }];
    if (duplicate) state.rulesets.push({ name: state.existing.name, id: 32 });
    assert.throws(() => configureProtection(io, true));
    assert.equal(state.created.length, 0);
  }
});

test('source changes during readiness inspection stop activation', () => {
  const { state, io } = fixture();
  state.beforeLocal = () => { if (state.localCalls === 2) state.local.dirty = true; };
  assert.throws(() => configureProtection(io, true), /Commit the complete local source/);
  assert.equal(state.created.length, 0);
});

test('post-create verification failure reports the created ID without another mutation', () => {
  const { state, io } = fixture();
  state.afterCreate = () => { state.existing.enforcement = 'disabled'; };
  assert.throws(() => configureProtection(io, true), /31 was created but verification failed/);
  assert.equal(state.created.length, 1);
});

const inContainer = spawnSync('sh', [resolve('scripts/require-container.sh')]).status === 0;
test('credential relay allows only protection management and removes Node startup hooks', { skip: !inContainer }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'encbird-protection-relay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts'); await mkdir(scripts);
  for (const name of ['require-container.sh', 'release-with-token.sh']) await writeFile(join(scripts, name), await readFile(resolve('scripts', name)));
  await writeFile(join(scripts, 'configure-main-protection.mjs'), "import {createHash} from 'node:crypto'; console.log(JSON.stringify({args:process.argv.slice(2),digest:createHash('sha256').update(process.env.GH_TOKEN).digest('hex'),nodeOptions:process.env.NODE_OPTIONS??null,legacy:process.env.GITHUB_TOKEN??null}));");
  const token = 'synthetic-protection-credential';
  const result = spawnSync('sh', [join(scripts, 'release-with-token.sh'), 'protect-main', '--plan'], {
    encoding: 'utf8', input: token + '\n', env: { ...process.env, NODE_OPTIONS: '--require /missing-startup-hook', GITHUB_TOKEN: 'unrelated-fixture' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(token));
  assert.deepEqual(JSON.parse(result.stdout), { args: ['--plan'], digest: createHash('sha256').update(token).digest('hex'), nodeOptions: null, legacy: null });
});

test('real protection CLI plans and applies through a controlled GitHub transport only after readiness', { skip: !inContainer }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'encbird-protection-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), bin = join(base, 'bin');
  await mkdir(join(root, 'scripts'), { recursive: true }); await mkdir(join(root, '.github/workflows'), { recursive: true }); await mkdir(bin);
  for (const name of ['configure-main-protection.mjs', 'verification-policy.json', 'require-container.sh']) await writeFile(join(root, 'scripts', name), await readFile(resolve('scripts', name)));
  await writeFile(join(root, workflow), 'name: Fixture\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|GH_|GITHUB_|NODE_OPTIONS|NODE_PATH)/.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', PATH: `${bin}:${process.env.PATH}`, TEST_POLICY_STATE: join(base, 'state.json'), TEST_POLICY_WRITES: join(base, 'writes.jsonl') });
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('commit', '-qm', 'fixture'); git('remote', 'add', 'origin', `https://github.com/${repository}.git`);
  const state = { head: git('rev-parse', 'HEAD'), blob: git('rev-parse', `HEAD:${workflow}`), pending: true, saved: null };
  await writeFile(env.TEST_POLICY_STATE, JSON.stringify(state)); await writeFile(env.TEST_POLICY_WRITES, '');
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2), endpoint=args.find(value=>value.startsWith('repos/'));
if(args[0]!=='api'||args[args.indexOf('--hostname')+1]!=='github.com'||!endpoint.startsWith('repos/haandol/encbird-plugin'))process.exit(99);
const file=process.env.TEST_POLICY_STATE, state=JSON.parse(fs.readFileSync(file,'utf8'));
let value;
if(args.includes('POST')){
 if(endpoint!=='repos/haandol/encbird-plugin/rulesets'||!args.includes('--input'))process.exit(98);
 state.saved={...JSON.parse(fs.readFileSync(0,'utf8')),id:31};
 fs.appendFileSync(process.env.TEST_POLICY_WRITES,JSON.stringify({endpoint,body:state.saved})+'\\n');fs.writeFileSync(file,JSON.stringify(state));value=state.saved;
}else if(endpoint==='repos/haandol/encbird-plugin')value={full_name:'haandol/encbird-plugin',private:false,default_branch:'main',archived:false,disabled:false};
else if(endpoint.endsWith('/branches/main'))value={commit:{sha:state.head}};
else if(endpoint.includes('/git/trees/'))value={tree:[{path:'.github/workflows/ci.yaml',type:'blob',sha:state.blob}],truncated:false};
else if(endpoint.includes('/actions/workflows/'))value={workflow_runs:[{id:12,path:'.github/workflows/ci.yaml',head_sha:state.head,head_branch:'main',status:state.pending?'in_progress':'completed',conclusion:state.pending?null:'success'}]};
else if(endpoint.includes('/actions/runs/'))value=[{jobs:['test','build','runtime'].map(name=>({name,status:'completed',conclusion:'success'}))}];
else if(endpoint.includes('/rulesets?'))value=[state.saved?[{id:31,name:state.saved.name}]:[]];
else if(endpoint.endsWith('/rulesets/31'))value=state.saved;
else process.exit(97);
process.stdout.write(JSON.stringify(value)+'\\n');
`, { mode: 0o700 });
  const run = flag => spawnSync(process.execPath, [join(root, 'scripts/configure-main-protection.mjs'), flag], { cwd: root, env, encoding: 'utf8', timeout: 15_000 });
  let result = run('--plan'); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ready, false);
  result = run('--apply'); assert.notEqual(result.status, 0); assert.equal(await readFile(env.TEST_POLICY_WRITES, 'utf8'), '');
  state.pending = false; await writeFile(env.TEST_POLICY_STATE, JSON.stringify(state));
  result = run('--apply'); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).applied, true);
  result = run('--apply'); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).action, 'unchanged');
  assert.equal((await readFile(env.TEST_POLICY_WRITES, 'utf8')).trim().split('\n').length, 1);
  assert.equal(git('status', '--porcelain'), '');
});
