#include "platform.h"
#include "proc_parse.h"
#include "procmem_fd.h"

#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdlib>
#include <fstream>
#include <sstream>

// Process enumeration and identity on Linux, from /proc. Parsing lives in
// proc_parse.h; this file only does the file IO.
namespace platform {
namespace {

std::string ProcPath(uint32_t pid, const char* leaf) {
  return "/proc/" + std::to_string(pid) + "/" + leaf;
}

// Whole file as bytes (cmdline is NUL-separated, so no line reads). False if
// it cannot be opened. /proc files report size 0, so read until EOF.
bool ReadFile(const std::string& path, std::string& out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  std::stringstream ss;
  ss << f.rdbuf();
  out = ss.str();
  return true;
}

// Target of /proc/<pid>/exe; empty when unreadable (kernel thread, or a
// process owned by another user).
std::string ExeLink(uint32_t pid) {
  char buf[4096];
  ssize_t n = readlink(ProcPath(pid, "exe").c_str(), buf, sizeof(buf) - 1);
  if (n <= 0) return std::string();
  std::string target(buf, (size_t)n);
  static const std::string kDeleted = " (deleted)";
  if (target.size() >= kDeleted.size() &&
      target.compare(target.size() - kDeleted.size(), kDeleted.size(), kDeleted) == 0)
    target.resize(target.size() - kDeleted.size());
  return target;
}

// 'Z' etc., or 0 if /proc/<pid>/stat cannot be read (process gone).
char State(uint32_t pid) {
  std::string stat;
  if (!ReadFile(ProcPath(pid, "stat"), stat)) return 0;
  return linuxproc::StatState(stat);
}

std::string Comm(uint32_t pid) {
  std::string comm;
  ReadFile(ProcPath(pid, "comm"), comm);
  while (!comm.empty() && (comm.back() == '\n' || comm.back() == '\0')) comm.pop_back();
  return comm;
}

} // namespace

bool ListProcesses(std::vector<ProcessEntry>& out) {
  out.clear();
  DIR* dir = opendir("/proc");
  if (!dir) return false;
  while (dirent* ent = readdir(dir)) {
    char* end = nullptr;
    unsigned long pid = strtoul(ent->d_name, &end, 10);
    if (end == ent->d_name || *end != '\0' || pid == 0) continue;

    char state = State((uint32_t)pid);
    if (state == 0 || state == 'Z') continue; // gone, or a zombie

    std::string cmdline;
    ReadFile(ProcPath((uint32_t)pid, "cmdline"), cmdline);
    std::string exe = ExeLink((uint32_t)pid);
    if (cmdline.empty() && exe.empty()) continue; // kernel thread

    std::string name = linuxproc::ExeNameFromCmdline(cmdline, exe);
    if (name.empty()) name = Comm((uint32_t)pid); // other user's process: exe unreadable
    if (name.empty()) continue;
    out.push_back({(uint32_t)pid, name});
  }
  closedir(dir);
  return true;
}

ProcessHandle OpenProcess(uint32_t pid, std::string& error) {
  struct stat st;
  if (pid == 0 || stat(("/proc/" + std::to_string(pid)).c_str(), &st) != 0) {
    int e = pid == 0 ? ENOENT : errno;
    error = e == ENOENT ? "process not found"
                        : std::string("cannot access process (check permissions): ") + strerror(e);
    return 0;
  }
  // A pid can be recycled: never inherit a descriptor cached for an earlier process of that number.
  DropProcMemFd((ProcessHandle)pid);
  return (ProcessHandle)pid;
}

void CloseProcess(ProcessHandle handle) { DropProcMemFd(handle); }

bool IsAlive(ProcessHandle handle) {
  char state = State((uint32_t)handle);
  return state != 0 && state != 'Z';
}

uintptr_t MainModuleBase(ProcessHandle handle) {
  uint32_t pid = (uint32_t)handle;
  std::string cmdline;
  ReadFile(ProcPath(pid, "cmdline"), cmdline);
  std::string exe = ExeLink(pid);
  std::string name = linuxproc::ExeNameFromCmdline(cmdline, exe);
  if (name.empty()) return 0;
  // Wine maps the PE as an ordinary file mapping of the .exe; a native
  // process is its own /proc/<pid>/exe target.
  bool wine = linuxproc::EndsWithExe(name);

  std::string maps;
  if (!ReadFile(ProcPath(pid, "maps"), maps)) return 0;
  return linuxproc::LowestMappingBase(maps, name, exe, wine);
}

} // namespace platform
