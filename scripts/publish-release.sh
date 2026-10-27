#!/usr/bin/env bash
# A prepared commit/ZIP is immutable; outbound operations target only this repository.
set -euo pipefail
scripts="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
sh "$scripts/require-container.sh"

usage() {
    cat <<'EOF'
Usage: bash scripts/publish-release.sh VERSION FULL_COMMIT_SHA ZIP_SHA256 [--check|--push|--draft|--publish]

  --check    Verify prepared bytes, tags, remote main, CI and any release; no mutations (default).
  --push     Create/reuse the prepared annotated tag and push that tag only.
  --draft    Create or resume a matching draft; upload and verify all four prepared files.
  --publish  Complete the draft, verify downloaded bytes, then publish as Latest.

Prepare first: node scripts/prepare-release.mjs VERSION FULL_COMMIT_SHA REVIEWED_NOTES_FILE
Push the tag before --draft/--publish. All modes require the repository's Docker image.
Existing published releases are verified without changing Latest. Conflicts are never overwritten.
This publisher never runs npm, builds, changes a version, commits, or pushes branches.
EOF
}
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
[[ "${1:-}" != --help && "${1:-}" != -h ]] || { usage; exit 0; }
[[ $# -ge 3 && $# -le 4 ]] || { usage >&2; exit 2; }
version="$1"; target="$2"; expected_checksum="$3"; mode="${4:---check}"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'VERSION must be stable X.Y.Z.'
[[ "$target" =~ ^[0-9a-f]{40}$ ]] || fail 'COMMIT_SHA must be a full Git SHA.'
[[ "$expected_checksum" =~ ^[0-9a-f]{64}$ ]] || fail 'ZIP_SHA256 must be lowercase SHA-256.'
case "$mode" in --check|--push|--draft|--publish) ;; *) fail "Unknown mode: $mode" ;; esac
for tool in git gh jq node python3 sha256sum; do command -v "$tool" >/dev/null || fail "Missing tool: $tool"; done
cd -- "$scripts/.."
root="$PWD"
repo=haandol/encbird-plugin
transport="https://github.com/${repo}.git"
tag="v${version}"
ref="refs/tags/${tag}"
title="EncBird Plugin ${version}"
folder="$root/.release/$version/$target"
notes="$folder/release-notes-$tag.md"
assets=("encbird-plugin-$version.zip" manifest.json SHA256SUMS "release-notes-$tag.md")

scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
# Verification reads Git blobs and artifacts only; never expose relay tokens to Node startup hooks.
(
    unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN NODE_OPTIONS NODE_PATH
    node "$scripts/prepare-release.mjs" --verify "$version" "$target" "$expected_checksum"
) > "$scratch/manifest.json"

checksum() { sha256sum "$1" | awk '{print $1}'; }
# Freeze the verified bytes so concurrent edits cannot change what gets uploaded.
mkdir "$scratch/prepared"
for asset in "${assets[@]}"; do
    cp -- "$folder/$asset" "$scratch/prepared/$asset"
    [[ "$(checksum "$scratch/prepared/$asset")" == "$(jq -r --arg asset "$asset" '.artifactChecksums[$asset]' "$scratch/manifest.json")" ]] ||
        fail "Prepared asset changed during verification: $asset"
done
folder="$scratch/prepared"
notes="$folder/release-notes-$tag.md"
git_remote() {
    git -c credential.helper= -c 'credential.helper=!gh auth git-credential' \
        -c push.followTags=false -c push.recurseSubmodules=no "$@"
}
local_tag=false
check_local_tag() {
    local_tag=false
    if git show-ref --verify --quiet "$ref"; then
        local_tag=true
        [[ "$(git cat-file -t "$ref")" == tag ]] || fail 'Local tag must be annotated.'
        [[ "$(git rev-parse "${ref}^{commit}")" == "$target" ]] || fail 'Local tag points to another commit.'
        git cat-file tag "$ref" > "$scratch/local-tag"
        [[ "$(sed -n '1p' "$scratch/local-tag")" == "object $target" &&
           "$(sed -n '2p' "$scratch/local-tag")" == 'type commit' &&
           "$(sed -n '3p' "$scratch/local-tag")" == "tag $tag" ]] || fail 'Annotated tag must name this exact version and commit.'
    fi
}
check_local_tag
remote_tag=false
check_remote_tag() {
    local refs object commit
    refs="$(git_remote ls-remote "$transport" "$ref" "${ref}^{}")"
    remote_tag=false
    if [[ -z "$refs" ]]; then return; fi
    remote_tag=true
    [[ "$(printf '%s\n' "$refs" | wc -l | tr -d ' ')" == 2 ]] || fail 'Remote tag must be annotated.'
    object="$(printf '%s\n' "$refs" | awk -v ref="$ref" '$2 == ref {print $1}')"
    commit="$(printf '%s\n' "$refs" | awk -v ref="${ref}^{}" '$2 == ref {print $1}')"
    [[ "$object" =~ ^[0-9a-f]{40}$ && "$commit" == "$target" ]] || fail 'Remote tag is unannotated or points elsewhere.'
    gh api --hostname github.com "repos/$repo/git/tags/$object" > "$scratch/remote-tag.json"
    jq -e --arg tag "$tag" --arg target "$target" --arg object "$object" \
        '.sha == $object and .tag == $tag and .object.type == "commit" and .object.sha == $target' \
        "$scratch/remote-tag.json" >/dev/null || fail 'Remote annotated tag metadata differs.'
    if [[ "$local_tag" == true ]]; then
        [[ "$(git rev-parse "$ref")" == "$object" ]] || fail 'Local and remote tag objects differ; never overwrite an existing tag.'
    fi
}

