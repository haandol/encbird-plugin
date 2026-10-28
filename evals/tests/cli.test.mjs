import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, chmod, writeFile, stat, cp, mkdir, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { filesUnder, verifySeal } from '../lib/files.mjs';
import { audit, command, fakeCLI, live, repoRoot, scratch } from './helpers.mjs';

test('prepare, list, and report use the real entry point without launching any configured runtime', async t => {
  const root = await scratch(t);
  const fake = await fakeCLI(root);
  const output = path.join(root, 'prepared');
  const selected = ['--case', 'consent-credits', '--cli', fake.file, '--model', 'must-not-run', '--provider', 'anthropic'];
  const first = await command(['prepare', ...selected, '--output', output]);
  assert.equal(first.code, 0, first.stderr);
  const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'));
  assert.equal(report.status, 'NOT RUN');
  assert.equal(report.cases[0].actions.status, 'NOT RUN');
  assert.equal(report.cases[0].semantic.status, 'NOT RUN');
  assert.equal(report.calls.attempted, 0);
  const before = await verifySeal(output);
  assert.ok(Object.keys(before.hashes).some(file => file.includes('snapshot/inputs/')));
  assert.ok(Object.keys(before.hashes).includes('snapshot/guidance/SKILL.md'));
  assert.match(await readFile(path.join(output, 'report.html'), 'utf8'), /No target or semantic judge was run/);
  assert.equal((await command(['--list', ...selected])).code, 0);
  assert.equal((await command(['--report', output, ...selected])).code, 0);
  assert.deepEqual(await verifySeal(output), before);
  assert.deepEqual(await audit(fake), []);
  const again = await command(['--output', output]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /OUTPUT_DIRECTORY_ALREADY_EXISTS/);
  assert.deepEqual(await verifySeal(output), before);
});

test('report rejects tampered or incomplete run directories without launching a runtime', async t => {
  const root = await scratch(t);
  const fake = await fakeCLI(root);
  const output = path.join(root, 'prepared');
  await command(['--case', 'privacy-safe-answer', '--output', output]);
  await chmod(path.join(output, 'report.json'), 0o600);
  await writeFile(path.join(output, 'report.json'), '{"status":"PASS"}');
  const result = await command(['report', output, '--cli', fake.file]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ARTIFACT_CHANGED/);
  assert.deepEqual(await audit(fake), []);
});

test('explicit prepare and live conflict in either order before output or runtime creation',async t=>{
  const root=await scratch(t);const fake=await fakeCLI(root);
  for(const [index,modes] of [['--prepare','--live'],['--live','--prepare'],['prepare','--live']].entries()){
    const output=path.join(root,`conflict-${index}`);
    const result=await command([...modes,'--cli',fake.file,'--model','must-not-run','--provider','anthropic','--output',output]);
    assert.equal(result.code,1);assert.match(result.stderr,/CONFLICTING_MODES/);
    await assert.rejects(stat(output),{code:'ENOENT'});
  }
  assert.deepEqual(await audit(fake),[]);
});

