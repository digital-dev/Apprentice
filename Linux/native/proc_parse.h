#pragma once
// Pure /proc text parsers for the Linux backend. No file IO here so they can
// be unit-tested against fixtures (tests/proc_parse_test.cc).
#include <cstdint>
#include <cstdlib>
#include <string>
#include <strings.h>

namespace linuxproc {

// Final path component, splitting on both '/' and '\' (Wine reports Windows paths).
inline std::string BaseName(const std::string& path) {
  size_t i = path.find_last_of("/\\");
  return i == std::string::npos ? path : path.substr(i + 1);
}

inline bool EndsWithExe(const std::string& s) {
  return s.size() >= 4 && strcasecmp(s.c_str() + s.size() - 4, ".exe") == 0;
}

// The executable's file name, as Windows would show it for Wine processes.
//
// A Wine process's /proc/<pid>/exe is wine64-preloader (or similar) and its
// comm is truncated to 15 chars, so the real name comes from argv: Wine
// launched directly has the game as argv[0] (a Windows or Unix path), and
// `wine game.exe` has it as argv[1]. Only argv[0] and argv[1] are checked on
// purpose: Proton's `proton waitforexitandrun /path/Game.exe` puts it deeper,
// but scanning all of argv would misname ordinary programs that merely take a
// .exe argument (e.g. `wine64-preloader` helpers, `file foo.exe`). A Proton
// game is still identified by its own wine process, whose argv[0] is the exe.
// Native processes get the basename of the /proc/<pid>/exe link. Names keep
// their case and spaces.
inline std::string ExeNameFromCmdline(const std::string& cmdlineNulSeparated,
                                      const std::string& exeLinkTarget) {
  size_t pos = 0;
  for (int arg = 0; arg < 2 && pos < cmdlineNulSeparated.size(); ++arg) {
    size_t end = cmdlineNulSeparated.find('\0', pos);
    if (end == std::string::npos) end = cmdlineNulSeparated.size();
    std::string base = BaseName(cmdlineNulSeparated.substr(pos, end - pos));
    if (EndsWithExe(base)) return base;
    pos = end + 1;
  }
  return BaseName(exeLinkTarget);
}

struct MapsEntry {
  uintptr_t start = 0, end = 0;
  bool r = false, w = false, x = false, priv = false;
  uint64_t offset = 0;
  std::string path;  // empty for anonymous mappings; may contain spaces
};

// One /proc/<pid>/maps line: "start-end perms offset dev inode   path".
// The path is everything after the inode field's padding, so it may contain
// spaces; a trailing " (deleted)" is stripped. False on a malformed line.
inline bool ParseMapsLine(const std::string& line, MapsEntry& out) {
  const char* s = line.c_str();
  char* p = nullptr;
  MapsEntry e;
  e.start = (uintptr_t)strtoull(s, &p, 16);
  if (p == s || *p != '-') return false;
  s = p + 1;
  e.end = (uintptr_t)strtoull(s, &p, 16);
  if (p == s || *p != ' ') return false;
  s = p + 1;
  if (!s[0] || !s[1] || !s[2] || !s[3] || s[4] != ' ') return false;
  e.r = s[0] == 'r';
  e.w = s[1] == 'w';
  e.x = s[2] == 'x';
  e.priv = s[3] == 'p';
  s += 5;
  e.offset = strtoull(s, &p, 16);
  if (p == s || *p != ' ') return false;
  s = p + 1;
  // dev (major:minor)
  while (*s && *s != ' ') ++s;
  if (*s != ' ') return false;
  ++s;
  // inode
  if (*s < '0' || *s > '9') return false;
  while (*s >= '0' && *s <= '9') ++s;
  while (*s == ' ') ++s;
  e.path = s;
  static const std::string kDeleted = " (deleted)";
  if (e.path.size() >= kDeleted.size() &&
      e.path.compare(e.path.size() - kDeleted.size(), kDeleted.size(), kDeleted) == 0)
    e.path.resize(e.path.size() - kDeleted.size());
  out = std::move(e);
  return true;
}

// Base address of the main executable image, from the text of /proc/<pid>/maps.
// Wine: the lowest-start mapping whose path basename equals `exeName`
// (case-insensitive, since Wine's file system is). Native: the lowest-start
// mapping whose path equals `exeLinkTarget`. 0 when nothing matches. A
// preloader or .so mapped below the exe never matches: its basename differs.
inline uintptr_t LowestMappingBase(const std::string& mapsText, const std::string& exeName,
                                   const std::string& exeLinkTarget, bool wine) {
  uintptr_t lowest = 0;
  size_t pos = 0;
  while (pos < mapsText.size()) {
    size_t nl = mapsText.find('\n', pos);
    if (nl == std::string::npos) nl = mapsText.size();
    MapsEntry m;
    if (ParseMapsLine(mapsText.substr(pos, nl - pos), m) && !m.path.empty()) {
      bool match = wine ? strcasecmp(BaseName(m.path).c_str(), exeName.c_str()) == 0
                        : m.path == exeLinkTarget;
      if (match && (lowest == 0 || m.start < lowest)) lowest = m.start;
    }
    pos = nl + 1;
  }
  return lowest;
}

// State letter from /proc/<pid>/stat. comm (field 2) may contain spaces and
// parentheses, so the state is the first non-space char after the LAST ')'.
// Returns 0 when the line is malformed.
inline char StatState(const std::string& stat) {
  size_t rp = stat.rfind(')');
  if (rp == std::string::npos) return 0;
  size_t i = rp + 1;
  while (i < stat.size() && stat[i] == ' ') ++i;
  return i < stat.size() ? stat[i] : 0;
}

}  // namespace linuxproc
