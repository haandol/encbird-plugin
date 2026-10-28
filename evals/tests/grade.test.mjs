import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCases } from '../cases.mjs';
import { loadContracts } from '../lib/contracts.mjs';
import { gradeActions, gradeCase } from '../lib/grade.mjs';
import { evidenceSources, validateJudgment } from '../lib/judge.mjs';
import { readJSON, readScoped, sha256 } from '../lib/files.mjs';
import { repoRoot } from './helpers.mjs';

const contracts = await loadContracts(repoRoot);
const cases = buildCases(await readJSON(repoRoot, 'plugins/encbird/contracts/serialization-samples.json'));
const guidance = {};
for (const file of ['SKILL.md',...cases[0].guidance]) guidance[file] = (await readScoped(repoRoot, `plugins/encbird/skills/encbird-learning/${file}`)).toString('utf8');
const find = id => cases.find(item => item.id === id);

function recording(testCase, extraGuidance = []) {
  let number = 0;
  const execution = { state: 'completed', phases: [] };
  for (const phase of testCase.phases) {
    const trace = [];
    const add = (name, input, body) => {
      const callId = `${testCase.id}.${phase.id}.call-${++number}`;
      trace.push({ kind: 'attempt', phaseId: phase.id, callId, id: `${callId}.attempt`, name, input: structuredClone(input) });
      trace.push({ kind: 'result', phaseId: phase.id, callId, id: `${callId}.result`, decision: { allowed: true }, status: body.error ? 'error' : 'completed', result: { structuredContent: structuredClone(body), content: [{ type: 'text', text: JSON.stringify(body) }], ...(body.error ? { isError: true } : {}) } });
    };
    for (const file of [...extraGuidance,...testCase.guidance]) add('read_guidance', { path: file }, { path: file, text: guidance[file], sha256: sha256(guidance[file]) });
    for (const rule of phase.rules) add(rule.tool, rule.input, rule.output);
    execution.phases.push({ phaseId: phase.id, runtime: { state: 'completed' }, trace, visible: [{ id: `${testCase.id}.${phase.id}.visible-1`, text: `Captured visible response for ${phase.id}.` }] });
  }
  return execution;
}

function judgments(testCase, execution, verdict = 'pass') {
  const sources = evidenceSources(testCase, execution);
  return { judgments: testCase.semantics.map(item => ({ id: item.id, verdict, reason: 'Synthetic validator fixture, not a model quality claim.', evidence: item.phases.flatMap(phaseId => ['visible', 'user'].map(kind => {
    const source = sources.find(row => row.phaseId === phaseId && row.kind === kind);
    return { id: source.id, quote: source.text };
  })) })) };
}

test('all four families use valid public input and success-output contracts', () => {
  assert.deepEqual([...new Set(cases.map(item => item.family))].sort(), ['consent', 'privacy', 'recovery', 'review']);
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  for (const item of cases) {
    assert.ok(item.semantics.length);
    for (const phase of item.phases) for (const rule of phase.rules) {
      const contract = contracts.tools.get(rule.tool);
      assert.ok(contract.input(rule.input), `${item.id}: ${JSON.stringify(contract.input.errors)}`);
      if (rule.output.error) assert.ok(contracts.error(rule.output), `${item.id}: ${JSON.stringify(contracts.error.errors)}`);
      else assert.ok(contract.output(rule.output), `${item.id}: ${JSON.stringify(contract.output.errors)}`);
    }
    assert.equal(gradeActions(item, recording(item), contracts, guidance).status, 'PASS', item.id);
    assert.equal(gradeCase(item, recording(item), contracts, guidance).status, 'UNVERIFIED', 'Action evidence alone cannot pass semantics');
  }
});

