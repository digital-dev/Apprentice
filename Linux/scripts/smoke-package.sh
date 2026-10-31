#!/usr/bin/env bash
# CI smoke test for the packaged Linux build (task-17-brief.md Step 1/4):
# proves the AppImage actually launches a window, not just that
# electron-builder produced a file of the plausible size.
#
# Extracts (--appimage-extract) rather than running the AppImage directly:
# that is also libfuse2's absence workaround README.md documents for users,
# so exercising it here doubles as a check that path keeps working. Runs
# under Xvfb (CI has no real display) with the sandbox off (CI containers
# run as a user without the setuid chrome-sandbox's privileges) and
# --smoke-test (src/main/index.ts: logs the window title and exits 0 once
# the main window reaches ready-to-show, rather than waiting for a human to
# close it).
set -euo pipefail
cd "$(dirname "$0")/../.."

DIST="${DIST:-Linux/dist}"
APPIMAGE="$(ls "$DIST"/*.AppImage 2>/dev/null | head -1)"
if [ -z "$APPIMAGE" ]; then
  echo "No .AppImage found in $DIST — run Linux/scripts/build-in-docker.sh --package first" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$APPIMAGE" "$WORK/apprentice.AppImage"
chmod +x "$WORK/apprentice.AppImage"
( cd "$WORK" && ./apprentice.AppImage --appimage-extract >/dev/null )

echo "Smoke-testing $APPIMAGE"
OUT="$(xvfb-run -a "$WORK/squashfs-root/AppRun" --no-sandbox --smoke-test 2>&1)" || {
  echo "$OUT" >&2
  echo "Smoke test FAILED: AppImage did not exit 0" >&2
  exit 1
}
echo "$OUT"
echo "$OUT" | grep -q 'smoke-test: window ready, title="Apprentice"' || {
  echo "Smoke test FAILED: exited 0 but never logged the expected window title" >&2
  exit 1
}
echo "Smoke test OK: window reached ready-to-show with the expected title and exited 0"
