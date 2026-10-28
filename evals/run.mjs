#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { families } from './cases.mjs';
import { executeRun, finalizeRun, prepareRun, reportRun, selectCases } from './lib/run.mjs';
import { consoleReport } from './lib/report.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const help = `EncBird Skill behavior evaluation

  node evals/run.mjs                         Prepare a new immutable NOT RUN report
  node evals/run.mjs --list                   List synthetic cases; no subprocesses
  node evals/run.mjs --report RUN_DIR         Verify and read an existing run; no subprocesses
  node evals/run.mjs [--case ID] [--family NAME] [--output NEW_DIR]
  node evals/run.mjs --live --cli ABSOLUTE_PATH --model MODEL --provider PROVIDER
      [--judge --judge-cli ABSOLUTE_PATH --judge-model MODEL --judge-provider PROVIDER]
      [--timeout-ms 90000] [--run-timeout-ms 900000] [--max-output-bytes 1048576]

prepare, list, and report are also accepted as subcommands. --live is a separate,
explicit paid-run choice. No model/provider fallback, OAuth/keychain discovery,
or credential provisioning. See docs/behavior-evaluation.md for supported auth.
Families: ${Object.keys(families).join(', ')}.
`;

export function parseArgs(argv) {
  const options = { mode: 'prepare', ids: [], live: false, judge: false, timeoutMs: 90_000, runTimeoutMs: 900_000, maxOutputBytes: 1024 * 1024 };
  let explicitMode = false;
  const value = index => { if (!argv[index] || argv[index].startsWith('--')) throw new Error('MISSING_OPTION_VALUE'); return argv[index]; };
  const mode = name => { if (explicitMode) throw new Error('CONFLICTING_MODES'); explicitMode = true; options.mode = name; };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--live') { options.live = true; continue; }
    if (arg === '--judge') { options.judge = true; continue; }
    if (arg === 'prepare' || arg === '--prepare') { mode('prepare'); continue; }
    if (arg === 'list' || arg === '--list') { mode('list'); continue; }
    if (arg === 'report' || arg === '--report') { mode('report'); options.report = value(++index); continue; }
    const values = { '--case': 'ids', '--family': 'family', '--output': 'output', '--cli': 'cli', '--model': 'model', '--provider': 'provider', '--judge-cli': 'judgeCli', '--judge-model': 'judgeModel', '--judge-provider': 'judgeProvider', '--timeout-ms': 'timeoutMs', '--run-timeout-ms': 'runTimeoutMs', '--max-output-bytes': 'maxOutputBytes' };
    const key = values[arg];
    if (!key) throw new Error('UNKNOWN_OPTION');
    const entry = value(++index);
    if (key === 'ids') options.ids.push(entry); else if (['timeoutMs', 'runTimeoutMs', 'maxOutputBytes'].includes(key)) options[key] = Number(entry); else options[key] = entry;
  }
  if ((options.live && explicitMode) || (options.mode !== 'prepare' && options.judge) || (options.judge && !options.live)) throw new Error('CONFLICTING_MODES');
  for (const [key, min, max] of [['timeoutMs', 1, 300_000], ['runTimeoutMs', 1, 3_600_000], ['maxOutputBytes', 128, 4 * 1024 * 1024]]) if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error('INVALID_PROCESS_LIMIT');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(help); return 0; }
  if (options.mode === 'report') {
    const { report } = await reportRun(path.resolve(options.report));
    process.stdout.write(`${consoleReport(report)}\n`);
    return report.mode === 'live' && report.status !== 'PASS' ? 1 : ['FAIL', 'ERROR'].includes(report.status) ? 1 : 0;
  }
  const cases = await selectCases(repoRoot, options.ids, options.family);
  if (options.mode === 'list') { process.stdout.write(`${cases.map(item => `${item.id}\t${item.family}\t${item.title}`).join('\n')}\nNOT RUN — listing does not execute a target or judge.\n`); return 0; }
  const prepared = await prepareRun({ repoRoot, output: options.output, cases, live: options.live });
  if (options.live) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      await executeRun(prepared, { repoRoot, target: { executable: options.cli, model: options.model, provider: options.provider }, judge: options.judge ? { executable: options.judgeCli, model: options.judgeModel, provider: options.judgeProvider } : null,
        timeoutMs: options.timeoutMs, runTimeoutMs: options.runTimeoutMs, maxOutputBytes: options.maxOutputBytes, signal: controller.signal });
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
  const report = await finalizeRun(prepared.root);
  process.stdout.write(`${consoleReport(report)}\nArtifacts: ${prepared.root}\n`);
  return options.live && report.status !== 'PASS' ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(error => {
  const code = error.code === 'EEXIST' ? 'OUTPUT_DIRECTORY_ALREADY_EXISTS' : /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'EVALUATION_ERROR';
  process.stderr.write(`${code}. No existing run was overwritten.\n`);
  process.exitCode = 1;
});
