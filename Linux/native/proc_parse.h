#pragma once
// Pure /proc text parsers for the Linux backend. No file IO here so they can
// be unit-tested against fixtures (tests/proc_parse_test.cc).
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>
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

// All entries of a /proc/<pid>/maps text, in file order. Malformed lines are
// skipped. The kernel emits the file sorted by address, but one read() chunk at
// a time, so a mapping change between chunks can leave overlaps or disorder:
// `consistent` is false then and callers re-read.
inline std::vector<MapsEntry> ParseMaps(const std::string& mapsText, bool* consistent = nullptr) {
  std::vector<MapsEntry> v;
  bool ok = true;
  size_t pos = 0;
  while (pos < mapsText.size()) {
    size_t nl = mapsText.find('\n', pos);
    if (nl == std::string::npos) nl = mapsText.size();
    MapsEntry m;
    if (ParseMapsLine(mapsText.substr(pos, nl - pos), m) && m.end > m.start) {
      if (!v.empty() && m.start < v.back().end) ok = false;
      v.push_back(std::move(m));
    }
    pos = nl + 1;
  }
  if (consistent) *consistent = ok;
  return v;
}

// The region containing an address, in the shape platform::Region needs.
// `end` is one past the last byte; a gap between mappings is `free`.
struct RegionAnswer {
  uintptr_t base = 0, end = 0;
  bool free = false, r = false, w = false, x = false;
};

// Top of x86-64 user space; gaps are never reported above it.
constexpr uintptr_t kUserSpaceEnd = (uintptr_t)0x800000000000ull;

// `entries` must be sorted and non-overlapping (ParseMaps' `consistent`).
// A gap reports the gap itself (from the previous mapping's end, or 0, up to the
// next mapping's start, or the top of user space). False for an address past
// the last mapping when that is already above user space (the [vsyscall] page
// sits at the very top), so a caller walking regions upward terminates.
inline bool QueryMaps(const std::vector<MapsEntry>& entries, uintptr_t address, RegionAnswer& out) {
  uintptr_t prevEnd = 0;
  for (const MapsEntry& e : entries) {
    if (address < e.start) {
      out = RegionAnswer{};
      out.base = prevEnd;
      out.end = e.start;
      out.free = true;
      return true;
    }
    if (address < e.end) {
      out = RegionAnswer{};
      out.base = e.start;
      out.end = e.end;
      out.r = e.r;
      out.w = e.w;
      out.x = e.x;
      return true;
    }
    prevEnd = e.end;
  }
  if (address < kUserSpaceEnd && prevEnd < kUserSpaceEnd) {
    out = RegionAnswer{};
    out.base = prevEnd;
    out.end = kUserSpaceEnd;
    out.free = true;
    return true;
  }
  return false;
}

// Paths in maps that are real files worth calling modules: not [heap]/[stack]/
// [vdso], not anonymous, and not the pseudo-files shared memory shows up as.
inline bool IsModulePath(const std::string& path) {
  if (path.empty() || path[0] != '/') return false;
  static const char* const kSkip[] = {"/dev/", "/memfd:", "/SYSV", "/proc/", "/sys/"};
  for (const char* p : kSkip)
    if (path.compare(0, strlen(p), p) == 0) return false;
  return true;
}

// One file's mappings folded together: lowest start to highest end.
struct ModuleSpan {
  std::string path;
  uintptr_t base = 0, end = 0;
};

// File-backed mappings grouped by full path, in order of each file's lowest
// address (first appearance in sorted maps).
inline std::vector<ModuleSpan> GroupModules(const std::vector<MapsEntry>& entries) {
  std::vector<ModuleSpan> out;
  std::map<std::string, size_t> index;
  for (const MapsEntry& e : entries) {
    if (!IsModulePath(e.path)) continue;
    auto it = index.find(e.path);
    if (it == index.end()) {
      index.emplace(e.path, out.size());
      out.push_back({e.path, e.start, e.end});
    } else {
      ModuleSpan& m = out[it->second];
      if (e.start < m.base) m.base = e.start;
      if (e.end > m.end) m.end = e.end;
    }
  }
  return out;
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

// The leading decimal of a /proc/<pid>/status field ("TracerPid:\t471" -> 471),
// matched on the whole key at the start of a line. -1 when absent or not a number.
inline long StatusField(const std::string& status, const char* key) {
  const std::string k = std::string(key) + ":";
  for (size_t pos = 0; pos < status.size();) {
    size_t end = status.find('\n', pos);
    if (end == std::string::npos) end = status.size();
    if (status.compare(pos, k.size(), k) == 0) {
      const char* s = status.c_str() + pos + k.size();
      while (*s == ' ' || *s == '\t') ++s;
      char* stop = nullptr;
      long v = strtol(s, &stop, 10);
      return stop == s ? -1 : v;
    }
    pos = end + 1;
  }
  return -1;
}

// A /proc/<pid>/task entry name as a tid; 0 for ".", "..", or anything that is
// not a positive decimal in pid range.
inline int TaskId(const char* name) {
  if (!name || !*name) return 0;
  long v = 0;
  for (const char* p = name; *p; ++p) {
    if (*p < '0' || *p > '9') return 0;
    v = v * 10 + (*p - '0');
    if (v > 0x3fffffff) return 0;  // above PID_MAX_LIMIT (4M) by far: not a tid
  }
  return (int)v;
}

}  // namespace linuxproc
