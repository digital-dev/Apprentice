#!/usr/bin/env bash
# Build the Linux test harness and native addon, then run the Linux test set.
# Run from anywhere; operates on the repo this script lives in. Expects
# `npm ci` to have been done and gcc/g++/make/python3 to be installed.
# The default test set runs against the ELF harness; then, when wine and mingw-w64
# are installed, a second set runs against the Windows harness under Wine (it says
# so when that step is skipped). Extra arguments replace the test files (passed to
# `vitest run`) and run only one step.
#   APPRENTICE_HARNESS=wine  run ONLY the Wine step (an error if wine/mingw are missing)
#   NODE_GYP_TARGET   Node headers to build against (default 22.12.0, as CI)
#   TEST_NODE_BIN     bin dir of a Node 26 install used to RUN vitest (default: PATH;
#                     Node 22 cannot import .node files, so set it. See Linux/README.md)
#   APPRENTICE_WINEPREFIX    the Wine step's throwaway prefix (default ~/.wine-apprentice-test).
#                            WINEPREFIX from the environment is ignored; ~/.wine, ~ and / are refused.
set -euo pipefail
cd "$(dirname "$0")/../.."

# The one Wine environment of this script (keep in step with wineEnv() in tests/helpers/spawnHarness.ts).
# Exports the resolved APPRENTICE_WINEPREFIX too, so the tests use the same prefix.
wine_env() {
  local prefix
  prefix="$(realpath -m "${APPRENTICE_WINEPREFIX:-$HOME/.wine-apprentice-test}")"
  case "$prefix" in
    /) ;;
    "$(realpath -m "$HOME")" | "$(realpath -m "$HOME/.wine")") ;;
    *)
      export APPRENTICE_WINEPREFIX="$prefix" WINEPREFIX="$prefix" WINEARCH=win64 WINEDEBUG=-all \
        WINEDLLOVERRIDES="mscoree,mshtml="
      return 0 ;;
  esac
  echo "refusing to run the Wine tests in \"$prefix\": that is not a throwaway prefix." \
    "Leave APPRENTICE_WINEPREFIX unset (default ~/.wine-apprentice-test) or point it at a scratch directory." >&2
  exit 1
}

have_wine() { command -v wine >/dev/null && command -v x86_64-w64-mingw32-gcc >/dev/null; }

if [ "${APPRENTICE_HARNESS:-}" = wine ] || have_wine; then
  wine_env  # refuse an unsafe prefix before building or running anything
fi

gcc -O0 -g -pthread -rdynamic -o Linux/test-harness/harness Linux/test-harness/harness.c -ldl
# Probe libraries the harness dlopen()s (loaddll/loaddll2): same exports as the PE probes;
# PAD_SIZE differs so probe2 is the "updated game" variant with a different image size.
gcc -shared -fPIC -O0 -DPAD_SIZE=4096   -o Linux/test-harness/probe.so  Linux/test-harness/probe.c
gcc -shared -fPIC -O0 -DPAD_SIZE=262144 -o Linux/test-harness/probe2.so Linux/test-harness/probe.c

# Pure parser tests first: no Node, no addon, fail fast.
g++ -std=c++17 -O0 -g -Wall -o Linux/native/tests/proc_parse_test Linux/native/tests/proc_parse_test.cc
(cd Linux/native/tests && ./proc_parse_test)

# PE/ELF parser tests. The ELF fixtures are built here (three ways, so every
# symbol-count path is hit) rather than checked in as binaries; the PE fixtures
# are checked-in copies of test-harness/*.dll. ASan/UBSan catch any out-of-bounds
# use inside the parsers, which read untrusted target memory.
F=Linux/native/tests/fixtures
gcc -shared -fPIC -Wl,--hash-style=gnu  -Wl,--version-script=$F/elf_fixture.map -o $F/elf_gnu.so  $F/elf_fixture.c
gcc -shared -fPIC -Wl,--hash-style=sysv -Wl,--version-script=$F/elf_fixture.map -o $F/elf_sysv.so $F/elf_fixture.c
gcc -shared -fPIC -Wl,--hash-style=both -Wl,--version-script=$F/elf_fixture.map -o $F/elf_both.so $F/elf_fixture.c
g++ -std=c++17 -O0 -g -Wall -fsanitize=address,undefined -fno-sanitize-recover=undefined \
  -o Linux/native/tests/module_parse_test Linux/native/tests/module_parse_test.cc -ldl
