#!/usr/bin/env bash
# UNVERIFIED LOCALLY: no Docker on the development machine; CI verifies the
# same steps natively (the `linux` job in .github/workflows/ci.yml).
#
# Builds the addon and runs the Linux tests inside the Ubuntu 22.04 build
# image with the repo mounted. The container copies the sources to its own
# filesystem first, so the host's node_modules/native/build are untouched.
# SYS_PTRACE is added for the ptrace-based tests that come with the backend.
#
#   --package   also builds the AppImage and .deb (electron-builder.linux.json)
#               and copies them to Linux/dist/, same copy-to-/work pattern as
#               the test build above — electron-builder must never run
#               against the host's own checkout (see build-in-wsl.sh's doc
#               for why: node_modules/native/build on it are for the host
#               platform, Windows here, not Linux).
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE="${IMAGE:-apprentice-linux-build}"

PACKAGE=false
for arg in "$@"; do
  case "$arg" in
    --package) PACKAGE=true ;;
    *)
      echo "Unknown argument: $arg (supported: --package)" >&2
      exit 1
      ;;
  esac
done

docker build -t "$IMAGE" Linux/docker
mkdir -p Linux/dist
docker run --rm --cap-add=SYS_PTRACE -e APPRENTICE_HARNESS -e PACKAGE="$PACKAGE" \
  -v "$PWD":/src:ro -v "$PWD/Linux/dist":/out \
  "$IMAGE" bash -lc '
    set -euo pipefail
    rsync -a --exclude node_modules --exclude native/build --exclude .git \
      --exclude .worktrees --exclude .superpowers --exclude Linux/dist \
      --exclude out --exclude release /src/ /work/
    cd /work && npm ci && bash Linux/scripts/run-tests.sh
    cp native/build/Release/memory_addon.node Linux/test-harness/harness /out/
    if [ "$PACKAGE" = "true" ]; then
      # electron-builder.linux.json points its memory_addon.node files entry
      # at Linux/dist (mirroring the Windows-build package.json config, which
      # points at native/build/Release instead -- see that config file for
      # why) relative to the project dir electron-builder runs in, /work
      # here, so the freshly built addon needs to land there too, not just
      # at /out.
      mkdir -p Linux/dist
      cp native/build/Release/memory_addon.node Linux/dist/
      npm run build
      npx electron-builder --linux --config Linux/packaging/electron-builder.linux.json
      cp Linux/dist/*.AppImage Linux/dist/*.deb /out/
    fi'
echo "Linux build OK: $PWD/Linux/dist/"
