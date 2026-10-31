#!/usr/bin/env bash
# Build the Windows test harness (test-harness/harness.c) with mingw-w64 into a PE
# executable, for running the native tests against a real Wine process
# (APPRENTICE_HARNESS=wine, see README.md). Needs x86_64-w64-mingw32-gcc
# (apt: mingw-w64). Run from anywhere; operates on the repo this script lives in.
#
# The probe DLLs the harness loads (test-harness/probe.dll, probe2.dll) are the
# checked-in PE builds used on Windows too, so they are not rebuilt here.
set -euo pipefail
cd "$(dirname "$0")/../.."

# -O0: the harness's write sites must stay real stores (MSVC's `#pragma optimize`
# does the same on Windows; gcc ignores that pragma, hence -Wno-unknown-pragmas).
x86_64-w64-mingw32-gcc -O0 -g -Wno-unknown-pragmas \
  -o Linux/test-harness/harness-wine.exe test-harness/harness.c
echo "built Linux/test-harness/harness-wine.exe"
