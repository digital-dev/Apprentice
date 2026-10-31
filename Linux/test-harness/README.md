# Linux test harnesses

The native tests (`tests/native/*.test.ts`) drive a small target process over
stdin/stdout (`set 55`, `get`, `loaddll`, ...; the first line it prints is
`PID n`). `tests/helpers/spawnHarness.ts` picks which one:

| Mode | Target | Built by |
|---|---|---|
| default on Linux | `harness` (ELF), from `harness.c` here, with `probe.so`/`probe2.so` | `Linux/scripts/run-tests.sh` |
| `APPRENTICE_HARNESS=wine` | `harness-wine.exe` (PE), from `test-harness/harness.c` (the Windows harness), run under `wine` | `build-wine-harness.sh` |

The Wine mode is the Proton path: a Windows exe in a Wine process, PE modules
(the exe, Wine's PE builtins such as `kernel32.dll`, and the checked-in
`test-harness/probe.dll`/`probe2.dll` it loads), Windows-style names, PE export
tables, all seen by the Linux backend through `/proc`.

## Running the Wine mode

Needs `wine` (the launcher; `wine64` satisfies it, no i386 architecture) and
`mingw-w64`: `apt-get install --no-install-recommends wine wine64 mingw-w64`.

`run-tests.sh` runs the Wine step after the default one when both are
installed, and prints `Wine step SKIPPED` when they are not. To run only the
Wine step (from Windows, through WSL):

```
wsl.exe -d Ubuntu-22.04 -u root -- bash -lc "cd /mnt/d/<path-to-checkout> && APPRENTICE_HARNESS=wine TEST_NODE_BIN=/opt/node-v26.13.0-linux-x64/bin bash Linux/scripts/build-in-wsl.sh"
```

Wine runs in a throwaway prefix, `~/.wine-apprentice-test` (override with
`WINEPREFIX`), never `~/.wine`. `WINEDLLOVERRIDES="mscoree,mshtml="` stops Wine
from offering to download Mono/Gecko, `WINEDEBUG=-all` keeps it quiet, and no
display is needed. `run-tests.sh` creates the prefix (`wine wineboot --init`)
before the tests, because a first start in a fresh prefix takes a few seconds.

## What a Wine process looks like (verified with Wine 6.0.3, Ubuntu 22.04)

- **pid**: `/usr/bin/wine` is a shell script that `exec`s `/usr/lib/wine/wine64`,
  which runs the exe in the same process. So the pid of the spawned `wine` child
  is the Linux pid of the process running the PE, and the tests use it as is. The
  `PID n` line the harness prints is its Windows pid (e.g. `32`), unrelated.
- **name**: `/proc/<pid>/exe` stays `/usr/lib/wine/wine64`; `comm` is the exe name
  truncated to 15 chars (`harness-wine.ex`). The loader rewrites its argv: first
  `/usr/lib/wine/wine64\0<exe>`, then, once running, `<exe>` padded with NULs,
  where `<exe>` is the path as given (relative or absolute Unix path; Wine's own
  services show `C:\windows\system32\services.exe`). The backend names the
  process from argv[0]/argv[1], so it is listed as `harness-wine.exe` in both states.
- **images**: only the PE header page (and the odd page whose file offset happens
  to be page-aligned) is a file-backed mapping of the `.exe`/`.dll`; the sections
  of an image with `FileAlignment` 0x200 (mingw and MSVC builds) are copied into
  anonymous mappings (`r-xp 00000000 00:00 0`). Wine's PE builtins
  (`/usr/lib/x86_64-linux-gnu/wine/kernel32.dll`, `FileAlignment` 0x1000) are
  file-backed throughout. Module names are the file names (`kernel32.dll`).
- **ELF too**: the same process also maps ELF objects (`wine64`, `ntdll.so`,
  `msvcrt.so`, `libc.so.6`, ...), which are listed as modules as well.
- **early attach**: for the first ~100 ms the process already has the exe's name
  but the PE is not mapped yet, so `attach` fails until it is. The tests wait for
  the `PID` line first.
