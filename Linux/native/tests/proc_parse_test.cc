// Plain-assert tests for the /proc parsers. Build: g++ -std=c++17 -o t proc_parse_test.cc
#include "../proc_parse.h"
#include <cassert>
#include <cstdio>
#include <fstream>
#include <sstream>

using namespace linuxproc;

// Builds a cmdline from '|'-separated args (each NUL-terminated, as in /proc).
static std::string Argv(std::string s) {
  for (char& c : s)
    if (c == '|') c = '\0';
  return s;
}

static std::string Slurp(const char* path) {
  std::ifstream f(path, std::ios::binary);
  assert(f && "fixture missing: run from Linux/native/tests");
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

int main() {
  // Wine: argv[0] is a Windows path with spaces.
  assert(ExeNameFromCmdline(Argv(R"(C:\Games\Schedule I\Schedule I.exe|)"),
                            "/usr/bin/wine64-preloader") == "Schedule I.exe");
  // Longer than the 15-char comm limit.
  assert(ExeNameFromCmdline(Argv(R"(C:\Games\A Very Long Game Name Here.exe|)"),
                            "/usr/bin/wine64-preloader") == "A Very Long Game Name Here.exe");
  // Z: drive path.
  assert(ExeNameFromCmdline(Argv(R"(Z:\home\u\game.exe|)"), "/usr/bin/wine64-preloader") == "game.exe");
  // argv[1] (wine game.exe launch), case-insensitive extension, original case kept.
  assert(ExeNameFromCmdline(Argv("wine|/opt/Games/Foo.EXE|"), "/usr/bin/wine") == "Foo.EXE");
  // Unix-style separators in argv[0].
  assert(ExeNameFromCmdline(Argv("/opt/g/Bar.exe|"), "/usr/bin/wine") == "Bar.exe");
  // Native: argv[0] is not .exe, so the exe link wins.
  assert(ExeNameFromCmdline(Argv("./Game|"), "/opt/game/Game.x86_64") == "Game.x86_64");
  // Only argv[0..1] are considered (documented limitation).
  assert(ExeNameFromCmdline(Argv("/usr/bin/proton|run|/p/Game.exe|"), "/usr/bin/python3") == "python3");
  // Empty cmdline falls back to the exe link, then empty.
  assert(ExeNameFromCmdline("", "/usr/lib/foo") == "foo");
  assert(ExeNameFromCmdline("", "").empty());
  // Fixture from a Wine process.
  assert(ExeNameFromCmdline(Slurp("fixtures/cmdline_wine.bin"), "/usr/bin/wine64-preloader") == "Schedule I.exe");

  MapsEntry e;
  assert(ParseMapsLine("00400000-00401000 r-xp 00001000 08:01 1234 /home/u/Schedule I/Schedule I.exe (deleted)", e));
  assert(e.start == 0x400000 && e.end == 0x401000);
  assert(e.r && !e.w && e.x && e.priv);
  assert(e.offset == 0x1000);
  assert(e.path == "/home/u/Schedule I/Schedule I.exe");
  assert(ParseMapsLine("7ffffffde000-7ffffffff000 rw-s 00000000 00:00 0 [stack]", e));
  assert(!e.x && e.w && !e.priv && e.path == "[stack]");
  assert(ParseMapsLine("10000000-10001000 r--p 00000000 00:00 0", e));
  assert(e.path.empty());
  assert(!ParseMapsLine("garbage", e));
  assert(!ParseMapsLine("", e));

  // LowestMappingBase: the shipped selection logic.
  const std::string wineMaps = Slurp("fixtures/maps_wine.txt");
  assert(LowestMappingBase(wineMaps, "Schedule I.exe", "/usr/bin/wine64-preloader", true) == 0x400000);
  // Name differing only by case still matches (Wine is case-insensitive).
  assert(LowestMappingBase(wineMaps, "SCHEDULE i.EXE", "", true) == 0x400000);
  // No match, and empty maps, give 0.
  assert(LowestMappingBase(wineMaps, "Other.exe", "", true) == 0);
  assert(LowestMappingBase("", "Schedule I.exe", "/x", true) == 0);
  assert(LowestMappingBase("", "Game", "/x", false) == 0);
  // Same exe mapped twice, higher one listed first: lowest wins.
  assert(LowestMappingBase("00900000-00901000 r--p 00000000 08:01 5 /g/A.exe\n"
                           "00500000-00501000 r--p 00000000 08:01 5 /g/A.exe\n", "A.exe", "", true) == 0x500000);
  // A preloader mapped LOWER than the exe is ignored: its basename differs.
  assert(LowestMappingBase("00100000-00101000 r-xp 00000000 08:01 7 /usr/bin/wine64-preloader\n"
                           "00400000-00401000 r--p 00000000 08:01 5 /g/A.exe\n", "A.exe", "", true) == 0x400000);
  // Native: full path must equal the exe link target (a same-named file elsewhere does not match).
  const std::string nativeMaps =
      "00100000-00101000 r--p 00000000 08:01 8 /other/Game.x86_64\n"
      "00600000-00601000 r--p 00000000 08:01 9 /opt/game/Game.x86_64\n"
      "00400000-00401000 r--p 00000000 08:01 9 /opt/game/Game.x86_64\n";
  assert(LowestMappingBase(nativeMaps, "Game.x86_64", "/opt/game/Game.x86_64", false) == 0x400000);
  assert(LowestMappingBase(nativeMaps, "Game.x86_64", "/opt/none", false) == 0);

  // QueryMaps / ParseMaps / GroupModules.
  {
    const std::string maps =
        "00400000-00401000 r--p 00000000 08:01 5 /g/A.exe\n"
        "00401000-00500000 r-xp 00001000 08:01 5 /g/A.exe\n"
        "00600000-00601000 rw-p 00000000 00:00 0\n"
        "7f0000000000-7f0000100000 r--p 00000000 08:01 9 /usr/lib/libc.so.6\n"
        "7f0000100000-7f0000200000 r-xp 00100000 08:01 9 /usr/lib/libc.so.6\n"
        "7f0000300000-7f0000301000 ---p 00000000 00:00 0 [heap]\n"
        "7f0000400000-7f0000401000 r--s 00000000 00:05 3 /dev/shm/x\n"
        "7f0000500000-7f0000501000 r--p 00000000 08:01 7 /usr/lib/libm.so.6\n"
        "7f0000600000-7f0000601000 r--p 00000000 08:01 9 /usr/lib/libc.so.6\n"
        "ffffffffff600000-ffffffffff601000 --xp 00000000 00:00 0 [vsyscall]\n";
    bool ok = false;
    std::vector<MapsEntry> v = ParseMaps(maps, &ok);
    assert(ok && v.size() == 10);
    RegionAnswer a;
    // Inside a mapping, at its first and last byte.
    assert(QueryMaps(v, 0x400000, a) && !a.free && a.base == 0x400000 && a.end == 0x401000 && a.r && !a.w && !a.x);
    assert(QueryMaps(v, 0x4fffff, a) && a.base == 0x401000 && a.end == 0x500000 && a.r && a.x && !a.w);
    assert(QueryMaps(v, 0x600800, a) && a.w && a.r && !a.x);
    assert(QueryMaps(v, 0x7f0000300000ull, a) && !a.free && !a.r && !a.w && !a.x);  // ---p is committed, unreadable
    // The gap below the first mapping starts at 0.
    assert(QueryMaps(v, 0x1000, a) && a.free && a.base == 0 && a.end == 0x400000);
    assert(QueryMaps(v, 0, a) && a.free && a.base == 0);
    // A gap between two mappings reports the gap exactly.
    assert(QueryMaps(v, 0x500000, a) && a.free && a.base == 0x500000 && a.end == 0x600000);
    assert(QueryMaps(v, 0x5fffff, a) && a.free && a.base == 0x500000 && a.end == 0x600000);
    assert(QueryMaps(v, 0x601000, a) && a.free && a.base == 0x601000 && a.end == 0x7f0000000000ull);
    // The gap before [vsyscall] runs to it; past it there is nothing.
    assert(QueryMaps(v, 0x7f0000601000ull, a) && a.free && a.end == 0xffffffffff600000ull);
    assert(!QueryMaps(v, 0xffffffffff601000ull, a));
    // No mappings at all: everything below the top of user space is free.
    assert(QueryMaps({}, 0x1234, a) && a.free && a.base == 0 && a.end == kUserSpaceEnd);
    assert(!QueryMaps({}, kUserSpaceEnd, a));

    // Disorder (a mapping changed between read() chunks) is flagged.
    ParseMaps("00500000-00600000 r--p 00000000 00:00 0\n00400000-00501000 r--p 00000000 00:00 0\n", &ok);
    assert(!ok);

    std::vector<ModuleSpan> mods = GroupModules(v);
    assert(mods.size() == 3);  // A.exe, libc, libm; [heap], anon, /dev/shm, [vsyscall] are not modules
    assert(mods[0].path == "/g/A.exe" && mods[0].base == 0x400000 && mods[0].end == 0x500000);
    assert(mods[1].path == "/usr/lib/libc.so.6" && mods[1].base == 0x7f0000000000ull &&
           mods[1].end == 0x7f0000601000ull);  // span, including the gap between its mappings
    assert(mods[2].path == "/usr/lib/libm.so.6");
    assert(!IsModulePath("[vdso]") && !IsModulePath("") && !IsModulePath("/memfd:x") &&
           !IsModulePath("/SYSV00000000") && IsModulePath("/home/u/Game Dir/g.so"));
  }

  // stat state is read after the LAST ')': comm may hold spaces and parens.
  assert(StatState("123 (bash) S 1 2 3") == 'S');
  assert(StatState("123 (a) Z b) Z 1 2") == 'Z');
  assert(StatState("123 (x)") == 0);
  assert(StatState("nonsense") == 0);

  puts("proc_parse_test OK");
  return 0;
}
