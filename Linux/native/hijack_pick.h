#pragma once
#include <cstdlib>
#include <string>
#include <vector>

#include <sys/types.h>

// Pure logic for choosing which thread of a target process to briefly
// hijack for a remote call or syscall (remote_exec.h). Hijacking means
// pointing a STOPPED thread's registers at our own code for a few
// instructions and then putting it back — the thread keeps whatever
// userspace locks it was holding the whole time. A thread already blocked
// in an interruptible wait syscall (futex, poll, nanosleep, ...) is very
// unlikely to be mid-way through a lock our stub's own libc calls (malloc,
// in particular) would need, unlike an arbitrary running thread. This
// cannot be a guarantee — only Windows' real CreateRemoteThread (a brand
// new thread, no borrowed state) is free of the risk — so it is a
// heuristic, not a proof.
namespace linuxhijack {

// /proc/<pid>/task/<tid>/syscall's first field: a syscall number as text,
// "running" (not currently in one), or empty when the file could not be
// read (thread gone, or this kernel does not expose it).
inline std::string FirstSyscallField(const std::string& syscallFile) {
  size_t end = syscallFile.find_first_of(" \t\n");
  return syscallFile.substr(0, end == std::string::npos ? syscallFile.size() : end);
}

// 2: a known-safe interruptible wait (the thread will not run our stub's
//    code path itself, and is not mid-malloc on the way into one).
// 1: some other syscall (unknown safety, but at least not running
//    arbitrary userspace code right now).
// 0: "running", or the field could not be read.
inline int SafetyScore(const std::string& syscallField) {
  if (syscallField.empty() || syscallField == "running") return 0;
  char* end = nullptr;
  long nr = strtol(syscallField.c_str(), &end, 10);
  if (end == syscallField.c_str() || *end != '\0') return 0;
  // x86-64 syscall numbers for: read, poll, select, pause, nanosleep,
  // wait4, rt_sigtimedwait, futex, clock_nanosleep, epoll_wait, pselect6,
  // ppoll, epoll_pwait. Any of these blocks in an interruptible sleep with
  // no userspace-visible side effect while it waits.
  switch (nr) {
    case 0: case 7: case 23: case 34: case 35: case 61: case 128:
    case 202: case 230: case 232: case 270: case 271: case 281:
      return 2;
    default:
      return 1;
  }
}

struct Candidate {
  pid_t tid;
  bool isLeader;
  std::string syscallField;  // FirstSyscallField's result; empty if unreadable.
};

// The tid most likely safe to borrow briefly: highest SafetyScore, ties
// broken toward a non-leader thread (the leader is more likely to be the
// one driving the game's own frame loop), then toward the earliest entry
// (stable). `candidates` must be non-empty; -1 only then.
inline pid_t PickHijackThread(const std::vector<Candidate>& candidates) {
  if (candidates.empty()) return -1;
  size_t best = 0;
  int bestScore = -1;
  for (size_t i = 0; i < candidates.size(); ++i) {
    int score = SafetyScore(candidates[i].syscallField);
    // Prefer a strictly higher score; among equal scores prefer a
    // non-leader over a leader, keeping the first match otherwise.
    if (score > bestScore || (score == bestScore && candidates[best].isLeader && !candidates[i].isLeader)) {
      bestScore = score;
      best = i;
    }
  }
  return candidates[best].tid;
}

}  // namespace linuxhijack
