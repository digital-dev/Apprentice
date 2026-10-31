# Apprentice on Linux

Everything Linux-specific lives here; the rest of the repo is shared with the
Windows build.

| Path | Purpose |
|---|---|
| `native/` | Linux platform backend (`platform_linux.cc`), compiled by `native/binding.gyp` on Linux |
| `scripts/build-in-wsl.sh` | Build and test from a Windows checkout via WSL2 (verified path) |
| `scripts/build-in-docker.sh`, `docker/Dockerfile` | Same, in an Ubuntu 22.04 container (unverified locally; CI verifies) |
| `scripts/run-tests.sh` | Build harness + addon and run the Linux test set |
| `scripts/apprentice.sh` | Dev launcher with a ptrace-policy check |
| `test-harness/harness.c` | ELF counterpart of `test-harness/harness.c` for the native tests |
| `dist/` | Build output (gitignored) |

## Build from Windows (WSL2)

```
wsl.exe -d Ubuntu-22.04 -- bash Linux/scripts/build-in-wsl.sh
```

Needs in the distro: `build-essential python3 rsync nodejs(22)`. The sources are
synced to `~/apprentice-build` (WSL filesystem), built there, and the addon and
harness are copied to `Linux/dist/`. The checkout's own `node_modules` and
`native/build` are never used.

## Status

The Linux backend is currently a stub: the addon builds and loads,
`IsSupported()` is false, and process operations refuse. Only
`tests/native/addon_smoke.test.ts` and `tests/native/spawnHarness.test.ts` run on
Linux; the rest need the real backend.

## ptrace permissions

Attaching to another process is restricted by Yama (`ptrace_scope`). Options:
run as root, `sudo setcap cap_sys_ptrace+ep <binary>`, or
`sudo sysctl kernel.yama.ptrace_scope=0`.
