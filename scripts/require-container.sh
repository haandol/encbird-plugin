#!/bin/sh
# Release entrypoints require this repository's image, not a caller-supplied flag.
set -eu
marker=/usr/local/share/encbird-plugin/container
if [ "$(uname -s)" != Linux ] || [ ! -f /.dockerenv ] ||
   [ ! -f "$marker" ] || [ "$(cat "$marker")" != encbird-plugin-devcontainer-v1 ]; then
    printf '%s\n' 'Run this operation inside the EncBird Plugin .devcontainer built from this repository.' >&2
    exit 1
fi
