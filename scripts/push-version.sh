#!/usr/bin/env bash
# Reuse the same source, artifact, remote and CI gates as the publisher.
set -euo pipefail
scripts="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
sh "$scripts/require-container.sh"
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
    printf 'Usage: bash scripts/push-version.sh VERSION [--check]\nPush only an existing annotated version tag, with its verified .release artifacts.\n'
    exit 0
fi
[[ $# -ge 1 && $# -le 2 ]] || fail 'Usage: bash scripts/push-version.sh VERSION [--check]'
version="${1#v}"
mode="${2:---push}"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'VERSION must be stable X.Y.Z.'
[[ "$mode" == --check || "$mode" == --push ]] || fail "Unknown mode: $mode"
cd -- "$scripts/.."
ref="refs/tags/v$version"
git show-ref --verify --quiet "$ref" || fail 'Missing prepared annotated tag. Use publish-release.sh --push with verified preparation inputs first.'
[[ "$(git cat-file -t "$ref")" == tag ]] || fail 'Local tag must be annotated.'
target="$(git rev-parse "${ref}^{commit}")"
archive=".release/$version/$target/encbird-plugin-$version.zip"
[[ -f "$archive" && ! -L "$archive" ]] || fail 'Missing prepared ZIP for the annotated tag.'
checksum="$(sha256sum "$archive" | awk '{print $1}')"
exec bash "$scripts/publish-release.sh" "$version" "$target" "$checksum" "$mode"
