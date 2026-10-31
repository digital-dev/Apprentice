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

Prerequisites in the distro (Ubuntu 22.04): `build-essential python3 rsync curl`, plus two Node versions:

- Node 22 on PATH: builds the addon (node-gyp headers `22.12.0`).
- Node 26 for vitest: Node 22 cannot import `.node` files in tests ("Unknown file extension .node"). Point `TEST_NODE_BIN` at its `bin` directory.

Install Node 26 from the official tarball (checksum-verified), as root:

```
mkdir -p /root/dl && cd /root/dl
V=v26.13.0; F=node-$V-linux-x64.tar.xz
curl -fsSLo $F https://nodejs.org/dist/$V/$F
curl -fsSLo SHASUMS256.txt https://nodejs.org/dist/$V/SHASUMS256.txt
grep " $F\$" SHASUMS256.txt | sha256sum -c -
tar -xJf $F -C /opt
/opt/node-$V-linux-x64/bin/node -v
```

Then, from the checkout:

```
wsl.exe -d Ubuntu-22.04 -u root -- bash -lc "cd /mnt/d/<path-to-checkout> && TEST_NODE_BIN=/opt/node-v26.13.0-linux-x64/bin bash Linux/scripts/build-in-wsl.sh"
```

Without `TEST_NODE_BIN` the addon builds but `addon_smoke.test.ts` fails on Node 22.
The sources are synced to `~/apprentice-build` (WSL filesystem), built there, and the addon and
harness are copied to `Linux/dist/`. The checkout's own `node_modules` and `native/build` are never used.

## Status

The Linux backend is partly implemented. Done: process listing, naming (Wine-aware), attach and
liveness (`/proc`), and the whole read side: regions (`/proc/<pid>/maps`), memory reads
(`process_vm_readv`, `/proc/<pid>/mem` fallback), module listing (ELF and Wine PE) and export
resolution (PE export directory, ELF `.dynsym`). Writes, injection, threads, ptrace write-watch and
Mono are still stubs, `IsSupported()` is false, and write operations refuse. The tests that need
only the read side run on Linux (the list in `scripts/run-tests.sh`); the rest need the later tasks.
The PE/ELF parsers are covered by `native/tests/module_parse_test.cc`.

## ptrace permissions

Attaching to another process is restricted by Yama (`ptrace_scope`). Options:
run as root, `sudo setcap cap_sys_ptrace+ep <binary>`, or
`sudo sysctl kernel.yama.ptrace_scope=0`.
