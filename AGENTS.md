# Project instructions

## Documentation and public scope

- Keep the repository and plugin package `README.md` files focused on installation, configuration, usage, supported environments, and licensing for end users.
- Put public plugin development, validation, and implementation documentation in `docs/` and link it from the [documentation index](docs/README.md).
- `docs/` is public too. Do not include EncBird service private source code, storage structures, operational infrastructure, or internal validation procedures in documentation, examples, specification metadata, or code comments.
- Preserve public API contracts and information required to run the client. Removing internal implementation descriptions must not change request or response formats, error conditions, authentication requirements, or authorization rules.

## Documentation language

- Write end-user documentation in Korean, including the repository and plugin package READMEs and any user-facing installation, configuration, or usage guides. Display the Korean and English EncBird brand names together in user-facing headings, prose, link labels, and image alt text. Preserve exact commands, URLs, and legal notices.
- Write agent-facing and maintenance documentation in English, including this `AGENTS.md`, every `SKILL.md`, skill references, and development and runtime documentation under `docs/`. Apply the same language to headings, descriptive metadata, example explanations, and diagram labels.
- Choose the language by the document's audience, not its filename or whether it is publicly accessible. `docs/README.md` is an English maintenance index; public availability does not make it an end-user guide.
- Preserve original license texts, legal notices, external source quotations, and exact technical identifiers. Documentation language does not change the language of learner content or the user's conversation.

## Local Git pushes

- Run every local `git push` inside a Docker container, never directly on the host. Use an image built from this repository's `.devcontainer/Dockerfile`. `devcontainer` refers to the execution environment, not a branch name.
- Check the working tree, current branch, remote, and push target first. Unless the user specifies a target, use the current branch's upstream remote branch. If no upstream exists and the target is unclear, ask the user.
- Pass the host's `gh` login credential to the container through standard input. Never print the token or store it in a file, command-line argument, or Git remote URL. Use `gh auth git-credential` inside the container.
- Mount the repository at `/workspaces/encbird-plugin` in a disposable container. Do not modify the host's global Git configuration.
- Wait for the push to finish and verify that the remote branch commit matches local `HEAD`. After an interrupted push, check whether it took effect before retrying. Do not force-push without an explicit request.

### Example

Run from the repository root with Docker running and a successful host `gh auth status`. This example pushes to the current branch's upstream.

```sh
git status --short --branch
git remote -v
gh auth status
docker build -t encbird-plugin-devcontainer:local .devcontainer
```

After the image builds successfully, run the following script. The host retrieves credentials and starts the container; the container performs the push and verifies the remote commit.

```sh
python3 - <<'PY'
from pathlib import Path
import subprocess


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


root = git('rev-parse', '--show-toplevel')
branch = git('symbolic-ref', '--short', 'HEAD')
remote = git('config', '--get', f'branch.{branch}.remote')
target = git('config', '--get', f'branch.{branch}.merge')
if remote == '.' or not target.startswith('refs/heads/'):
    raise SystemExit('Configure a remote branch upstream before running this script.')

credential = subprocess.run(
    ['gh', 'auth', 'token'], check=True, capture_output=True, text=True
).stdout.strip()
if not credential:
    raise SystemExit('Could not retrieve a GitHub authentication token.')

script = '''set -eu
read -r GH_TOKEN
export GH_TOKEN
export GIT_TERMINAL_PROMPT=0
remote="$1"
target="$2"
git_auth() {
    git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"
}
git_auth push "$remote" "HEAD:$target"
expected=$(git rev-parse HEAD)
actual=$(git_auth ls-remote --heads "$remote" "$target" | cut -f1)
test "$expected" = "$actual"
printf 'Verified %s: %s\\n' "$target" "$actual"
'''
result = subprocess.run(
    ['docker', 'run', '--rm', '-i',
     '--mount', f'type=bind,source={Path(root)},target=/workspaces/encbird-plugin',
     'encbird-plugin-devcontainer:local',
     'sh', '-c', script, 'encbird-plugin-push', remote, target],
    input=credential + '\n', text=True,
)
raise SystemExit(result.returncode)
PY
```

If the user specifies a different remote branch, set `remote` and `target` to that confirmed destination. If authentication or Docker execution fails, resolve the cause and retry through Docker; do not fall back to pushing directly from the host.