test('historical report reads retain the original sealed verdict after the grader code changes',async t=>{
  const root=await scratch(t);const output=path.join(root,'original');
  const prepared=await command(['--prepare','--case','privacy-safe-answer','--output',output]);
  assert.equal(prepared.code,0,prepared.stderr);
  const before=await verifySeal(output);const original=await readFile(path.join(output,'report.json'),'utf8');
  const mirror=path.join(root,'new-grader');await mkdir(mirror);
  await cp(path.join(repoRoot,'evals'),path.join(mirror,'evals'),{recursive:true});
  await symlink(path.join(repoRoot,'node_modules'),path.join(mirror,'node_modules'),'dir');
  await writeFile(path.join(mirror,'evals/lib/grade.mjs'),"export function gradeCase(){throw new Error('CURRENT_GRADER_MUST_NOT_RUN')}\nexport function combineStatus(){throw new Error('CURRENT_GRADER_MUST_NOT_RUN')}\n");
  const shown=execFileSync(process.execPath,[path.join(mirror,'evals/run.mjs'),'--report',output],{cwd:mirror,encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.match(shown,/NOT RUN — EncBird Skill behavior evaluation/);
  assert.equal(await readFile(path.join(output,'report.json'),'utf8'),original);
  assert.deepEqual(await verifySeal(output),before);
});

test('missing auth and unsupported isolation fail before any model invocation', async t => {
  const root = await scratch(t);
  const fake = await fakeCLI(root);
  const output = path.join(root, 'missing-auth');
  const missing = await command(['--live', '--cli', fake.file, '--model', 'agent-good', '--provider', 'anthropic', '--case', 'privacy-safe-answer', '--output', output]);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /MISSING_EXPLICIT_PROVIDER_AUTH/);
  assert.deepEqual(await audit(fake), []);
  for (const options of [{ label: 'old', version: '2.1.100 (Claude Code)' }, { label: 'missing-bare', missingFlag: '--bare' }, { label: 'missing-mcp', missingFlag: '--strict-mcp-config' }]) {
    const unsupported = await fakeCLI(root, options);
    const result = await live(root, unsupported, { cases: ['privacy-safe-answer'] });
    assert.equal(result.report.status, 'ERROR');
    assert.ok((await audit(unsupported)).every(item => ['help', 'version'].includes(item.mode)));
  }
  const badJudge = await fakeCLI(root, { label: 'bad-judge', missingFlag: '--json-schema' });
  const result = await live(root, fake, { cases: ['privacy-safe-answer'], judge: { file: badJudge.file } });
  assert.equal(result.report.status, 'ERROR');
  assert.ok((await audit(fake)).every(item => ['help', 'version'].includes(item.mode)), 'All target/judge capabilities must be checked before target model work');
});

test('fake live target uses actual MCP transport but remains semantically unverified without judge', async t => {
  const root = await scratch(t);
  const fake = await fakeCLI(root);
  const result = await live(root, fake, { cases: ['consent-credits'] });
  assert.equal(result.code, 1);
  assert.equal(result.report.cases[0].actions.status, 'PASS', JSON.stringify(result.report));
  assert.equal(result.report.status, 'UNVERIFIED');
  assert.equal(result.report.cases[0].semantic.status, 'NOT RUN');
  assert.ok(result.report.calls.attempted >= 8);
  const calls = await audit(fake);
  assert.deepEqual(calls.filter(item => item.mode === 'target').map(item => item.args[item.args.indexOf('--model') + 1]), ['agent-good', 'agent-good']);
  for (const call of calls) {
    assert.ok(!call.environmentNames.includes('GITHUB_TOKEN'));
    assert.ok(!call.environmentNames.includes('ENCBIRD_API_BASE_URL'));
    if (['help', 'version'].includes(call.mode)) assert.ok(!call.environmentNames.includes('ANTHROPIC_API_KEY'));
    await assert.rejects(stat(call.workingDirectory), { code: 'ENOENT' }, 'Ephemeral runtime caches must be removed after child cleanup');
  }
  for (const file of await filesUnder(result.output)) assert.doesNotMatch(await readFile(path.join(result.output, file), 'utf8'), /PRIVATE_REASONING_MUST_NOT_BE_RECORDED|STDERR_SECRET_MUST_NOT_BE_RECORDED|synthetic-fixture-auth-only|PRIVATE_RUNTIME_LOG_MUST_NOT_BE_RETAINED/);
  await verifySeal(result.output);
});

test('an optional unchanged Skill-core read is valid evidence and does not create a false action error',async t=>{
  const root=await scratch(t);const fake=await fakeCLI(root);
  const result=await live(root,fake,{model:'agent-core-guidance',cases:['privacy-safe-answer']});
  const record=JSON.parse(await readFile(path.join(result.output,'execution/privacy-safe-answer/record.json'),'utf8'));
  const core=record.phases[0].trace.find(item=>item.kind==='result'&&item.result?.structuredContent?.path==='SKILL.md');
  assert.equal(core.status,'completed');
  assert.equal(core.result.structuredContent.text,await readFile(path.join(result.output,'snapshot/guidance/SKILL.md'),'utf8'));
  assert.equal(result.report.cases[0].actions.status,'PASS',JSON.stringify(result.report));
  assert.equal(result.report.status,'UNVERIFIED');assert.equal(result.report.cases[0].semantic.status,'NOT RUN');
});

test('fake CLI receives an explicit Bedrock profile but no conflicting static or other-provider credentials', async t => {
  const root = await scratch(t);
  const fake = await fakeCLI(root);
  const output = path.join(root, 'profile-run');
  const result = await command(['--live', '--cli', fake.file, '--model', 'agent-good', '--provider', 'bedrock', '--case', 'privacy-safe-answer', '--output', output], { environment: {
    AWS_DEFAULT_PROFILE: 'default', AWS_REGION: 'fixture-region', HOME: root,
    AWS_ACCESS_KEY_ID: 'synthetic-conflict', AWS_SECRET_ACCESS_KEY: 'synthetic-conflict', ANTHROPIC_API_KEY: 'synthetic-conflict',
  } });
  assert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'));
  assert.equal(report.cases[0].actions.status, 'PASS', JSON.stringify(report));
  const target = (await audit(fake)).find(item => item.mode === 'target');
  for (const name of ['AWS_PROFILE', 'HOME', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR']) assert.ok(target.environmentNames.includes(name));
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'AWS_DEFAULT_PROFILE']) assert.ok(!target.environmentNames.includes(name));
});

test('every prepared family validates with fake target/judge while live semantics stay unverified', { timeout: 120_000 }, async t => {
  const root = await scratch(t);
  const fake = await fakeCLI(root);
  const result = await live(root, fake, { judge: {} });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.equal(result.report.status, 'UNVERIFIED', result.stdout + result.stderr);
  assert.equal(result.report.evaluationKind, 'deterministic-fixture');
  assert.equal(new Set(result.report.cases.map(item => item.family)).size, 4);
  assert.ok(result.report.cases.every(item => item.semantic.status === 'UNVERIFIED' && item.semantic.fixtureVerdict === 'PASS' && item.actions.status === 'PASS'));
  assert.ok((await audit(fake)).some(item => item.mode === 'judge' && item.args[item.args.indexOf('--model') + 1] === 'judge-good'));
});

test('a known fake target stays unverified even when the separate judge has no fake-runtime marker',async t=>{
  const root=await scratch(t);const target=await fakeCLI(root);const judge=await fakeCLI(root,{label:'unmarked-judge',testDouble:false});
  const result=await live(root,target,{cases:['privacy-safe-answer'],judge:{file:judge.file}});
  assert.equal(result.report.execution.judge.kind,'operator-supplied-claude');
  assert.equal(result.report.cases[0].semantic.status,'PASS');
  assert.equal(result.report.cases[0].actions.status,'PASS');
  assert.equal(result.report.cases[0].fixtureVerdict,'PASS');
  assert.equal(result.report.cases[0].status,'UNVERIFIED');
  assert.equal(result.report.status,'UNVERIFIED');assert.equal(result.report.counts.PASS,0);assert.equal(result.code,1);
});

test('denied approval, inferred rating, rewritten PII, changed retries, and access workarounds remain failures', { timeout: 120_000 }, async t => {
  const root = await scratch(t);
  const fake = await fakeCLI(root);
  for (const [model, id] of [
    ['agent-premature-approval', 'consent-credits'], ['agent-invalid-approval', 'consent-already-approved'],
    ['agent-repeat-approval', 'consent-already-approved'], ['agent-inferred-rating', 'review-waits'],
    ['agent-pii-rewrite', 'privacy-withhold-answer'], ['agent-changed-key', 'recovery-exact-retry'],
    ['agent-changed-answer', 'recovery-exact-retry'], ['agent-other-account', 'recovery-overload'], ['agent-repeat-read', 'recovery-overload'],
  ]) {
    const result = await live(root, fake, { model, cases: [id], judge: {} });
    assert.equal(result.report.status, 'FAIL', `${model}: ${result.stdout}`);
    assert.ok(result.report.cases[0].actions.checks.some(check => check.status === 'FAIL'));
    assert.ok(result.report.calls.error >= 1, `${model} must retain the denied attempted call`);
  }
});

test('fabricated tool histories, missing actions, and missing guidance cannot be rescued by judge PASS', async t => {
  const root = await scratch(t);
  const fake = await fakeCLI(root);
  for (const model of ['agent-self-report', 'agent-no-action', 'agent-no-guidance']) {
    const result = await live(root, fake, { model, cases: ['privacy-safe-answer'], judge: {} });
    assert.notEqual(result.report.status, 'PASS');
    assert.equal(result.code, 1);
  }
});

test('invalid semantic evidence and missing judgments never become PASS', async t => {
  const root = await scratch(t);
  const fake = await fakeCLI(root);
  for (const model of ['judge-missing', 'judge-invented-quote', 'judge-invented-id', 'judge-user-only']) {
    const result = await live(root, fake, { cases: ['privacy-safe-answer'], judge: { model } });
    assert.equal(result.report.status, 'ERROR', model);
    assert.equal(result.report.cases[0].actions.status, 'PASS');
  }
  const fail = await live(root, fake, { cases: ['privacy-safe-answer'], judge: { model: 'judge-fail' } });
  assert.equal(fail.report.status, 'FAIL');
});

test('text-only repeated consent and fabricated completion need separate semantic evidence', async t => {
  const root = await scratch(t);
  const fake = await fakeCLI(root);
  for (const [model, id] of [['agent-repeat-question', 'consent-already-approved'], ['agent-fabricated-completion', 'privacy-withhold-answer']]) {
    const unchecked = await live(root, fake, { model, cases: [id] });
    assert.equal(unchecked.report.cases[0].actions.status, 'PASS');
    assert.equal(unchecked.report.status, 'UNVERIFIED', 'Exact-action checks must not claim a semantic pass');
    const checked = await live(root, fake, { model, cases: [id], judge: { model: 'judge-fail' } });
    assert.equal(checked.report.cases[0].actions.status, 'PASS');
    assert.equal(checked.report.status, 'FAIL', 'A separately supplied, grounded semantic violation dominates successful actions');
    assert.equal(checked.report.cases[0].semantic.fixtureVerdict, 'FAIL');
  }
});

test('failed and partial execution preserves observed calls and visible text while dropping stderr', async t => {
  const root = await scratch(t);
  const fake = await fakeCLI(root);
  for (const model of ['agent-fail-after-call', 'agent-missing-final']) {
    const result = await live(root, fake, { model, cases: ['privacy-safe-answer'] });
    assert.equal(result.report.status, 'ERROR');
    assert.ok(result.report.calls.attempted > 0);
    const record = JSON.parse(await readFile(path.join(result.output, 'execution/privacy-safe-answer/record.json'), 'utf8'));
    assert.ok(record.phases[0].visible.length);
    assert.ok(record.phases[0].trace.length);
    assert.doesNotMatch(JSON.stringify(record), /STDERR_SECRET|PRIVATE_REASONING/);
  }
  const timeout = await live(root, fake, { model: 'agent-timeout', cases: ['privacy-safe-answer'], extra: ['--timeout-ms', '600'] });
  assert.equal(timeout.report.status, 'ERROR');
  const record = JSON.parse(await readFile(path.join(timeout.output, 'execution/privacy-safe-answer/record.json'), 'utf8'));
  assert.equal(record.phases[0].runtime.failure, 'TIMEOUT');
  assert.match(record.phases[0].visible[0].text, /Partial visible/);
  const overflow = await live(root, fake, { model: 'agent-overflow', cases: ['privacy-safe-answer'], extra: ['--max-output-bytes', '65536'] });
  assert.equal(overflow.report.status, 'ERROR');
});
