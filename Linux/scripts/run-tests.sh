#!/usr/bin/env bash
# Build the Linux test harness and native addon, then run the Linux test set.
# Run from anywhere; operates on the repo this script lives in. Expects
# `npm ci` to have been done and gcc/g++/make/python3 to be installed.
# Extra arguments replace the default test files (passed to `vitest run`).
#   NODE_GYP_TARGET   Node headers to build against (default 22.12.0, as CI)
#   TEST_NODE_BIN     bin dir of a Node 26 install used to RUN vitest (default: PATH;
#                     Node 22 cannot import .node files, so set it. See Linux/README.md)
set -euo pipefail
cd "$(dirname "$0")/../.."

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
g++ -std=c++17 -O0 -g -Wall -Inative/src/platform -o Linux/native/tests/platform_memory_test   Linux/native/tests/platform_memory_test.cc Linux/native/platform_linux.cc   Linux/native/platform_linux_process.cc Linux/native/platform_linux_memory.cc -ldl
(cd Linux/native/tests && ./platform_memory_test)

(cd native && npx node-gyp configure --target="${NODE_GYP_TARGET:-22.12.0}" \
  && npx node-gyp build --target="${NODE_GYP_TARGET:-22.12.0}")

if [ -n "${TEST_NODE_BIN:-}" ]; then export PATH="$TEST_NODE_BIN:$PATH"; fi
if [ "$#" -eq 0 ]; then
  # Grows as the Linux backend lands. Not yet: memory_ops/patch_ops/script_ops/cave_ops (writes),
  # write_watch/signature_golden/snapshot_ops (ptrace), thread_ops, mono_*.
  set -- tests/native/addon_smoke.test.ts tests/native/spawnHarness.test.ts tests/native/platform.test.ts \
    tests/native/scanner.test.ts tests/native/pointer.test.ts tests/native/process_utils.test.ts \
    tests/native/module_info.test.ts tests/native/noWin32OutsidePlatform.test.ts \
    tests/native/linux_memory.test.ts
fi
node -v
npx vitest run "$@"
