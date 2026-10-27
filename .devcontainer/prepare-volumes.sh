#!/bin/sh
set -eu
# Only the two configured dependency/test volumes are adjusted after UID mapping.
/bin/mkdir -p /workspaces/encbird-plugin/node_modules /workspaces/encbird-plugin/.test-tmp
/bin/chown -R node:node /workspaces/encbird-plugin/node_modules /workspaces/encbird-plugin/.test-tmp