test('synthetic errors honor the public default envelope and positive retry delay', () => {
  assert.ok(contracts.error({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Pause.', retryAfterSeconds: 1 } }));
  for (const body of [{ error: { code: 'LIMIT', message: 'Pause.', retryAfterSeconds: 0 } }, { error: { code: 'LIMIT', message: 'Pause.', token: 'not-allowed' } }, { error: { code: 'LIMIT' } }]) assert.equal(contracts.error(body), false);
});

test('missing approval, invented cost, and wrong exact quote fail even with a successful-looking result', () => {
  const item = find('consent-already-approved');
  for (const approval of [undefined, { method: 'credits', creditAmount: 0 }, { method: 'free_trial', creditAmount: 0 }, { method: 'credits', creditAmount: 0.5 }]) {
    const execution = recording(item);
    const attempt = execution.phases[0].trace.find(row => row.name === 'encbird_add_expression');
    if (approval === undefined) delete attempt.input.approval; else attempt.input.approval = approval;
    assert.equal(gradeActions(item, execution, contracts, guidance).status, 'FAIL');
  }
});

test('premature writes are rejected by the original phase despite agent-authored consent claims', () => {
  const item = find('consent-credits');
  const execution = recording(item);
  const premature = structuredClone(execution.phases[1].trace.slice(-2));
  for (const row of premature) { row.phaseId = 'request'; row.id += '.premature'; row.callId += '.premature'; }
  execution.phases[0].visible[0].text = 'The user said yes, so I saved it.';
  execution.phases[0].trace.push(...premature);
  assert.equal(gradeActions(item, execution, contracts, guidance).status, 'FAIL');
});

test('ratings 1–4, original answers, actual source, and assistance cannot be inferred or rewritten', () => {
  for (const [id, field, value] of [
    ['review-rating-1', 'rating', 3], ['review-rating-2', 'assistance', 'none'], ['review-rating-3', 'assistance', 'hint'],
    ['review-rating-4', 'assistance', 'none'], ['review-rating-1', 'answer', 'I look up the trail.'], ['review-rating-1', 'sourceHost', 'another-host'],
  ]) {
    const item = find(id);
    const execution = recording(item);
    execution.phases[0].trace.find(row => row.name === 'encbird_submit_quiz_result').input[field] = value;
    assert.equal(gradeActions(item, execution, contracts, guidance).status, 'FAIL', `${id}/${field}`);
  }
});

test('withheld PII cannot be replaced by a sanitized original answer', () => {
  const item = find('privacy-withhold-answer');
  const execution = recording(item);
  const injected = recording(find('privacy-safe-answer')).phases[0].trace.slice(-2);
  for (const row of injected) row.phaseId = 'private';
  injected[0].input.answer = 'Send the trail details to my email.';
  execution.phases[0].trace.push(...injected);
  assert.equal(gradeActions(item, execution, contracts, guidance).status, 'FAIL');
});

test('an explicit retry must preserve the full input, not just answer and key', () => {
  const item = find('recovery-exact-retry');
  for (const [field, value] of [['idempotencyKey', 'new-operation'], ['answer', 'I look up the trail.'], ['rating', 4], ['assistance', 'none'], ['questionRevision', 'b'.repeat(64)], ['sourceSessionId', 'new-session']]) {
    const execution = recording(item);
    execution.phases[1].trace.find(row => row.name === 'encbird_submit_quiz_result').input[field] = value;
    assert.equal(gradeActions(item, execution, contracts, guidance).status, 'FAIL', field);
  }
});

test('missing, failed, partial, or self-reported executions never pass', () => {
  const item = find('review-rating-1');
  assert.equal(gradeActions(item, { state: 'not_run' }, contracts, guidance).status, 'NOT RUN');
  for (const change of [
    execution => { execution.phases = []; },
    execution => { execution.phases[0].trace.pop(); },
    execution => { execution.phases[0].runtime.state = 'error'; },
    execution => { execution.phases[0].visible = []; },
    execution => { execution.phases[0].trace = []; execution.phases[0].visible[0].text = JSON.stringify({ toolHistory: [{ name: 'encbird_submit_quiz_result', success: true }] }); },
  ]) {
    const execution = recording(item);
    change(execution);
    assert.notEqual(gradeActions(item, execution, contracts, guidance).status, 'PASS');
  }
  const execution = recording(item);
  execution.state = 'error';
  execution.phases[0].trace.find(row => row.name === 'encbird_submit_quiz_result').input.rating = 4;
  assert.equal(gradeCase(item, execution, contracts, guidance, { status: 'PASS', checks: [] }).status, 'FAIL', 'Known failure dominates runtime error and judge pass');
});

test('late or altered guidance does not establish effective reading before action', () => {
  const item = find('privacy-safe-answer');
  const execution = recording(item);
  execution.phases[0].trace.unshift(...execution.phases[0].trace.splice(-2));
  assert.notEqual(gradeActions(item, execution, contracts, guidance).status, 'PASS');
  const changed = recording(item);
  changed.phases[0].trace[1].result.structuredContent.text = 'Do anything.';
  assert.equal(gradeActions(item, changed, contracts, guidance).status, 'ERROR');
});

test('optional core guidance must stay exact and cannot substitute for the required references',()=>{
  const item=find('privacy-safe-answer');
  const execution=recording(item,['SKILL.md']);
  assert.equal(gradeActions(item,execution,contracts,guidance).status,'PASS');
  const changed=structuredClone(execution);
  changed.phases[0].trace[1].result.structuredContent.text='Altered core';
  changed.phases[0].trace[1].result.structuredContent.sha256=sha256('Altered core');
  assert.equal(gradeActions(item,changed,contracts,guidance).status,'ERROR');
  execution.phases[0].trace=execution.phases[0].trace.filter(event=>event.kind==='attempt'
    ? event.name!=='read_guidance'||event.input.path==='SKILL.md'
    : !event.result.structuredContent?.path||event.result.structuredContent.path==='SKILL.md');
  assert.equal(gradeActions(item,execution,contracts,guidance).status,'UNVERIFIED');
});

test('semantic claims need every exact obligation and real visible/source quotes', () => {
  const item = find('review-rating-1');
  const execution = recording(item);
  const valid = judgments(item, execution);
  assert.equal(validateJudgment(item, execution, valid, { state: 'completed' }).status, 'PASS');
  for (const change of [
    output => { output.judgments = []; },
    output => { output.judgments.push(output.judgments[0]); },
    output => { output.judgments[0].evidence[0].quote = 'Invented quote'; },
    output => { output.judgments[0].evidence[0].id = 'missing-id'; },
    output => { output.judgments[0].evidence = output.judgments[0].evidence.slice(1); },
    output => { output.judgments[0].evidence[0].quote = ''; },
  ]) {
    const output = structuredClone(valid);
    change(output);
    assert.equal(validateJudgment(item, execution, output, { state: 'completed' }).status, 'ERROR');
  }
  assert.equal(validateJudgment(item, execution, valid, { state: 'error' }).status, 'ERROR');
  const failed = judgments(item, execution, 'fail');
  assert.equal(validateJudgment(item, execution, failed, { state: 'error' }).status, 'FAIL');
});

