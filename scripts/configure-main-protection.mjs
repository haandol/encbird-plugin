import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = 'haandol/encbird-plugin';
export const workflow = '.github/workflows/ci.yaml';
const policy = JSON.parse(readFileSync(new URL('./verification-policy.json', import.meta.url), 'utf8'));
if (policy.schemaVersion !== 1 || JSON.stringify(Object.keys(policy.checks ?? {}).sort()) !== '["build","runtime","test"]') throw new Error('Invalid verification policy.');
export const requiredChecks = ['test', 'build', 'runtime'].map(role => policy.checks[role]);
if (requiredChecks.some(name => typeof name !== 'string' || !name.trim()) || new Set(requiredChecks).size !== 3) throw new Error('Invalid required check names.');
const policyName = 'encbird-plugin-verification';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function desiredProtection() {
  return {
    name: policyName, target: 'branch', enforcement: 'active', bypass_actors: [],
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [
      { type: 'deletion' }, { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: {
        required_approving_review_count: 0, dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false, require_last_push_approval: false,
        required_review_thread_resolution: true, allowed_merge_methods: ['merge', 'squash', 'rebase'],
      } },
      { type: 'required_status_checks', parameters: {
        required_status_checks: requiredChecks.map(context => ({ context })),
        strict_required_status_checks_policy: true, do_not_enforce_on_create: false,
      } },
    ],
  };
}

export function satisfiesProtection(value) {
  if (!value || value.name !== policyName || value.target !== 'branch' || value.enforcement !== 'active') return false;
  if (!Array.isArray(value.bypass_actors) || value.bypass_actors.length) return false;
  const refs = value.conditions?.ref_name;
  if (JSON.stringify(refs?.include) !== '["refs/heads/main"]' || JSON.stringify(refs?.exclude) !== '[]') return false;
  if (!Array.isArray(value.rules)) return false;
  const rule = type => value.rules.find(item => item.type === type);
  if (!rule('deletion') || !rule('non_fast_forward')) return false;
  const review = rule('pull_request')?.parameters;
  if (!review || review.dismiss_stale_reviews_on_push !== true || review.required_review_thread_resolution !== true ||
      !Number.isInteger(review.required_approving_review_count) || review.required_approving_review_count < 0) return false;
  const checks = rule('required_status_checks')?.parameters;
  return checks?.strict_required_status_checks_policy === true && checks.do_not_enforce_on_create !== true &&
    requiredChecks.every(context => checks.required_status_checks?.some(item => item.context === context));
}

function exactId(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`GitHub returned an invalid ${name}.`);
  return value;
}

