#!/bin/sh
set -eu
workspace=/workspaces/encbird-plugin
cd "$workspace"
if ! git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$workspace"; then
    git config --global --add safe.directory "$workspace"
fi
if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
    printf '%s\n' 'Use a standalone clone of haandol/encbird-plugin. Git metadata outside the workspace is not mounted.' >&2
    exit 1
fi
node scripts/install-hooks.mjs
