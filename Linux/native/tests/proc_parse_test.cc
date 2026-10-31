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

  // Whole fixture: lowest mapping of the exe name.
  std::istringstream in(Slurp("fixtures/maps_wine.txt"));
  std::string line;
  uintptr_t lowest = 0;
  while (std::getline(in, line)) {
    MapsEntry m;
    if (ParseMapsLine(line, m) && BaseName(m.path) == "Schedule I.exe" && (!lowest || m.start < lowest))
      lowest = m.start;
  }
  assert(lowest == 0x400000);

  // stat state is read after the LAST ')': comm may hold spaces and parens.
  assert(StatState("123 (bash) S 1 2 3") == 'S');
  assert(StatState("123 (a) Z b) Z 1 2") == 'Z');
  assert(StatState("123 (x)") == 0);
  assert(StatState("nonsense") == 0);

  puts("proc_parse_test OK");
  return 0;
}
