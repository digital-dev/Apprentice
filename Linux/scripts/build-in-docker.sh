#!/usr/bin/env bash
# UNVERIFIED LOCALLY: no Docker on the development machine; CI verifies the
# same steps natively (the `linux` job in .github/workflows/ci.yml).
#
# Builds the addon and runs the Linux tests inside the Ubuntu 22.04 build
# image with the repo mounted. The container copies the sources to its own
# filesystem first, so the host's node_modules/native/build are untouched.
# SYS_PTRACE is added for the ptrace-based tests that come with the backend.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE="${IMAGE:-apprentice-linux-build}"

docker build -t "$IMAGE" Linux/docker
mkdir -p Linux/dist
docker run --rm --cap-add=SYS_PTRACE \
  -v "$PWD":/src:ro -v "$PWD/Linux/dist":/out \
  "$IMAGE" bash -lc '
    set -euo pipefail
    rsync -a --exclude node_modules --exclude native/build --exclude .git \
      --exclude .worktrees --exclude .superpowers --exclude Linux/dist \
      --exclude out --exclude release /src/ /work/
    cd /work && npm ci && bash Linux/scripts/run-tests.sh
    cp native/build/Release/memory_addon.node Linux/test-harness/harness /out/'