export function inspectProtection(io) {
  const local = io.local();
  const info = io.read(`repos/${repository}`);
  if (info.full_name !== repository || info.private !== false || info.default_branch !== 'main' || info.archived !== false || info.disabled !== false) {
    throw new Error('The target must be the active public haandol/encbird-plugin repository with default branch main.');
  }
  const branch = io.read(`repos/${repository}/branches/main`);
  const head = branch.commit?.sha;
  if (!/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('Remote main is unavailable or ambiguous.');
  const tree = io.read(`repos/${repository}/git/trees/${head}?recursive=1`);
  if (!Array.isArray(tree.tree) || tree.truncated) throw new Error('The complete remote source tree could not be verified.');
  const remoteWorkflow = tree.tree.find(item => item.path === workflow && item.type === 'blob');
  const blockers = [];
  if (local.dirty) blockers.push('Commit the complete local source before applying protection.');
  if (local.head !== head) blockers.push('The verified local commit must first be available as remote main.');
  if (!local.workflowOid || remoteWorkflow?.sha !== local.workflowOid) {
    blockers.push('Push the matching CI workflow to remote main before requiring its checks.');
  }

  let run = null;
  let checkedJobs = [];
  if (remoteWorkflow) {
    const history = io.read(`repos/${repository}/actions/workflows/ci.yaml/runs?head_sha=${head}&branch=main&per_page=100`);
    if (!Array.isArray(history.workflow_runs)) throw new Error('Workflow execution evidence is unavailable.');
    run = history.workflow_runs.find(item => item.head_sha === head && item.head_branch === 'main' &&
      item.path?.split('@')[0] === workflow) ?? null;
    if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
      blockers.push('Wait for the CI workflow on current remote main to finish successfully.');
    } else {
      exactId(run.id, 'workflow run ID');
      checkedJobs = io.jobs(`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
      if (!Array.isArray(checkedJobs)) throw new Error('Workflow job evidence is unavailable.');
      for (const name of requiredChecks) {
        const matching = checkedJobs.filter(item => item.name === name);
        if (matching.length !== 1 || matching[0].status !== 'completed' || matching[0].conclusion !== 'success') {
          blockers.push(`Required check ${name} has not succeeded unambiguously on this workflow run.`);
        }
      }
    }
  }
  const rulesets = io.rulesets(`repos/${repository}/rulesets?per_page=100`);
  if (!Array.isArray(rulesets)) throw new Error('Repository rulesets could not be inspected.');
  const matching = rulesets.filter(item => item.name === policyName);
  if (matching.length > 1) throw new Error('Multiple managed verification rulesets exist; inspect them before changing settings.');
  const existing = matching[0] ? io.read(`repos/${repository}/rulesets/${exactId(matching[0].id, 'ruleset ID')}`) : null;
  const compatible = existing && satisfiesProtection(existing);
  if (existing && !compatible) blockers.push('The existing managed ruleset differs; review it manually. It will not be replaced or weakened.');
  return {
    repository, sourceCommit: local.head, remoteMain: head,
    workflow: { path: workflow, localBlob: local.workflowOid, remoteBlob: remoteWorkflow?.sha ?? null, successfulRun: run?.conclusion === 'success' ? run.id : null },
    existingRulesetId: existing?.id ?? null, action: compatible ? 'unchanged' : 'create',
    ready: blockers.length === 0, blockers, proposedRuleset: desiredProtection(),
  };
}

export function configureProtection(io, apply = false) {
  const plan = inspectProtection(io);
  if (!apply) return { ...plan, applied: false };
  if (!plan.ready) throw new Error(plan.blockers.join('\n'));
  const fresh = inspectProtection(io);
  if (!fresh.ready) throw new Error(fresh.blockers.join('\n'));
  if (fresh.sourceCommit !== plan.sourceCommit || fresh.remoteMain !== plan.remoteMain ||
      fresh.workflow.remoteBlob !== plan.workflow.remoteBlob) throw new Error('Source changed while preparing protection; inspect the new state before applying.');
  if (fresh.action === 'unchanged') return { ...fresh, applied: false };
  const created = io.create(`repos/${repository}/rulesets`, fresh.proposedRuleset);
  const id = exactId(created.id, 'created ruleset ID');
  const saved = io.read(`repos/${repository}/rulesets/${id}`);
  if (!satisfiesProtection(saved)) throw new Error(`Ruleset ${id} was created but verification failed. Inspect it; do not recreate or overwrite it blindly.`);
  return { ...fresh, applied: true, existingRulesetId: id };
}

function command(file, args, options = {}) {
  const env = { ...process.env };
  for (const key of ['GH_DEBUG', 'GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_CURL_VERBOSE']) delete env[key];
  return execFileSync(file, args, { cwd: root, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
}

function liveIO() {
  const git = (...args) => command('git', args);
  if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].some(key => process.env[key])) throw new Error('Run protection management outside a Git hook or explicit repository-selector environment.');
  if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) throw new Error('Git must select this standalone plugin checkout.');
  const allowed = ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/']
    .flatMap(prefix => [prefix + repository, prefix + repository + '.git']);
  for (const direction of [[], ['--push']]) {
    if (!allowed.includes(git('remote', 'get-url', ...direction, '--all', 'origin'))) throw new Error('origin must select only public haandol/encbird-plugin.');
  }
  const api = (endpoint, args = [], input) => {
    try { return JSON.parse(command('gh', ['api', '--hostname', 'github.com', endpoint, ...args], { input })); }
    catch { throw new Error(`GitHub inspection or mutation failed at ${endpoint}. No success is assumed; inspect access and current state before retrying.`); }
  };
  return {
    local: () => {
      let workflowOid = null;
      try { workflowOid = git('rev-parse', '--verify', `HEAD:${workflow}`); } catch { /* An initial plan may precede the first CI commit. */ }
      return { head: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain=v1', '--untracked-files=all')), workflowOid };
    },
    read: endpoint => api(endpoint),
    jobs: endpoint => {
      const pages = api(endpoint, ['--paginate', '--slurp']);
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page.jobs))) throw new Error('Malformed workflow jobs response.');
      return pages.flatMap(page => page.jobs);
    },
    rulesets: endpoint => {
      const pages = api(endpoint, ['--paginate', '--slurp']);
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('Malformed rulesets response.');
      return pages.flat();
    },
    create: (endpoint, body) => api(endpoint, ['--method', 'POST', '--input', '-'], JSON.stringify(body)),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && !['--plan', '--apply', '--help'].includes(args[0]))) throw new Error('Usage: npm run ci:protect -- [--plan|--apply]');
    if (args[0] === '--help') {
      console.log('Plan main verification protection by default. --apply requires the project container, a clean commit on remote main, matching CI workflow, and successful test/build/runtime jobs. Existing differing rulesets are never replaced. No push, release or test runs occur.');
    } else {
      const apply = args[0] === '--apply';
      if (apply) command('sh', [join(root, 'scripts/require-container.sh')]);
      console.log(JSON.stringify(configureProtection(liveIO(), apply), null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
