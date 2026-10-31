#!/usr/bin/env bash
# Developer launcher: starts Apprentice on Linux (electron-vite dev) after
# checking that the kernel's ptrace policy will let it attach to games.
set -euo pipefail
cd "$(dirname "$0")/../.."

scope_file=/proc/sys/kernel/yama/ptrace_scope
if [ -r "$scope_file" ] && [ "$(cat "$scope_file")" -ge 1 ] && [ "$(id -u)" -ne 0 ]; then
  echo "note: ptrace_scope=$(cat "$scope_file"); attaching to games needs it at 0, root, or" >&2
  echo "      CAP_SYS_PTRACE on the app. Run \"sudo sysctl kernel.yama.ptrace_scope=0\", or make" >&2
  echo "      that persistent with Linux/packaging/99-apprentice-ptrace.conf. See Linux/README.md." >&2
fi
exec npm run dev -- "$@"
