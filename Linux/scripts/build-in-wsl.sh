#!/usr/bin/env bash
# Build and test the Linux addon from a Windows checkout, inside WSL2.
# Run it from WSL (or: wsl.exe -d Ubuntu-22.04 -- bash Linux/scripts/build-in-wsl.sh).
#
# It never builds in the checkout itself: the checkout usually lives on a
# Windows drive whose node_modules and native/build hold Windows artifacts.
# Instead the sources are synced into a copy on the WSL filesystem
# (BUILD_DIR, default ~/apprentice-build), built and tested there, and the
# results are copied to Linux/dist/.
#   BUILD_DIR   build copy location (default ~/apprentice-build)
#   TEST_NODE_BIN  REQUIRED in practice: bin dir of a Node 26 install, used to run
#                  vitest (Node 22 cannot import .node files). Install steps are in
#                  Linux/README.md; example:
#     TEST_NODE_BIN=/opt/node-v26.13.0-linux-x64/bin bash Linux/scripts/build-in-wsl.sh
#   NODE_GYP_TARGET  headers for the addon build (default 22.12.0, see run-tests.sh)
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$HOME/apprentice-build}"

mkdir -p "$BUILD_DIR"
rsync -a --delete \
  --exclude node_modules --exclude native/build --exclude .git \
  --exclude .worktrees --exclude .superpowers --exclude Linux/dist \
  --exclude out --exclude release \
  "$SRC"/ "$BUILD_DIR"/

cd "$BUILD_DIR"
npm ci
bash Linux/scripts/run-tests.sh "$@"

mkdir -p "$SRC/Linux/dist"
cp native/build/Release/memory_addon.node Linux/test-harness/harness "$SRC/Linux/dist/"
echo "Linux build OK: $SRC/Linux/dist/"