gh auth status --hostname github.com >/dev/null || fail 'Authenticate GitHub CLI in the container first.'
gh api --hostname github.com "repos/$repo" > "$scratch/repository.json"
jq -e --arg repo "$repo" \
    '.full_name == $repo and .private == false and .default_branch == "main" and .archived == false and .disabled == false' \
    "$scratch/repository.json" >/dev/null || fail 'Repository metadata must identify public haandol/encbird-plugin with default branch main, neither archived nor disabled.'
check_remote_tag
check_main_ci() {
    local main
    main="$(git_remote ls-remote "$transport" refs/heads/main | awk '$2 == "refs/heads/main" {print $1}')"
    [[ "$main" =~ ^[0-9a-f]{40}$ ]] || fail 'Remote main is missing or ambiguous.'
    gh api --hostname github.com "repos/$repo/compare/$target...$main" > "$scratch/ancestry.json"
    jq -e --arg target "$target" \
        '.base_commit.sha == $target and .merge_base_commit.sha == $target and (.status == "ahead" or .status == "identical")' \
        "$scratch/ancestry.json" >/dev/null || fail 'Source commit is not reachable from remote main.'
    gh api --hostname github.com "repos/$repo/commits/$target/status" > "$scratch/status.json"
    jq -e '.total_count == 0 or (.state == "success" and all(.statuses[]; .state == "success"))' \
        "$scratch/status.json" >/dev/null || fail 'Commit status CI is pending or failed.'
    gh api --hostname github.com --paginate "repos/$repo/commits/$target/check-runs?filter=latest&per_page=100" > "$scratch/checks.json"
    jq -se 'map(.check_runs) | add | all(.[]; .status == "completed" and (.conclusion == "success" or .conclusion == "neutral" or .conclusion == "skipped"))' \
        "$scratch/checks.json" >/dev/null || fail 'Commit check CI is pending or failed.'
}
check_main_ci
if [[ "$mode" == --draft || "$mode" == --publish ]]; then
    [[ "$remote_tag" == true ]] || fail 'Push the prepared release tag before --draft/--publish.'
fi

find_release() {
    gh api --hostname github.com --paginate "repos/$repo/releases?per_page=100" |
        jq -s --arg tag "$tag" 'add // [] | map(select(.tag_name == $tag))' > "$scratch/matches.json"
    count="$(jq 'length' "$scratch/matches.json")"
    [[ "$count" -le 1 ]] || fail 'Multiple releases use this tag.'
    release_id="$(jq -r '.[0].id // empty' "$scratch/matches.json")"
    if [[ "$count" == 1 ]]; then
        [[ "$release_id" =~ ^[0-9]+$ ]] || fail 'Invalid release ID.'
    fi
}
check_newer_release() {
    gh api --hostname github.com --paginate "repos/$repo/releases?per_page=100" |
        jq -s 'add // []' > "$scratch/published-releases.json"
    python3 -I - "$version" "$scratch/published-releases.json" <<'PY'
import json
from pathlib import Path
import re
import sys

requested = tuple(map(int, sys.argv[1].split('.')))
for release in json.loads(Path(sys.argv[2]).read_text()):
    if release.get('draft') is not False or release.get('prerelease') is not False:
        continue
    tag = release.get('tag_name', '')
    match = re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag)
    if not match:
        sys.exit(f'Error: Cannot compare published release tag {tag!r}; inspect before publication.')
    if tuple(map(int, match.groups())) > requested:
        sys.exit(f'Error: Newer published release {tag} exists; refusing to replace Latest with v{sys.argv[1]}.')
