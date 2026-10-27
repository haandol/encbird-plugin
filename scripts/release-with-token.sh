#!/bin/sh
# Invoke with docker exec -i; the host gh credential is accepted only over stdin.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sh "$root/scripts/require-container.sh"
case "${1:-}" in
    publish) shift; command=publish-release.sh ;;
    push-version) shift; command=push-version.sh ;;
    *) printf '%s\n' 'Usage: release-with-token.sh publish|push-version ARGS...' >&2; exit 2 ;;
esac
if [ -t 0 ]; then
    printf '%s\n' 'Pipe the host gh auth token to docker exec -i; never paste it into command arguments.' >&2
    exit 1
fi
if ! IFS= read -r GH_TOKEN || [ -z "$GH_TOKEN" ]; then printf '%s\n' 'No GitHub credential received.' >&2; exit 1
fi
export GH_TOKEN
export GH_HOST=github.com GIT_TERMINAL_PROMPT=0
unset GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_DEBUG GIT_TRACE GIT_TRACE_CURL GIT_CURL_VERBOSE
exec bash "$root/scripts/$command" "$@"
