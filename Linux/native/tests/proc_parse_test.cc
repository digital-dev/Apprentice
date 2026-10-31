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

  // stat state is read after the LAST ')': comm may hold spaces and parens.
  assert(StatState("123 (bash) S 1 2 3") == 'S');
  assert(StatState("123 (a) Z b) Z 1 2") == 'Z');
  assert(StatState("123 (x)") == 0);
  assert(StatState("nonsense") == 0);

  puts("proc_parse_test OK");
  return 0;
}
