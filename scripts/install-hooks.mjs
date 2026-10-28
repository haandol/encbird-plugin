import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, rename, chmod, copyFile, realpath, readlink } from 'node:fs/promises';
import { basename, dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicationCredentialNames } from './check-source.mjs';
const signature = '# EncBird Docker-only pre-push v3';
const ownedSignatures = [signature, '# EncBird Docker-only pre-push v2', '# EncBird Docker-only pre-push v1'];
const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
const root = git('rev-parse', '--show-toplevel');
if (await realpath(root) !== await realpath(fileURLToPath(new URL('../', import.meta.url)))) {
  throw new Error('Run hook installation from this plugin repository; another repository is not modified.');
}
const hooks = resolve(root, git('rev-parse', '--git-common-dir'), 'hooks');
const path = join(hooks, 'pre-push');
const previous = join(hooks, 'pre-push.encbird-previous');
try {
  const directory = await lstat(hooks);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('The repository hooks directory must be a real directory; linked or shared hook directories are not modified.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }

// Follow only filesystem delegation, including a dangling final hook target; never execute a security runner.
async function staticPath(candidate, depth = 0) {
  if (depth > 40) throw new Error('Hook delegation has too many links or missing path components.');
  try {
    if ((await lstat(candidate)).isSymbolicLink()) return staticPath(resolve(dirname(candidate), await readlink(candidate)), depth + 1);
    return await realpath(candidate);
  } catch (error) {
    if (error.code !== 'ENOENT' || dirname(candidate) === candidate) throw error;
    return join(await staticPath(dirname(candidate), depth + 1), basename(candidate));
  }
}
const effective = resolve(root, git('rev-parse', '--git-path', 'hooks/pre-push'));
if (await staticPath(effective) !== await staticPath(path)) {
  throw new Error(`Git selects ${effective}, which does not statically delegate to ${path}. Hook installation made no changes. Integrate the existing security runner without disabling it, then retry.`);
}
await mkdir(hooks, {recursive:true});
try {
  const existing = await lstat(path);
  if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Inspect the existing pre-push hook; nonregular hooks are not replaced.');
  const body = await readFile(path, 'utf8');
  if (!ownedSignatures.some(value => body.startsWith('#!/bin/sh\n' + value + '\n'))) {
    try { await lstat(previous); throw new Error('An earlier hook backup already exists; inspect both hooks before installing.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await copyFile(path, previous, constants.COPYFILE_EXCL);
    await chmod(previous, existing.mode & 0o777);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const credentialPresence = publicationCredentialNames.map(name => '${' + name + ':+x}').join('');
const childSecrets = [...publicationCredentialNames, 'NODE_OPTIONS', 'NODE_PATH'].join(' ');
const script = `#!/bin/sh
${signature}
set -eu
marker=/usr/local/share/encbird-plugin/container
if [ "$(uname -s)" != Linux ] || [ ! -f /.dockerenv ] || [ ! -f "$marker" ] || [ "$(cat "$marker")" != encbird-plugin-devcontainer-v1 ]; then
    printf '%s\\n' 'EncBird Plugin pushes must run inside its .devcontainer.' >&2
    exit 1
fi
common=$(git rev-parse --git-common-dir)
root=$(git rev-parse --show-toplevel)
previous="$common/hooks/pre-push.encbird-previous"
umask 077
refs=$(mktemp "\${TMPDIR:-/tmp}/encbird-pre-push.XXXXXX")
trap 'rm -f "$refs"' 0
trap 'exit 1' HUP INT TERM
cat > "$refs"
verify_source() (
    unset ${childSecrets}
    node "$root/scripts/pre-push.mjs" "$@" < "$refs"
)
if [ -n "${credentialPresence}" ]; then
    verify_source --receipt-only "$@"
else
    verify_source "$@"
fi
if [ -x "$previous" ]; then
    (
        unset ${childSecrets}
        "$previous" "$@" < "$refs"
    )
fi
verify_source --receipt-only "$@"
`;
const temp = path + '.encbird-installing';
await writeFile(temp, script, {mode:0o755, flag:'wx'});
await chmod(temp,0o755);
await rename(temp,path);
console.log('Installed the effective repository pre-push guard; existing hook and core.hooksPath are preserved.');
