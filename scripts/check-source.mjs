import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readlink, mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const publicationCredentialNames = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN',
];

export function hasPublicationCredentials(env = process.env) {
  return publicationCredentialNames.some(name => Boolean(env[name]));
}

export function requireNoPublicationCredentials(env = process.env) {
  if (hasPublicationCredentials(env)) {
    throw new Error('Publication credentials are present. Run npm run check:push in a separate credential-free container command before the authenticated push; no tests or builds were started.');
  }
}

export function requireContainer() {
  execFileSync('sh', [fileURLToPath(new URL('require-container.sh', import.meta.url))], { stdio: 'inherit' });
}

// Git exports repository locators to hooks. A fixture or explicit -C must select its own repository.
export function gitEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|NAMESPACE|CEILING_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)));
}

export function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', env: gitEnvironment(), maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

const digest = files => createHash('sha256').update(JSON.stringify(files)).digest('hex');
const order = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export async function sourceState(root) {
  const head = git(root, 'rev-parse', '--verify', 'HEAD');
  if (git(root, 'ls-files', '--unmerged', '-z')) throw new Error('Resolve unmerged files before verification.');
  const algorithm = git(root, 'rev-parse', '--show-object-format');
  if (!['sha1', 'sha256'].includes(algorithm)) throw new Error('Unsupported Git object format.');
  const paths = [...new Set(git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))];
  const files = [];
  for (const path of paths) {
    const absolute = join(root, path);
    let info;
    try { info = await lstat(absolute); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      files.push({ path, mode: 'missing', oid: null });
      continue;
    }
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Source must contain files, not a submodule or special file: ${path}`);
    const bytes = info.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
    const mode = info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644';
    const oid = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    files.push({ path, mode, oid });
  }
  files.sort(order);
  if (git(root, 'rev-parse', '--verify', 'HEAD') !== head) throw new Error('Source changed while taking the verification snapshot (HEAD). Rerun the checks.');
  return { head, digest: digest(files), files };
}

export function committedState(root, commit) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Expected an exact commit object ID.');
  const files = git(root, 'ls-tree', '-rz', '--full-tree', commit).split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (!match || match[2] !== 'blob') throw new Error('Verification does not support submodules or non-blob source entries.');
    return { path: match[4], mode: match[1], oid: match[3] };
  }).sort(order);
  return { head: commit, tree: git(root, 'rev-parse', `${commit}^{tree}`), digest: digest(files), files };
}

export function assertUnchanged(before, after) {
  if (before.head === after.head && before.digest === after.digest) return;
  const oldFiles = new Map(before.files.map(file => [file.path, JSON.stringify(file)]));
  const newFiles = new Map(after.files.map(file => [file.path, JSON.stringify(file)]));
  const changed = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].filter(path => oldFiles.get(path) !== newFiles.get(path));
  throw new Error(`Source changed during verification (${changed.slice(0, 8).join(', ') || 'HEAD'}). Rebuild intentionally if needed, review the changes, and rerun the checks; no verification receipt is valid for this run.`);
}

export async function requireCommittedSource(root, state) {
  state ??= await sourceState(root);
  const committed = committedState(root, state.head);
  if (state.digest !== committed.digest) {
    throw new Error('Push/CI verification requires clean committed source, including untracked files and executable modes. Review and commit the intended files, then run npm run check:push without credentials. Use npm run check for an uncommitted working tree.');
  }
  return committed;
}

export async function verificationEnvironment() {
  const scratch = await mkdtemp(join(tmpdir(), 'encbird-check-env-'));
  const userConfig = join(scratch, 'npm-user.conf');
  const globalConfig = join(scratch, 'npm-global.conf');
  await writeFile(userConfig, '');
  await writeFile(globalConfig, '');
  return {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', CI: 'true', TMPDIR: scratch,
      XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
      NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: join(scratch, 'npm-cache'), NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    },
    cleanup: () => rm(scratch, { recursive: true, force: true }),
  };
}

export function receiptPath(root, commit) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Expected an exact receipt commit.');
  return resolve(root, git(root, 'rev-parse', '--git-path', `encbird-verification/${commit}.json`));
}

export async function removeReceipt(root, commit) {
  await rm(receiptPath(root, commit), { force: true });
}

export async function writeReceipt(root, committed) {
  const path = receiptPath(root, committed.head);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const receipt = {
    schemaVersion: 1, command: 'npm run check:push', commit: committed.head,
    tree: committed.tree, sourceSha256: committed.digest,
    node: process.versions.node, checkedAt: new Date().toISOString(),
  };
  try {
    await writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

export async function verifyReceipt(root, state) {
  state ??= await sourceState(root);
  const committed = await requireCommittedSource(root, state);
  try {
    const path = receiptPath(root, committed.head);
    if (!(await lstat(path)).isFile()) throw new Error('Receipt is not a regular file.');
    const receipt = JSON.parse(await readFile(path, 'utf8'));
    if (receipt.schemaVersion !== 1 || receipt.command !== 'npm run check:push' ||
        receipt.commit !== committed.head || receipt.tree !== committed.tree || receipt.sourceSha256 !== committed.digest) {
      throw new Error('Receipt does not match this complete source.');
    }
    return receipt;
  } catch {
    throw new Error(`No matching verification receipt for ${committed.head}. Run npm run check:push in a separate credential-free command inside this project's container, then retry the same push. The authenticated source verifier never runs npm, tests, or builds.`);
  }
}
