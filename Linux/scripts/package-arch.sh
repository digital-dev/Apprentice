#!/usr/bin/env bash
# Builds the tar.gz that Linux/packaging/arch/PKGBUILD packages
# (task-18-brief.md Step 3): Apprentice-<version>-linux-x64.tar.gz in
# Linux/dist/, containing the electron-builder "dir" target's unpacked
# output (the same linux-unpacked tree the AppImage/deb targets are built
# from in electron-builder.linux.json, just left as a directory instead of
# wrapped in a squashfs or .deb). No separate Arch-specific build step:
# this reuses Task 17's packaging config and the addon it already expects
# in Linux/dist/.
set -euo pipefail
cd "$(dirname "$0")/../.."

DIST="${DIST:-Linux/dist}"

if [ ! -f "$DIST/memory_addon.node" ]; then
  echo "memory_addon.node missing in $DIST — build it first" \
    "(Linux/scripts/build-in-docker.sh or build-in-wsl.sh)" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"

npm run build
# "dir" overrides electron-builder.linux.json's own linux.target list
# (AppImage, deb) for this invocation only — it leaves the unpacked app
# tree at $DIST/linux-unpacked instead of wrapping it in an installer, which
# is exactly what a tarball needs.
npx electron-builder --linux dir --config Linux/packaging/electron-builder.linux.json

UNPACKED="$DIST/linux-unpacked"
if [ ! -d "$UNPACKED" ]; then
  echo "expected $UNPACKED from the \"dir\" target, not found" >&2
  exit 1
fi

# Stage under a directory literally named "apprentice" so the tarball's
# top-level entry matches what PKGBUILD's package() and
# Linux/scripts/smoke-arch.sh expect to find after extraction, independent
# of whatever directory name electron-builder happened to pick.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -a "$UNPACKED" "$STAGE/apprentice"

TARBALL="$DIST/Apprentice-${VERSION}-linux-x64.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" apprentice
echo "Wrote $TARBALL"
