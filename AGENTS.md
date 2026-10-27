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

## Repository ownership and integration

- This public repository owns the plugin source, skills, distribution files, versions and releases. EncBird service implementation stays outside it. Keep public API contracts sufficient for client development without copying private implementation or review metadata.
- Use a standalone public clone for development and the project Dev Container for builds and publication. A consumer may pin this repository as a submodule for integration checks; that pin records a commit SHA, not a moving branch or tag. Do not mount a private consumer repository to make external submodule or worktree Git metadata accessible in the container.
- Make a referenced public commit available before a consumer pushes its updated submodule pointer. Prefer a verified release commit for that pin, and reverify the final SHA when merging changes it. Local commits and consumer pin updates do not authorize any remote push or release.
- Confirm that a backward-compatible service API is available before exposing a plugin that depends on it on public `main`. Current marketplace installation commands select this repository without a release tag; publishing a GitHub Release does not itself pin marketplace installations. Keep plugin and API contract versions independent and follow [Versioned releases](docs/releases.md).

## Versioned releases and Git pushes

- Publish this plugin only to the public `haandol/encbird-plugin` repository. Release preparation, tag pushes, drafts, and GitHub Release publication run inside the image built from this repository's `.devcontainer/Dockerfile`. Never fall back to a host or arbitrary Linux process.
- Setup and preparation do not authorize publication. Follow the user's requested action level; a configuration-only request must not bump the real version, create a real release tag, push, or publish. Ordinary branch pushes do not publish releases.
- Use [Release workflow](docs/releases.md) and the maintained scripts. Keep the plugin version synchronized across packages, lockfile, host manifests and marketplace metadata. The API contract version is independent.
- Use the current branch's intended upstream for an authorized branch push; specify the destination when it is otherwise ambiguous. Release scripts publish only the verified version tag and release assets for a commit already on remote `main`.
- Install the repository pre-push guard with `npm run hooks:install`; Dev Container startup also installs it. Preserve existing hooks, signatures and remote protections. Never disable them, use `--no-verify`, force-push, or change environments to bypass an explicit rejection.
- The local guard requires the project Docker marker and rejects host pushes. It is a local workflow control, not GitHub attestation of the operator's machine; do not claim it removes the owner's ability to deliberately bypass local controls.
- Pass the host's GitHub CLI credential to the container through standard input using `scripts/release-with-token.sh`. Never print it, store it in a file, put it in arguments/remote URLs, or mount the host credential directories. Do not run builds or tests with a real publication token.
- Verify version, commit, annotated tag, archive contents and checksum, public repository, and applicable remote checks. Reuse identical results after interruption; never overwrite a conflicting tag, release or asset. Wait for publication and verify its actual public state before reporting success.
- Release notes describe user-visible plugin changes in Korean. Never include private service implementation, operational data, credentials or user content. Temporary packages and notes belong in ignored `.release/` output, not source.
