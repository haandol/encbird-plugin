# Versioned plugin releases

The public destination is `haandol/encbird-plugin`. A release uses a stable `vX.Y.Z` annotated tag, an exact source commit and a verified installable ZIP. Preparation and every publishing step run in this repository's Docker image. Setup alone does not authorize any push or release.

## Prepare the environment and version

Open a standalone clone of the public repository with **Dev Containers: Reopen in Container**. The container includes Node, Git, GitHub CLI and archive tools. It mounts only the public checkout and separate dependency/test volumes; host SSH or GitHub credential directories are not mounted. Real learner browser login remains a desktop workflow.

Startup installs a repository pre-push hook and preserves the previous hook and effective `core.hooksPath`. It blocks host pushes and delegates the original hook inside the project container. A custom external hook runner must delegate repository-local hooks; verify that integration rather than disabling security controls. Local guards are operator workflow controls, not server-side proof of Docker execution.

`npm run version:check` verifies all release versions. The root package version, plugin package, lockfile, portable/Codex/Claude manifests and Claude marketplace entry must agree. Runtime version metadata follows the plugin package. The learning API contract has its own version and is not bumped by these commands.

```sh
npm run version:bump -- patch
# Or select an explicit stable version:
npm run version:set -- 0.1.1
npm run check
```

A repeated explicit version is a no-op; downgrades or existing version drift stop for inspection. The version command does not commit, tag, push or publish. Review the generated bundles, commit the versioned source, then use that exact commit throughout the release.

## Prepare and inspect the package

Write concise Korean release notes from the actual public changes, with no private service implementation or user data. In the container, prepare the committed source:

```sh
release_version=0.1.1
release_commit=$(git rev-parse HEAD)
npm run release:prepare -- "$release_version" "$release_commit" /tmp/release-notes.md
```

Preparation runs the complete checks without publication credentials. It requires clean committed source and stops if a fresh build changes tracked files. Rebuild and commit those changes before trying again. The package retains the marketplace and `plugins/encbird` installation layout, including runtime bundles, skills, contracts and license files. Git metadata, development sources, tests, dependencies and environment files are excluded.

Outputs are kept under `.release/VERSION/COMMIT/`. Keep the ZIP, manifest, checksums and generated release notes together. Record the ZIP SHA-256 printed by preparation. The public source tag must be annotated and point to that exact versioned commit; conflicting tags are never replaced.

## Push and publish only when requested

First land the source commit on remote `main` through the repository's applicable review path. Make any authorized branch push inside the container, with automatic tag following disabled:

```sh
git -c push.followTags=false push origin main
```

Do not substitute a direct main push when remote review rules require a PR. If a squash or another merge changes the commit SHA, prepare the package again from the merged SHA at the same version; do not relabel an older artifact. Publishing does not push or merge an unreviewed branch for you.

Use `release:push` to create/reuse and push only the verified annotated version tag. It requires the same commit and ZIP checksum as publication. `npm run tag:push -- VERSION` is the shorter entry point for a tag that has already been prepared. The check command never publishes:

```sh
npm run release:check -- VERSION FULL_COMMIT_SHA ZIP_SHA256
npm run release:push -- VERSION FULL_COMMIT_SHA ZIP_SHA256
npm run release:publish -- VERSION FULL_COMMIT_SHA ZIP_SHA256
```

The full publisher verifies or resumes a matching draft, verifies uploaded bytes, and publishes it. It must not report a draft as a completed publication. Conflicting metadata/assets, failed or pending remote checks, and tag/source mismatches stop the operation. An identical already-published release is verified without resetting Latest.

Use existing forwarded Git authentication for branch pushes when available. For GitHub Release API calls, pass the host's authenticated `gh` credential through standard input into the selected, trusted project container. Replace the placeholders; do not paste a token into a shell argument:

```sh
# On the host; execution of the publisher stays inside Docker.
gh auth token | docker exec -i CONTAINER_ID \
  sh /workspaces/encbird-plugin/scripts/release-with-token.sh \
  publish VERSION FULL_COMMIT_SHA ZIP_SHA256 --publish
```

`release-with-token.sh publish VERSION FULL_COMMIT_SHA ZIP_SHA256 --push` performs the verified tag step with the same credential handoff. The relay also accepts `push-version VERSION` for an existing tag. The token exists only in that process and its GitHub/Git children; it is not saved in a file or configured in the container environment. Do not run dependency installation, builds, tests or arbitrary commands with that publication token. This pipeline is for an explicitly authorized operation, not a setup check.

## Recovery and verification limits

Run one publisher at a time across containers and machines. The publisher checks for newer stable releases before preparing a publication and again before making it public; it refuses to lower Latest, but those reads are not a distributed lock.

Preserve the same version, commit, package, checksum and notes after interruption. Inspect the remote tag and release before retrying. Do not increment the version to conceal a failed publish, replace assets with `--clobber`, move tags, bypass hooks, or force-push. Preserve artifacts that still need reconciliation.

Release tests use temporary Git repositories and fake GitHub responses. Run them in the project container; host runs may skip container-only cases. A mock run does not establish real account authentication, live service compatibility, branch permissions or a published release. No GitHub Actions workflow or automatic release-on-push is installed by this setup.
