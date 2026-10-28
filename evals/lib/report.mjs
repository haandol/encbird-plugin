import { families } from '../cases.mjs';
import { combineStatus } from './grade.mjs';

export function summarize(manifest, cases, execution = {}) {
  const status = combineStatus([...cases.map(item => item.status), ...(execution.state === 'error' ? ['ERROR'] : [])]);
  const evaluationKind = manifest.mode === 'prepare' ? 'prepared' : [execution.target?.kind, execution.judge?.kind].includes('deterministic-test-double') ? 'deterministic-fixture' : execution.target ? 'live-cli' : 'live-request-not-executed';
  return { schemaVersion: 1, runId: manifest.runId, mode: manifest.mode, createdAt: manifest.createdAt, status,
    evaluationKind,
    scope: evaluationKind === 'deterministic-fixture' ? 'Deterministic harness fixtures only. Fake verdict validation does not verify live model semantics or production readiness.' : 'Synthetic scenarios only. Action checks and optional model judgments are separate; no general reliability or production-readiness claim.',
    execution, cases,
    counts: Object.fromEntries(['PASS', 'FAIL', 'ERROR', 'UNVERIFIED', 'NOT RUN'].map(label => [label, cases.filter(item => item.status === label).length])),
    calls: cases.reduce((total, item) => ({ attempted: total.attempted + item.actions.calls.attempted, completed: total.completed + item.actions.calls.completed, error: total.error + item.actions.calls.error }), { attempted: 0, completed: 0, error: 0 }),
  };
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const groups = {
  consent: [['New quotes', id => ['consent-credits', 'consent-free-trial'].includes(id)], ['Existing decisions', id => id.includes('already-approved')], ['Unclear decisions', () => true]],
  review: [['Waiting for learner input', id => ['review-waits', 'review-ambiguous-rating'].includes(id)], ['Explicit choices and assistance', id => id.startsWith('review-rating-')], ['Rejected results', () => true]],
  privacy: [['Unsafe original answer', id => id === 'privacy-withhold-answer'], ['Safe original answer', () => true]],
  recovery: [['Limited reads', id => ['recovery-overload', 'recovery-partial-read'].includes(id)], ['Uncertain operations', id => ['recovery-exact-retry', 'recovery-lost-key'].includes(id)], ['Funding errors', () => true]],
};

export function renderHTML(report, snapshots, executions) {
  const body = Object.entries(families).map(([family, info]) => {
    const remaining = new Set(report.cases.filter(item => item.family === family));
    const sections = groups[family].map(([name, accepts]) => {
      const items = [...remaining].filter(item => accepts(item.id));
      for (const item of items) remaining.delete(item);
      if (!items.length) return '';
      return `<section><h3>${escape(name)}</h3>${items.map(result => {
        const snapshot = snapshots.find(item => item.id === result.id);
        const record = executions[result.id];
        const concerns = [...result.actions.checks, ...result.semantic.checks].filter(item => item.status !== 'PASS');
        return `<article id="${escape(result.id)}"><h4>${escape(result.title)} <span class="status">${escape(result.status)}</span></h4>
<p>Action evidence: <strong>${escape(result.actions.status)}</strong>. Visible-response meaning: <strong>${escape(result.semantic.status)}</strong>.</p>
${concerns.length ? `<p>${escape([...new Set(concerns.map(item => item.reason ?? item.code))].join(' · '))}</p>` : ''}
<p>${escape(result.semantic.reason)}</p>
<details><summary>Original user phases and required behavior</summary>${snapshot.phases.map(phase => `<h5>${escape(phase.id)}</h5><blockquote>${escape(phase.user.text)}</blockquote>`).join('')}
${snapshot.semantics.map(item => `<p><strong>${escape(item.id)}</strong>: ${escape(item.rule)}</p>`).join('')}<a href="snapshot/cases/${escape(result.id)}.json">Complete immutable case snapshot</a></details>
<details><summary>Captured responses, calls, results, and judgment evidence</summary><pre>${escape(JSON.stringify({ execution: record ?? { state: 'not_run' }, actions: result.actions, semantic: result.semantic }, null, 2))}</pre></details></article>`;
      }).join('')}</section>`;
    }).join('');
    return sections ? `<section aria-labelledby="${family}"><h2 id="${family}">${escape(info.title)}</h2><p>${escape(info.description)}</p>${sections}</section>` : '';
  }).join('');
  const message = report.mode === 'prepare'
    ? 'No target or semantic judge was run. These are prepared cases, not successful behavior evaluations.'
    : report.evaluationKind === 'deterministic-fixture' ? 'This is a deterministic harness test with a fake runtime. Its action and judgment-validation results do not establish live model behavior; live semantics remain unverified.'
    : 'A case passes only when required action evidence and a separate, evidence-validated semantic judgment both pass. Known required failures dominate execution errors and missing evidence.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>EncBird Skill behavior evaluation</title>
<style>body{margin:0;background:#fff;color:#20242b;font:16px/1.6 system-ui,sans-serif}main{max-width:70rem;margin:auto;padding:2rem clamp(1rem,4vw,3rem)}p,blockquote{max-width:78ch}h1,h2,h3,h4{line-height:1.3;text-wrap:balance}h2{margin-top:3rem;border-top:1px solid #d8dee6;padding-top:1.4rem}h3{margin-top:2rem}h4{margin-bottom:.6rem}article{margin:1.5rem 0 2rem}a{color:#155ca2;overflow-wrap:anywhere}p,blockquote{overflow-wrap:anywhere}blockquote{border-left:3px solid #cbd5e1;margin:1rem 0;padding-left:1rem;white-space:pre-wrap}.answer{padding:1rem 1.3rem;border:1px solid #aab6c5;border-radius:.4rem;margin:1.5rem 0}.status{font-size:.85em;border:1px solid #94a3b8;border-radius:.2rem;padding:.1rem .4rem;white-space:nowrap}details{margin:.8rem 0}summary{cursor:pointer;color:#23476d}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7f9;padding:1rem;font:13px/1.6 ui-monospace,monospace;max-height:38rem;overflow:auto}:focus-visible{outline:3px solid #2875bb;outline-offset:3px}small{color:#4b5563}@media print{main{padding:0}h2,h3,h4,h5{break-after:avoid}pre{max-height:none;overflow:visible}.answer{break-inside:avoid}a{color:inherit}}@media(max-width:600px){h1{font-size:1.7rem}.status{display:inline-block;margin-top:.25rem}}</style></head>
<body><main><h1>EncBird Skill behavior evaluation</h1><section><h2>Purpose</h2><p>Determine which consent, learning-evidence, privacy, and recovery behaviors were actually observed, and which still need execution or judgment.</p></section>
<section><h2>Context</h2><p>The target receives the public Skill and synthetic user phases. A local fixture records attempted tool calls before validation; only those records establish effects. A separate optional judge interprets captured visible responses against the original user inputs. All learner content here is invented test data.</p></section>
<div class="answer"><strong>Run result: ${escape(report.status)}</strong><p>${escape(message)}</p><p>${escape(report.execution.error ?? '')}</p><p>Fixture calls: ${report.calls.attempted} attempted, ${report.calls.completed} completed, ${report.calls.error} returned errors. Expected service errors are recorded scenario outcomes; these counts are not reliability measurements.</p></div>
${body}<footer><p>${escape(report.scope)}</p><p>Source and evidence: <a href="manifest.json">manifest</a>, <a href="report.json">machine-readable report</a>, <a href="seal.json">artifact hashes</a>.</p><small>Run ${escape(report.runId)} · ${escape(report.createdAt)}. Stopping a local child process does not establish that provider billing has stopped. No browser or print verification is implied.</small></footer></main></body></html>\n`;
}

export function consoleReport(report) {
  return [`${report.status} — EncBird Skill behavior evaluation (${report.mode}; ${report.evaluationKind})`, ...report.cases.map(item => `${item.status.padEnd(10)} ${item.id} | actions: ${item.actions.status}; semantics: ${item.semantic.status}`),
    ...(report.execution.error ? [`Execution error: ${report.execution.error}`] : []),
    `Fixture calls: ${report.calls.attempted} attempted, ${report.calls.completed} completed, ${report.calls.error} errors. No reliability estimate.`, report.scope].join('\n');
}