PY
}
verify_release() {
    local expected_draft="$1" complete="$2" asset download_dir
    gh api --hostname github.com "repos/$repo/releases/$release_id" > "$scratch/release.json"
    jq -e --arg tag "$tag" --arg title "$title" --arg target "$target" --argjson draft "$expected_draft" \
        --rawfile notes "$notes" '
        .tag_name == $tag and .name == $title and .target_commitish == $target
        and .draft == $draft and .prerelease == false
        and ((.body | gsub("\r\n"; "\n") | sub("\n+$"; "")) == ($notes | gsub("\r\n"; "\n") | sub("\n+$"; "")))
        ' "$scratch/release.json" >/dev/null || fail 'Release metadata/notes mismatch; never overwrite.'
    jq -e --arg zip "${assets[0]}" --arg notes "${assets[3]}" '
        (.assets | map(.name)) as $names |
        ($names | length) == ($names | unique | length) and
        all(.assets[]; (.name == $zip or .name == "manifest.json" or .name == "SHA256SUMS" or .name == $notes) and .state == "uploaded")
        ' "$scratch/release.json" >/dev/null || fail 'Unexpected, duplicate, or incomplete release assets; never overwrite.'
    if [[ "$complete" == true ]]; then
        [[ "$(jq '.assets | length' "$scratch/release.json")" == 4 ]] || fail 'Release is missing prepared assets.'
    fi
    for asset in "${assets[@]}"; do
        if ! jq -e --arg asset "$asset" 'any(.assets[]; .name == $asset)' "$scratch/release.json" >/dev/null; then continue; fi
        download_dir="$(mktemp -d "$scratch/download.XXXXXX")"
        gh release download "$tag" --repo "github.com/$repo" --pattern "$asset" --dir "$download_dir"
        [[ -f "$download_dir/$asset" && ! -L "$download_dir/$asset" ]] || fail 'Downloaded asset is not a regular file.'
        [[ "$(checksum "$download_dir/$asset")" == "$(checksum "$folder/$asset")" ]] || fail "Uploaded asset SHA-256 mismatch: $asset"
    done
}
find_release
if [[ "$count" == 1 ]]; then
    [[ "$remote_tag" == true ]] || fail 'Existing release has no matching remote tag.'
    if [[ "$(jq -r '.[0].draft' "$scratch/matches.json")" == false ]]; then
        verify_release false true
        printf 'Already published and verified. No release or Latest changes were made.\n'
        jq -r '.html_url' "$scratch/release.json"
        exit 0
    fi
    verify_release true false
fi
if [[ "$mode" == --check ]]; then
    printf 'Checks passed. No tags, pushes, or release changes were made.\n'
    exit 0
fi
if [[ "$mode" == --push ]]; then
    check_main_ci
    check_remote_tag
    if [[ "$local_tag" == false ]]; then
        if [[ "$remote_tag" == true ]]; then
            git_remote fetch --no-tags "$transport" "$ref:$ref"
        else
            git tag -a "$tag" "$target" -m "$title" -m "Source commit: $target" -m "ZIP SHA-256: $expected_checksum"
        fi
        check_local_tag
    fi
    check_remote_tag
    if [[ "$remote_tag" == false ]]; then
        git_remote push "$transport" "$ref:$ref"
        check_remote_tag
        [[ "$remote_tag" == true ]] || fail 'Remote tag missing after push.'
    fi
    printf 'Verified tag-only push: %s (%s).\n' "$tag" "$target"
    exit 0
fi
if [[ "$mode" == --publish ]]; then
    check_newer_release
fi
if [[ "$count" == 0 ]]; then
    gh release create "$tag" --repo "github.com/$repo" --draft --verify-tag \
        --target "$target" --title "$title" --notes-file "$notes"
    find_release
    [[ "$count" == 1 ]] || fail 'Draft was not found after create.'
fi
verify_release true false
for asset in "${assets[@]}"; do
    if ! jq -e --arg asset "$asset" 'any(.assets[]; .name == $asset)' "$scratch/release.json" >/dev/null; then
        gh release upload "$tag" "$folder/$asset" --repo "github.com/$repo"
    fi
done
verify_release true true
if [[ "$mode" == --publish ]]; then
    check_main_ci
    check_remote_tag
    [[ "$remote_tag" == true ]] || fail 'Remote tag disappeared before publication.'
    check_newer_release
    gh release edit "$tag" --repo "github.com/$repo" --draft=false --latest --verify-tag
    verify_release false true
    latest="$(gh api --hostname github.com "repos/$repo/releases/latest" --jq .tag_name)"
    [[ "$latest" == "$tag" ]] || fail 'Published, but Latest differs; inspect GitHub release state.'
fi
jq -r '.html_url' "$scratch/release.json"
