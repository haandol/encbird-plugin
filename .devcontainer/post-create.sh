#!/bin/sh
set -eu
sudo /usr/local/bin/encbird-prepare-volumes
sh .devcontainer/post-start.sh
npm ci --ignore-scripts
