# Continuous verification

Changes to the public plugin must pass code, build, and installed-runtime checks before reaching `main`. The checks run in images built from this repository's [Dockerfile](../.devcontainer/Dockerfile). They use mock services and synthetic evaluation fixtures. They do not sign in to a learner account, invoke paid models, push refs, or publish a release.

## Checks and environments

Run local commands in the project Dev Container. The [CI workflow](../.github/workflows/ci.yaml) builds the same image separately for its jobs; it does not use an arbitrary Node image as a substitute. The Dockerfile's `NODE_IMAGE` argument selects Node 24 by default or the supported floor, `node:22.12.0-alpine`. Agent platform CLIs are not installed into the plugin runtime.

| Command | What it verifies |
| --- | --- |
| `npm run check` | The current working-tree installation, versions, types, a matching rebuild, product mock tests, release/hook/provenance tests, evaluation fixtures, document links, and distribution validation. Uncommitted work is allowed; no push receipt is issued. |
| `npm run check:test` | Versions, types, product mock tests, `test:release`, `test:eval`, `validate:docs`, and `validate`, using the existing distribution. It never builds first. |
| `npm run check:build` | The existing installed bundle and skill CLI, then a rebuild and distribution validation. A changed output fails the check. |
| `npm run test:runtime` | MCP initialization and discovery of all 14 tools, plus the installed skill CLI's `list` and `describe` entry points, without `node_modules`. |
| `npm run check:push` | Clean current commit, installed runtime, a fresh `npm ci --ignore-scripts`, and the full checks. Only success creates a local receipt for that exact source. |

`-- --committed` on `check`, `check:test`, `check:build`, or `test:runtime` requires the working files to match the current commit, including executable modes and untracked files. CI uses this option. Development checks use the candidate files as they exist before the check; they do not silently switch to `HEAD` or replace them with files from another ref.

The [runtime smoke verifier](../scripts/runtime-smoke.mjs) copies the installed package layout into a temporary directory with no dependencies in it or its ancestors. It starts the bundled stdio server, initializes MCP, and requests `tools/list`. It also starts the skill's actual script and checks `list` and `describe encbird_add_expression`. All three processes use a temporary credential directory and a loopback-only API override; no connection or learning tool is called. Each process has a ten-second deadline. The verifier closes standard input after the requests and terminates remaining processes, escalating to a kill after one second when necessary.

The [check runner](../scripts/check.mjs) smokes the existing distribution **before** rebuilding. It fingerprints all tracked and non-ignored working files, including the bundles, build metadata, package lockfile, scripts, CI definitions, and Git executable modes. It compares those fingerprints after each stage. Rebuilding a stale bundle or `dist/build-info.json` changes the fingerprint and fails; a repaired output cannot make the original input pass. After an intentional source edit, run `npm run build`, review its output, and run `npm run check` again. Commit the complete matching source and distribution before requesting a push receipt.

## Local verification before an authorized push

Install or refresh the repository hook with `npm run hooks:install`; Dev Container startup does this too. Installation first verifies that the repository's hooks directory is a real directory, then resolves Git's effective pre-push path. A symlink at the hooks directory itself cannot redirect installation into a shared security directory. The effective hook may select the repository hook directly or a static filesystem symlink that delegates to it, including a not-yet-created final target. An opaque external runner is rejected before any hook, backup, or configuration is changed; setup never executes that runner to probe it. Preserve the runner and arrange verifiable delegation before retrying. Signing settings and `core.hooksPath` remain intact.

Run preparation in a container command that has **no publication credentials**:

```sh
# Inside the project container, after reviewing and committing the complete source.
npm run check:push
```

If using `docker exec`, use a separate invocation without the token relay:

```sh
docker exec CONTAINER_ID sh -c 'cd /workspaces/encbird-plugin && npm run check:push'
```

The command refuses nonempty `GH_TOKEN`, `GITHUB_TOKEN`, their enterprise variants, `NPM_TOKEN`, or `NODE_AUTH_TOKEN` before starting any npm subprocess. Check subprocesses receive an allowlisted environment with empty temporary npm configuration. They do not inherit Git hook repository selectors, Node preload options, model credentials, or the caller's publication token. The fresh dependency installation uses the committed lockfile and disables installation lifecycle scripts.

The receipt lives at Git's per-worktree `encbird-verification/COMMIT.json` path, normally `.git/encbird-verification/COMMIT.json`. It records the exact commit, tree, complete source fingerprint, Node version, and check time. It is disposable local workflow evidence for a trusted operator, without signatures or a shared approval registry. Starting credential-free verification removes any older receipt for that commit; only success replaces it. Changed source, lockfiles, validation definitions, executable modes, or a new commit require a new successful check. Do not copy or edit receipts to approve another source.

The pre-push hook keeps the Docker guard and gives the previous hook its original arguments and stdin. For a credential-free push without a matching receipt it runs `check:push` for the current source. The shell checks whether publication credentials are present without inspecting their values. In that case the source verifier can only verify a matching receipt or refuse; it cannot start npm, tests, or builds. Both the verifier and previous-hook child lose publication credentials and Node preload settings, while the Git caller retains its own credentials. A preserved hook may run its own checks, now without publication credentials; if it rejects, that rejection stands. The guard checks the receipt again afterward, so a previous hook cannot change source unnoticed.

