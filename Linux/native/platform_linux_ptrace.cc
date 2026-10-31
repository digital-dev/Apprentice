#include "platform.h"
#include "proc_parse.h"
#include "ptrace_core.h"
#include "tracer_thread.h"

#include <dirent.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <fstream>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>

// SuspendAll/ResumeAll, ListThreads and GetThreadRegisters on Linux. Every ptrace call
// runs on the tracer thread (tracer_thread.h), so a suspension made on one Node thread
// can be released from another; the held set lives on, and is only touched by, that thread.
namespace platform {
namespace {

// Rounds of "list the threads, stop the new ones" before giving up on a target that keeps
// spawning threads faster than they can be stopped. Stopped threads cannot spawn, so a
// round that finds nothing new proves every thread is held.
constexpr int kMaxSuspendRounds = 20;

std::vector<std::unique_ptr<linuxptrace::StopGuard>> g_held;  // tracer thread only

std::mutex g_errorMutex;
std::string g_suspendError;

// The thread ids in /proc/<pid>/task. False (with errno) when the directory cannot be read.
bool ReadTaskIds(uint32_t pid, std::vector<pid_t>& out) {
  out.clear();
  const std::string path = "/proc/" + std::to_string(pid) + "/task";
  DIR* dir = opendir(path.c_str());
  if (!dir) return false;
  while (dirent* ent = readdir(dir))
    if (int tid = linuxproc::TaskId(ent->d_name)) out.push_back(tid);
  closedir(dir);
  return true;
}

// True while every held thread is still in its ptrace stop ('t'). A SIGKILL of the target
// wakes its stopped threads before kill() returns, so this catches a target killed while
// SuspendAll worked: its threads are dying (running, then zombies), not held.
bool AllHeldStillStopped() {
  for (const auto& g : g_held) {
    std::ifstream f("/proc/" + std::to_string(g->tid()) + "/stat");
    std::stringstream ss;
    ss << f.rdbuf();
    if (linuxproc::StatState(ss.str()) != 't') return false;
  }
  return true;
}

bool IsHeld(pid_t tid) {
  return std::any_of(g_held.begin(), g_held.end(), [&](const auto& g) { return g->tid() == tid; });
}

// Detaches every held thread, the leader (usually first) last: an exited leader becomes
// reapable only once its other threads are released.
void ReleaseHeld() {
  while (!g_held.empty()) g_held.pop_back();
  linuxptrace::RetryDeferredDetaches();
}

void RegisterExitRelease() {
  static bool registered = false;  // tracer thread only
  if (registered) return;
  registered = true;
  linuxptrace::AtTracerExit([] { ReleaseHeld(); });
}

// One round: stop every listed thread not yet held. False on a real failure (`err` set);
// `added` says whether this round stopped anything new.
bool StopNewThreads(const std::vector<pid_t>& tids, bool& added, std::string& err) {
  added = false;
  for (pid_t tid : tids) {
    if (IsHeld(tid)) continue;
    auto guard = std::make_unique<linuxptrace::StopGuard>(tid, err);
    if (guard->ok()) {
      g_held.push_back(std::move(guard));
      added = true;
    } else if (guard->gone()) {
      err.clear();  // exited between listing and attach: nothing left to suspend
    } else {
      return false;
    }
  }
  return true;
}

bool SuspendOnTracer(uint32_t pid, std::string& err) {
  linuxptrace::RetryDeferredDetaches();
  if (!g_held.empty()) {
    err = "threads are already suspended: call ResumeAll first";
    return false;
  }
  RegisterExitRelease();
  std::vector<pid_t> tids;
  for (int round = 0; round < kMaxSuspendRounds; ++round) {
    if (!ReadTaskIds(pid, tids)) {
      err = "process " + std::to_string(pid) + " not found";
      break;
    }
    bool added = false;
    if (!StopNewThreads(tids, added, err)) break;
    if (added) continue;
    if (g_held.empty() || !AllHeldStillStopped()) {
      err = "process " + std::to_string(pid) + " exited";
      break;
    }
    return true;
  }
  if (err.empty()) err = "process " + std::to_string(pid) + " kept creating threads; could not stop them all";
  ReleaseHeld();
  return false;
}

void SetSuspendError(const std::string& err) {
  std::lock_guard<std::mutex> lk(g_errorMutex);
  g_suspendError = err;
}

}  // namespace

bool SuspendAll(ProcessHandle, uint32_t pid) {
  std::string err;
  bool ok = false;
  if ((pid_t)pid == getpid()) {
    err = "cannot suspend this process itself";
  } else {
    ok = linuxptrace::OnTracer([&] {
      try {
        return SuspendOnTracer(pid, err);
      } catch (...) {  // e.g. bad_alloc mid-way: still all or nothing
        ReleaseHeld();
        err = "internal error while suspending";
        return false;
      }
    });
  }
  if (!ok && err.empty()) err = "ptrace tracer thread unavailable";
  SetSuspendError(ok ? std::string() : err);
  return ok;
}

void ResumeAll() {
  linuxptrace::OnTracer([] { ReleaseHeld(); });
}

std::string SuspendAllError() {
  std::lock_guard<std::mutex> lk(g_errorMutex);
  return g_suspendError;
}

void SleepMs(uint32_t ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

bool ListThreads(uint32_t pid, std::vector<ThreadInfo>& out) {
  out.clear();
  std::vector<pid_t> tids;
  if (!ReadTaskIds(pid, tids)) return errno == ENOENT;  // no such process: no threads
  std::sort(tids.begin(), tids.end());
  // The leader (tid == pid) first, as Windows lists the main thread first.
  std::stable_partition(tids.begin(), tids.end(), [&](pid_t t) { return (uint32_t)t == pid; });
  for (pid_t t : tids) out.push_back(ThreadInfo{(uint32_t)t});
  return true;
}

bool GetThreadRegisters(uint32_t tid, ThreadRegisters& out) {
  return linuxptrace::OnTracer([&] {
    linuxptrace::RetryDeferredDetaches();
    user_regs_struct regs{};
    if (IsHeld((pid_t)tid)) {
      // Held by SuspendAll: read in place, never resume it.
      if (!linuxptrace::GetRegs((pid_t)tid, regs)) return false;
    } else {
      std::string err;
      linuxptrace::StopGuard guard((pid_t)tid, err);
      if (!guard.ok() || !linuxptrace::GetRegs((pid_t)tid, regs)) return false;
    }
    linuxptrace::ToThreadRegisters(regs, out);
    return true;
  });
}

}  // namespace platform
