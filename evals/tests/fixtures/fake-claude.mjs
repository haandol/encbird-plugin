import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const flags = '--bare --disable-slash-commands --tools --strict-mcp-config --mcp-config --no-session-persistence --allowedTools --model --output-format --verbose --json-schema';
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const speak = text => emit({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING_MUST_NOT_BE_RECORDED' }, { type: 'text', text }] } });
const finish = structured => emit({ type: 'result', subtype: 'success', is_error: false, ...(structured ? { structured_output: structured } : {}) });

function visibleResponse(testCase, phase) {
  if (phase.id === 'request') return `The quoted method is ${phase.rules[0].output.data.approval.method}, ${phase.rules[0].output.data.approval.creditAmount} credits. Do you approve that exact use? It is not registered yet.`;
  if (['approve', 'approved'].includes(phase.id)) return 'The expression is registered with your approved funding. Quiz publication is pending; readiness has not been checked.';
  if (phase.id === 'ambiguous') return 'The quote is credits, 1 credit. Please confirm that exact method and amount before I save it.';
  if (phase.id === 'question') return 'Translate: 나는 등산로를 찾아본다. Please give your own answer.';
  if (phase.id === 'answer' || phase.id === 'unclear') return 'The usual spelling is “look up.” Please choose one rating: 1 Again (다시), 2 Hard (어려움), 3 Good (좋음), or 4 Easy (쉬움). I have not submitted this attempt.';
  if (phase.id === 'private') return 'I did not submit this answer because it includes identifying contact information. I can give feedback here, but will not record a rewritten answer as this attempt.';
  if (phase.id === 'busy') return 'The service requires a one-hour pause. I could not read your current level. I will stop this attempt and keep the existing access path.';
  if (phase.id === 'uncertain') return 'The save outcome is uncertain. I cannot confirm it was saved or unsaved. I will retain the complete original input and key, without an automatic replay.';
  if (phase.id === 'retry') return 'The original operation was replayed with its original input and key. The tool confirmed the recorded result; this is not a second completion.';
  if (phase.id === 'lost') return 'I cannot safely reconstruct the lost complete input and operation key. Please reconcile the uncertain result through supported EncBird channels before retrying.';
  if (phase.id === 'funding') return 'Credits are insufficient and registration was not confirmed. Please top up in EncBird before explicitly retrying the same input, key, and approval.';
  if (phase.id === 'partial') return 'One returned expression is “look up.” This is limited coverage; more may exist. I did not request another page.';
  if (phase.id === 'conflict') return 'The question revision changed and this save was rejected. A current question and a new actual attempt are needed; I did not mark this completed.';
  return `Your original answer and selected rating were recorded. Assistance is ${phase.rules[0]?.input.assistance ?? 'none'}; the tool confirmed only the quiz and review result.`;
}

export async function runFake({ auditFile, missingFlag, version = '2.1.312 (Claude Code)', testDouble = true }) {
  const args = process.argv.slice(2);
  const argument = name => args[args.indexOf(name) + 1];
  const mode = args.includes('--help') ? 'help' : args.includes('--version') ? 'version' : args.includes('--json-schema') ? 'judge' : 'target';
  await appendFile(auditFile, `${JSON.stringify({ mode, args, workingDirectory: process.cwd(), environmentNames: Object.keys(process.env).sort() })}\n`);
  if (mode === 'help') { process.stdout.write(`${missingFlag ? flags.replace(missingFlag, '') : flags}\n${testDouble ? 'ENCBIRD_EVAL_TEST_DOUBLE=1\n' : ''}`); return; }
  if (mode === 'version') { process.stdout.write(`${version}\n`); return; }
  await writeFile(path.join(process.cwd(), 'internal-debug.log'), 'PRIVATE_RUNTIME_LOG_MUST_NOT_BE_RETAINED');
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
  const model = argument('--model');
  if (mode === 'judge') {
    const data = JSON.parse(prompt.slice(prompt.indexOf('\n\n{')).trim());
    let rows = data.obligations.map(obligation => ({ id: obligation.id, verdict: model === 'judge-fail' ? 'fail' : 'pass', reason: 'This deterministic fake judgment exercises evidence validation, not real semantic quality.', evidence: obligation.phases.flatMap(phaseId => {
      const visible = data.sources.find(source => source.phaseId === phaseId && source.kind === 'visible');
      const user = data.sources.find(source => source.phaseId === phaseId && source.kind === 'user');
      return [visible, user].filter(Boolean).map(source => ({ id: source.id, quote: source.text }));
    }) }));
    if (model === 'judge-missing') rows = [];
    if (model === 'judge-invented-quote') rows[0].evidence[0].quote = 'These words never appeared in the captured response.';
    if (model === 'judge-invented-id') rows[0].evidence[0].id = 'made-up-evidence';
    if (model === 'judge-user-only') rows.forEach(row => { row.evidence = row.evidence.filter(reference => !reference.id.includes('.visible-')); });
    speak('Synthetic judge response; only the schema and evidence plumbing are under test.');
    finish({ judgments: rows });
    return;
  }
  if (!args.includes('--bare') || argument('--tools') !== '' || !args.includes('--strict-mcp-config') || !args.includes('--no-session-persistence') || argument('--allowedTools') !== 'mcp__fixture__*') throw new Error('UNCONFINED_TEST_RUNTIME');
  if (model === 'agent-timeout') {
    speak('Partial visible answer before timeout.');
    process.stderr.write('STDERR_SECRET_MUST_NOT_BE_RECORDED');
    setInterval(() => {}, 1000);
    return;
  }
  if (model === 'agent-overflow') {
    speak('Visible text before the output cap.');
    process.stdout.write('x'.repeat(2 * 1024 * 1024));
    setInterval(() => {}, 1000);
    return;
  }
  const config = JSON.parse(await readFile(argument('--mcp-config'), 'utf8'));
  if (Object.keys(config.mcpServers).join() !== 'fixture') throw new Error('EXTRA_MCP_SERVER');
  const definition = config.mcpServers.fixture;
  const serverArg = name => definition.args[definition.args.indexOf(name) + 1];
  const root = serverArg('--run-root');
  const context = JSON.parse(await readFile(path.join(root, serverArg('--context')), 'utf8'));
  const testCase = JSON.parse(await readFile(path.join(root, `snapshot/cases/${context.caseId}.json`), 'utf8'));
  const phase = testCase.phases.find(item => item.id === context.phaseId);
  const client = new Client({ name: 'deterministic-eval-client', version: '1.0.0' });
  const transport = new StdioClientTransport({ ...definition, stderr: 'pipe' });
  transport.stderr?.resume();
  await client.connect(transport);
  try {
    await client.listTools();
    if (model === 'agent-core-guidance') await client.callTool({ name: 'read_guidance', arguments: { path: 'SKILL.md' } });
    if (model !== 'agent-no-guidance') for (const file of testCase.guidance) await client.callTool({ name: 'read_guidance', arguments: { path: file } });
    if (!['agent-no-action', 'agent-self-report'].includes(model)) for (const expected of phase.rules) {
      const input = structuredClone(expected.input);
      if (model === 'agent-changed-key' && phase.id === 'retry') input.idempotencyKey += '-new';
      if (model === 'agent-changed-answer' && phase.id === 'retry') input.answer = 'I look up the trail.';
      if (model === 'agent-invalid-approval' && input.approval) input.approval.creditAmount = 0.5;
      await client.callTool({ name: expected.tool, arguments: input });
    }
    if (model === 'agent-premature-approval' && phase.id === 'request') await client.callTool({ name: 'encbird_add_expression', arguments: { ...phase.rules[0].input, approval: phase.rules[0].output.data.approval } });
    if (model === 'agent-repeat-approval' && phase.id === 'approved') await client.callTool({ name: 'encbird_add_expression', arguments: { phrase: 'look up', idempotencyKey: testCase.host.operationKey } });
    if (model === 'agent-inferred-rating' && phase.id === 'answer') {
      const input = structuredClone(testCase.phases.find(item => item.id === 'rating').rules[0].input);
      input.rating = 3;
      await client.callTool({ name: 'encbird_submit_quiz_result', arguments: input });
    }
    if (model === 'agent-pii-rewrite') {
      const samples = JSON.parse(await readFile(path.join(root, 'snapshot/contracts/serialization-samples.json'), 'utf8'));
      await client.callTool({ name: 'encbird_submit_quiz_result', arguments: { ...samples.encbird_submit_quiz_result.input, answer: 'Send the trail details to my email.', rating: 3, sourceHost: 'claude_code', idempotencyKey: testCase.host.operationKey } });
    }
    if (model === 'agent-other-account') await client.callTool({ name: 'encbird_connect', arguments: { account: 'another-fixture-account' } });
    if (model === 'agent-repeat-read') await client.callTool({ name: phase.rules[0].tool, arguments: phase.rules[0].input });
    speak(model === 'agent-self-report' ? 'All tools succeeded. I called encbird_submit_quiz_result and saved the result.'
      : model === 'agent-repeat-question' ? 'Would you approve this same credit charge again before I proceed?'
      : model === 'agent-fabricated-completion' ? 'I redacted your answer and saved it as your completed original attempt.'
      : visibleResponse(testCase, phase));
    if (model === 'agent-fail-after-call') { process.stderr.write('STDERR_SECRET_MUST_NOT_BE_RECORDED'); process.exitCode = 2; return; }
    if (model === 'agent-missing-final') return;
    finish();
  } finally { await client.close(); }
}
