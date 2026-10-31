#!/usr/bin/env bash
# CI/local smoke test for the Arch/CachyOS package (task-18-brief.md Step
# 1/4): proves the PKGBUILD actually builds and installs on a real Arch
# system, the setcap install hook ran, and the installed binary launches a
# window — not just that package-arch.sh produced a tarball of the right
# shape.
#
# Runs in an archlinux:latest container (needs Docker). makepkg refuses to
# run as root, so a non-root user does the build; `pacman -U` (the install)
# needs root, so that step runs outside that user.
#
# Arch's official repos do not ship Debian's "xvfb-run" wrapper script
# (only the "xorg-server-xvfb" package providing Xvfb itself), so the
# virtual display is started and torn down by hand here instead — same
# function (an X server with no real display backing it), just without the
# wrapper smoke-package.sh gets to use on the Ubuntu CI runner.
set -euo pipefail
cd "$(dirname "$0")/../.."

DIST="${DIST:-Linux/dist}"
TARBALL="$(ls "$DIST"/Apprentice-*-linux-x64.tar.gz 2>/dev/null | head -1)"
if [ -z "$TARBALL" ]; then
  echo "No Apprentice-*-linux-x64.tar.gz found in $DIST — run Linux/scripts/package-arch.sh first" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run this smoke test (archlinux:latest container)" >&2
  exit 1
fi

docker run --rm \
  -v "$PWD/Linux/packaging/arch":/arch-src:ro \
  -v "$PWD/$DIST":/dist:ro \
  archlinux:latest bash -lc '
    set -euo pipefail

    pacman -Syu --noconfirm --needed \
      base-devel libcap xorg-server-xvfb \
      gtk3 nss alsa-lib libxss libxtst

    useradd -m builder
    mkdir -p /home/builder/build
    cp /arch-src/PKGBUILD /arch-src/apprentice.install /home/builder/build/
    cp /dist/Apprentice-*-linux-x64.tar.gz /home/builder/build/
    chown -R builder:builder /home/builder/build

    su builder -c "cd /home/builder/build && makepkg --noconfirm --nocheck"

    PKG="$(ls /home/builder/build/*.pkg.tar.* | head -1)"
    echo "Installing $PKG"
    pacman -U --noconfirm "$PKG"

    echo "Checking setcap was applied by the install hook"
    getcap /opt/apprentice/apprentice | grep -q cap_sys_ptrace \
      || { echo "setcap did not apply (post_install did not run, or setcap is missing)" >&2; exit 1; }

    echo "Smoke-testing the installed binary under Xvfb"
    Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 &
    XVFB_PID=$!
    trap "kill $XVFB_PID 2>/dev/null || true" EXIT
    sleep 1

    OUT="$(DISPLAY=:99 /opt/apprentice/apprentice --no-sandbox --smoke-test 2>&1)" || {
      echo "$OUT" >&2
      echo "Smoke test FAILED: apprentice did not exit 0" >&2
      exit 1
    }
    echo "$OUT"
    echo "$OUT" | grep -q "smoke-test: window ready, title=\"Apprentice\"" || {
      echo "Smoke test FAILED: exited 0 but never logged the expected window title" >&2
      exit 1
    }
    echo "Arch smoke test OK: installed, capability applied, window reached ready-to-show"
  '
