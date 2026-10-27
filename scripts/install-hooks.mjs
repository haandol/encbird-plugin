import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, rename, chmod, copyFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const signature = '# EncBird Docker-only pre-push v1';
const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
const root = git('rev-parse', '--show-toplevel');
if (await realpath(root) !== await realpath(fileURLToPath(new URL('../', import.meta.url)))) {
  throw new Error('Run hook installation from this plugin repository; another repository is not modified.');
}
const hooks = resolve(root, git('rev-parse', '--git-common-dir'), 'hooks');
await mkdir(hooks, {recursive:true});
const path = join(hooks, 'pre-push');
const previous = join(hooks, 'pre-push.encbird-previous');
try {
  const existing = await lstat(path);
  if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Inspect the existing pre-push hook; nonregular hooks are not replaced.');
  if (!(await readFile(path,'utf8')).startsWith('#!/bin/sh\n'+signature+'\n')) {
    try { await lstat(previous); throw new Error('An earlier hook backup already exists; inspect both hooks before installing.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await copyFile(path, previous, constants.COPYFILE_EXCL);
    await chmod(previous, existing.mode & 0o777);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const script = `#!/bin/sh
${signature}
set -eu
marker=/usr/local/share/encbird-plugin/container
if [ "$(uname -s)" != Linux ] || [ ! -f /.dockerenv ] || [ ! -f "$marker" ] || [ "$(cat "$marker")" != encbird-plugin-devcontainer-v1 ]; then
    printf '%s\\n' 'EncBird Plugin pushes must run inside its .devcontainer.' >&2
    exit 1
fi
common=$(git rev-parse --git-common-dir)
previous="$common/hooks/pre-push.encbird-previous"
if [ -x "$previous" ]; then
    exec "$previous" "$@"
fi
`;
const temp = path + '.encbird-installing';
await writeFile(temp, script, {mode:0o755, flag:'wx'});
await chmod(temp,0o755);
await rename(temp,path);
console.log('Installed the repository pre-push guard; existing hook and core.hooksPath are preserved.');