Several refs may be pushed together only when every non-deletion ref resolves to the current checked commit; annotated tags are resolved to their commit. A ref pointing elsewhere is rejected with its actual commit and instructions to verify and push from the intended checkout. The hook never checks a different commit on the caller's behalf. Deletion-only updates still run the Docker guard and previous hook but introduce no source to verify. No command bypasses hooks or force-pushes.

```mermaid
sequenceDiagram
    participant O as Operator
    participant V as Credential-free container check
    participant H as Authenticated pre-push hook
    participant G as GitHub CI
    O->>V: Check clean current commit
    V->>V: Boot installation, install locked dependencies, run all checks
    V->>V: Confirm source unchanged and save local receipt
    O->>H: Explicitly authorized push of that commit
    H->>H: Match source and receipt; preserve previous hook
    H->>G: Push only after hooks succeed
    G->>G: Run test, build, and both runtime jobs again
```

The token relay described in [Versioned releases](releases.md) is for explicitly authorized writes and authenticated inspection. Do not pipe a token into `check:push` or combine preparation and publication in one token-bearing command. A local receipt never creates a GitHub status or substitutes for remote checks.

## GitHub checks and main protection rollout

CI runs on every branch push, pull request, and manual dispatch, without path filters. Tag pushes reuse the selected commit's completed checks and do not start a redundant run during publication. Its checkout uses `persist-credentials: false` and its only GitHub permission is `contents: read`. No publication credential is passed to a container. There is no release, deployment, settings mutation, or live-model step.

| Required context | Success condition |
| --- | --- |
| `test` | Code, synthetic tests, version, document-link, and distribution checks pass in the project image. |
| `build` | The committed installation boots before rebuilding, and rebuilding leaves all tracked output and source unchanged. |
| `runtime` | Both Node **22.12.0** and Node **24** installed-runtime jobs succeed. |

The `runtime` job is an aggregate with `always()` execution. A failed, cancelled, or skipped matrix does not satisfy it. Matrix job names contain their Node versions; the required context remains `runtime` when matrix details change. The runtime jobs install no npm dependencies and mount the source read-only. The other jobs use a fresh locked dependency installation with lifecycle scripts disabled.

The [verification policy](../scripts/verification-policy.json) supplies the required names to the protection helper and publisher. A fixture test checks that every policy name has exactly one corresponding workflow job. New release and tag publication requires those successful checks even before branch protection is activated: the publisher reads the policy from the **exact release commit**, not a later checkout. An already-published legacy release can still be verified against its original bytes without inventing CI evidence for that historical commit.

Roll out remote protection in this order:

1. Review and commit the workflow and verification code. Publish it to the intended public branch and merge it through the existing review path only when those remote actions are authorized.
2. Wait for the real workflow on current remote `main`. Verify its workflow file matches the committed file and its `test`, `build`, and `runtime` jobs completed successfully.
3. Inspect the proposed protection with `npm run ci:protect -- --plan`. The [protection helper](../scripts/configure-main-protection.mjs) is read-only by default and reports missing prerequisites. An authenticated plan can use the relay's `protect-main --plan` action.
4. Only with authorization to change repository settings, apply the reviewed protection and verify its returned state. The helper requires the same clean commit on remote `main`, a matching committed workflow, and successful current workflow/job evidence. It preserves existing rulesets and refuses a conflicting managed rule instead of replacing it.

For an authorized settings change, the host can relay its credential to the container without invoking npm there:

```sh
gh auth token | docker exec -i CONTAINER_ID \
  sh /workspaces/encbird-plugin/scripts/release-with-token.sh \
  protect-main --apply
```

The managed ruleset requires a pull request, resolved review threads, current successful checks, and protection against branch deletion and non-fast-forward updates. It adds no bypass actor. Existing stronger rules remain in place. Do not require contexts that have never run successfully, and do not report protection as active merely because its local plan or fixture tests passed. Adding these files does not itself publish CI or change GitHub settings.

## Failure handling and verification limits

If the installed runtime fails, fix and review the bundle or script entry point before rechecking. If the build changes committed output, rebuild intentionally and commit the resulting files; rerunning a check against its repaired working tree does not validate the earlier commit. Source changes during checking invalidate that run's receipt.

A missing or stale receipt in an authenticated push requires a separate credential-free check. Do not remove the guard, use `--no-verify`, weaken signing or security hooks, or change refs to hide the failure. Git hook repository environment variables are removed from child check environments so fixture repositories and linked worktrees do not accidentally use the parent's index or objects. The public development container still requires its Git metadata to be accessible without mounting a private consumer repository.

Local checks establish the installation, source consistency, and behavior covered by mock tests. The separate [behavior evaluation guide](behavior-evaluation.md) explains the synthetic evaluation tests and explicitly selected live-agent evaluation. A mock pass does not establish live account sign-in, billing behavior, model compliance, GitHub protection, or a publication result. Remote CI executes the full required jobs regardless of any local receipt.