(cd Linux/native/tests && ./module_parse_test)
# The real backend against this process as target: module extents (.bss), image filter, exports.
g++ -std=c++17 -O0 -g -Wall -Inative/src/platform -o Linux/native/tests/platform_memory_test   Linux/native/tests/platform_memory_test.cc Linux/native/platform_linux.cc   Linux/native/platform_linux_process.cc Linux/native/platform_linux_memory.cc Linux/native/platform_linux_write.cc -ldl
(cd Linux/native/tests && ./platform_memory_test)
# Writes through /proc/<pid>/mem against this process and a forked child: r-x/PROT_NONE/r-- pages, all-or-nothing
# refusal, rollback, fd leaks, threads.
g++ -std=c++17 -O0 -g -Wall -pthread -Inative/src/platform -o Linux/native/tests/platform_write_test Linux/native/tests/platform_write_test.cc Linux/native/platform_linux.cc Linux/native/platform_linux_process.cc Linux/native/platform_linux_memory.cc Linux/native/platform_linux_write.cc -ldl
(cd Linux/native/tests && ./platform_write_test)

(cd native && npx node-gyp configure --target="${NODE_GYP_TARGET:-22.12.0}" \
  && npx node-gyp build --target="${NODE_GYP_TARGET:-22.12.0}")

if [ -n "${TEST_NODE_BIN:-}" ]; then export PATH="$TEST_NODE_BIN:$PATH"; fi
node -v

# Step 1: the ELF harness. Grows as the Linux backend lands. Not yet: cave_ops/cloneStackScript (caves),
# thread_ops, write_watch/signature_golden/snapshot_ops (ptrace), mono_*. patch_ops skips its two
# write-watch tests on Linux (Task 15).
DEFAULT_TESTS=(tests/native/addon_smoke.test.ts tests/native/spawnHarness.test.ts tests/native/platform.test.ts
  tests/native/scanner.test.ts tests/native/pointer.test.ts tests/native/process_utils.test.ts
  tests/native/module_info.test.ts tests/native/noWin32OutsidePlatform.test.ts
  tests/native/linux_memory.test.ts tests/native/memory_ops.test.ts tests/native/patch_ops.test.ts
  tests/native/script_ops.test.ts)
# Step 2: the Proton path, test-harness/harness.c built with mingw and run under Wine
# (APPRENTICE_HARNESS=wine, see Linux/test-harness/README.md).
WINE_TESTS=(tests/native/platform.test.ts tests/native/module_info.test.ts
  tests/native/scanner.test.ts tests/native/pointer.test.ts
  tests/native/memory_ops.test.ts tests/native/patch_ops.test.ts tests/native/script_ops.test.ts)

run_wine_step() {
  wine_env
  bash Linux/test-harness/build-wine-harness.sh
  # No wineserver (nor winedevice.exe etc.) of the throwaway prefix outlives the script, pass or fail.
  # (wineserver -k fails when the tests' own teardown already stopped it; the script keeps its status.)
  trap 'rc=$?; wineserver -k 2>/dev/null || true; timeout 5 wineserver -w 2>/dev/null || true; exit $rc' EXIT
  # Create the throwaway prefix up front: the first Wine start in a fresh prefix takes longer
  # than the tests wait for the harness.
  wine wineboot --init
  wineserver -w
  if [ "$#" -eq 0 ]; then set -- "${WINE_TESTS[@]}"; fi
  APPRENTICE_HARNESS=wine npx vitest run "$@"
}

if [ "${APPRENTICE_HARNESS:-}" = wine ]; then
  # Asked for the Wine step explicitly: missing tools are an error, not a skip.
  have_wine || { echo "APPRENTICE_HARNESS=wine needs wine and x86_64-w64-mingw32-gcc (apt: wine wine64 mingw-w64)" >&2; exit 1; }
  run_wine_step "$@"
  exit 0
fi

if [ "$#" -gt 0 ]; then
  npx vitest run "$@"
  echo "Wine step not run: explicit test files given (use APPRENTICE_HARNESS=wine to run them under Wine)."
  exit 0
fi
npx vitest run "${DEFAULT_TESTS[@]}"
if have_wine; then
  run_wine_step
else
  echo "Wine step SKIPPED: wine or x86_64-w64-mingw32-gcc not installed (apt: wine wine64 mingw-w64)."
fi
