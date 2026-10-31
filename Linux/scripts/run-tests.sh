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

# Pure parser tests first: no Node, no addon, fail fast.
g++ -std=c++17 -O0 -g -Wall -o Linux/native/tests/proc_parse_test Linux/native/tests/proc_parse_test.cc
(cd Linux/native/tests && ./proc_parse_test)

(cd native && npx node-gyp configure --target="${NODE_GYP_TARGET:-22.12.0}" \
  && npx node-gyp build --target="${NODE_GYP_TARGET:-22.12.0}")

if [ -n "${TEST_NODE_BIN:-}" ]; then export PATH="$TEST_NODE_BIN:$PATH"; fi
if [ "$#" -eq 0 ]; then
  set -- tests/native/addon_smoke.test.ts tests/native/spawnHarness.test.ts tests/native/platform.test.ts
fi
node -v
npx vitest run "$@"
