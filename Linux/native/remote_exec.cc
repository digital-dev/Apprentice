#include "remote_exec.h"
#include "hijack_pick.h"
#include "held_threads.h"
#include "ptrace_core.h"
#include "tracer_thread.h"
#include "platform.h"

#include <dirent.h>
#include <signal.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <sstream>
#include <vector>

namespace linuxremote {
namespace {

using Clock = std::chrono::steady_clock;
constexpr useconds_t kPollUs = 500;
// How long RemoteSyscall waits for its two-instruction `syscall; int3` to
// trap, before giving up and restoring immediately — generous for ptrace
// scheduling noise, but callers only ever pass a syscall that cannot block
// (see the header), so this bound is essentially never hit in practice.
constexpr uint32_t kRemoteSyscallTimeoutMs = 2000;

// The thread ids in /proc/<pid>/task. Empty (not an error) when the
// directory cannot be read — the pick below then simply finds nothing.
std::vector<pid_t> TaskIds(uint32_t pid) {
  std::vector<pid_t> out;
  DIR* dir = opendir(("/proc/" + std::to_string(pid) + "/task").c_str());
  if (!dir) return out;
  while (dirent* ent = readdir(dir)) {
    char* end = nullptr;
    long v = strtol(ent->d_name, &end, 10);
    if (end != ent->d_name && *end == '\0' && v > 0) out.push_back((pid_t)v);
  }
  closedir(dir);
  return out;
}

// /proc/<tid>/syscall's first field (a syscall number, or "running"), empty
// when the thread is gone or the file could not be read.
std::string SyscallField(pid_t tid) {
  std::ifstream f("/proc/" + std::to_string(tid) + "/syscall");
  if (!f) return std::string();
  std::stringstream ss;
  ss << f.rdbuf();
  return linuxhijack::FirstSyscallField(ss.str());
}

std::vector<linuxhijack::Candidate> CandidatesFrom(uint32_t pid, const std::vector<pid_t>& tids) {
  std::vector<linuxhijack::Candidate> out;
  for (pid_t tid : tids) out.push_back({tid, (uint32_t)tid == pid, SyscallField(tid)});
  return out;
}

// Chooses a thread of `pid` to briefly hijack. `borrowed` is true when it
// is one SuspendAll already holds stopped (reuse, never re-attach: ptrace
// allows only one tracer per tracee); false when nothing is suspended and
// the caller must attach its own StopGuard. False only when no thread of
// `pid` exists at all.
bool PickThread(uint32_t pid, pid_t& tid, bool& borrowed) {
  std::vector<pid_t> held = platform_linux::HeldThreadIds(pid);
  std::vector<linuxhijack::Candidate> candidates;
  if (!held.empty()) {
    candidates = CandidatesFrom(pid, held);
    borrowed = true;
  } else {
    std::vector<pid_t> tids = TaskIds(pid);
    if (tids.empty()) return false;
    candidates = CandidatesFrom(pid, tids);
    borrowed = false;
  }
  pid_t chosen = linuxhijack::PickHijackThread(candidates);
  if (chosen <= 0) return false;
  tid = chosen;
  return true;
}

// Waits (bounded, WNOHANG-polling) for `tid`'s next stop. True only for a
// plain SIGTRAP signal-delivery stop (our own planted trap, never one of
// our own PTRACE_EVENT stops, which have a nonzero high byte); interleaves
// other queued tracer work while it waits.
bool PollTrap(pid_t tid, uint32_t timeoutMs) {
  const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
  for (;;) {
    int st = 0;
    pid_t r = waitpid(tid, &st, __WALL | WNOHANG);
    if (r == tid) return WIFSTOPPED(st) && (st >> 16) == 0 && WSTOPSIG(st) == SIGTRAP;
    if (r < 0 && errno != EINTR) return false;  // ECHILD: not (or no longer) ours
    linuxptrace::RunPending();
    if (Clock::now() >= deadline) return false;
    usleep(kPollUs);
  }
}

}  // namespace

bool RemoteSyscall(uint32_t pid, long nr, const uint64_t args[6], uint64_t& result) {
  return linuxptrace::OnTracer([&]() -> bool {
    pid_t tid;
    bool borrowed;
    if (!PickThread(pid, tid, borrowed)) return false;

    std::unique_ptr<linuxptrace::StopGuard> guard;
    if (!borrowed) {
      std::string err;
      guard = std::make_unique<linuxptrace::StopGuard>(tid, err);
      if (!guard->ok()) return false;
    }

    user_regs_struct orig{};
    if (!linuxptrace::GetRegs(tid, orig)) return false;

    const platform::ProcessHandle handle = (platform::ProcessHandle)pid;
    unsigned char origBytes[3];
    if (!platform::ReadMemory(handle, orig.rip, origBytes, sizeof(origBytes))) return false;
    static const unsigned char kStub[3] = {0x0F, 0x05, 0xCC};  // syscall ; int3
    if (!platform::WriteMemoryUnprotected(handle, orig.rip, kStub, sizeof(kStub))) return false;

    user_regs_struct hijacked = orig;
    // Not "returning from a syscall" as far as the kernel's syscall-restart
    // check is concerned: it reads orig_rax before touching rax/rip on the
    // way back to userspace, and skips the whole check when it is -1. The
    // ORIGINAL orig_rax/rax are restored below once this run is over, so
    // that check runs for real then, using the thread's true values — if it
    // really was mid-syscall, it restarts exactly as if this had never
    // happened. See remote_exec.h's class comment.
    hijacked.orig_rax = (unsigned long long)-1;
    hijacked.rax = (unsigned long long)nr;
    hijacked.rdi = args[0];
    hijacked.rsi = args[1];
    hijacked.rdx = args[2];
    hijacked.r10 = args[3];
    hijacked.r8 = args[4];
    hijacked.r9 = args[5];
    bool launched = linuxptrace::SetRegs(tid, hijacked) && ptrace(PTRACE_CONT, tid, nullptr, nullptr) == 0;

    bool trapped = launched && PollTrap(tid, kRemoteSyscallTimeoutMs);
    bool ok = false;
    if (trapped) {
      user_regs_struct after{};
      if (linuxptrace::GetRegs(tid, after)) {
        result = after.rax;
        ok = true;
      }
    }
    // Put the thread back regardless of how this ended: the stub is just
    // `syscall; int3`, which the guard above (callers only ever pass a
    // non-blocking syscall number) means cannot genuinely still be running
    // by now even on a timeout, so there is no "maybe still live" case to
    // defer for here the way Hijack::Finish below has to.
    platform::WriteMemoryUnprotected(handle, orig.rip, origBytes, sizeof(origBytes));
    linuxptrace::SetRegs(tid, orig);
    return ok;  // `guard`, if any, detaches here with the ORIGINAL pending signal.
  });
}

namespace {

// One thread currently running caller-supplied code (Hijack::Start to
// Finish), tracked so a timeout does not abandon it mid-flight: nothing
// here restores its registers, or gives it back to SuspendAll/detaches it,
// until its trap is actually observed. Tracer thread only.
struct Live {
  uint32_t pid;
  pid_t tid;
  user_regs_struct original{};
  bool borrowed;
  std::unique_ptr<linuxptrace::StopGuard> guard;  // null when borrowed
  bool resolved = false;
  bool ok = false;  // meaningful only once resolved
};

std::vector<std::unique_ptr<Live>> g_live;  // tracer thread only

Live* Find(uint32_t pid, pid_t tid) {
  for (auto& h : g_live)
    if (h->pid == pid && h->tid == tid) return h.get();
  return nullptr;
}

void RemoveLive(uint32_t pid, pid_t tid) {
  g_live.erase(std::remove_if(g_live.begin(), g_live.end(),
                               [&](const auto& h) { return h->pid == pid && h->tid == tid; }),
               g_live.end());
}

// Restores `h`'s original registers (success or failure alike — a thread
// that trapped on something other than our own planted int3, e.g. a SIGSEGV
// from a bad start address, must never run another instruction of a stub
// that just faulted) and, for a thread this Hijack attached itself, gives
// it back by destroying its StopGuard — whose destructor detaches it,
// re-delivering whatever signal was pending from BEFORE this hijack ever
// touched it (StopGuard's own, unrelated, bookkeeping). A borrowed thread
// is left exactly as SuspendAll expects: stopped, registers restored,
// untouched otherwise.
void Resolve(Live& h, bool ok) {
  if (h.resolved) return;
  linuxptrace::SetRegs(h.tid, h.original);
  h.resolved = true;
  h.ok = ok;
  if (!h.borrowed) h.guard.reset();
}

// One non-blocking check of `h`'s stop. True once resolved (trapped,
// faulted, or gone) — a false return means it is still genuinely running.
bool PollOnce(Live& h) {
  if (h.resolved) return true;
  int st = 0;
  pid_t r = waitpid(h.tid, &st, __WALL | WNOHANG);
  if (r == h.tid) {
    bool ourTrap = WIFSTOPPED(st) && (st >> 16) == 0 && WSTOPSIG(st) == SIGTRAP;
    Resolve(h, ourTrap);
    return true;
  }
  if (r < 0) {
    if (errno == EINTR) return false;
    h.resolved = true;  // ECHILD: no longer ours to wait on; nothing left to restore
    h.ok = false;
    return true;
  }
  return false;  // r == 0: still running
}

}  // namespace

struct Hijack::Impl {
  uint32_t pid;
  pid_t tid;
};

Hijack::Hijack(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
Hijack::~Hijack() { Finish(); }

std::unique_ptr<Hijack> Hijack::Start(uint32_t pid, uintptr_t startAddress, uintptr_t param,
                                       uintptr_t trampoline) {
  pid_t chosenTid = -1;
  bool launched = linuxptrace::OnTracer([&]() -> bool {
    bool borrowed = false;
    if (!PickThread(pid, chosenTid, borrowed)) return false;

    std::unique_ptr<linuxptrace::StopGuard> guard;
    if (!borrowed) {
      std::string err;
      guard = std::make_unique<linuxptrace::StopGuard>(chosenTid, err);
      if (!guard->ok()) return false;
    }

    user_regs_struct orig{};
    if (!linuxptrace::GetRegs(chosenTid, orig)) return false;

    // Headroom below the thread's own stack (it keeps whatever it was using
    // there; we must not stomp it), 16-aligned, with `trampoline` pushed as
    // the return address — the same shape a real `call` would leave: rsp
    // sits 8 mod 16 at entry, one push short of 16-alignment, exactly what
    // mono_call.cc's own stub already assumes.
    uintptr_t newRsp = (orig.rsp - 0x200) & ~(uintptr_t)0xF;
    newRsp -= 8;
    const platform::ProcessHandle handle = (platform::ProcessHandle)pid;
    if (!platform::WriteMemoryUnprotected(handle, newRsp, &trampoline, sizeof(trampoline))) return false;

    user_regs_struct hijacked = orig;
    hijacked.orig_rax = (unsigned long long)-1;  // see RemoteSyscall's comment on this field
    hijacked.rip = startAddress;
    hijacked.rsp = newRsp;
    hijacked.rcx = param;  // Microsoft x64's first argument register
    hijacked.rdi = param;  // System V's first argument register
    if (!linuxptrace::SetRegs(chosenTid, hijacked)) return false;
    if (ptrace(PTRACE_CONT, chosenTid, nullptr, nullptr) != 0) return false;

    auto live = std::make_unique<Live>();
    live->pid = pid;
    live->tid = chosenTid;
    live->original = orig;
    live->borrowed = borrowed;
    live->guard = std::move(guard);
    g_live.push_back(std::move(live));
    return true;
  });
  if (!launched) return nullptr;
  auto impl = std::make_unique<Impl>();
  impl->pid = pid;
  impl->tid = chosenTid;
  return std::unique_ptr<Hijack>(new Hijack(std::move(impl)));
}

bool Hijack::Wait(uint32_t timeoutMs) {
  return linuxptrace::OnTracer([&]() -> bool {
    Live* h = Find(impl_->pid, impl_->tid);
    if (!h) return false;  // already Finish()ed, or Start() never actually launched one
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
    for (;;) {
      if (PollOnce(*h)) return h->ok;
      linuxptrace::RunPending();
      if (Clock::now() >= deadline) return false;  // still pending; a later Wait/Finish picks it up
      usleep(kPollUs);
    }
  });
}

void Hijack::Finish() {
  linuxptrace::OnTracer([&]() {
    Live* h = Find(impl_->pid, impl_->tid);
    if (!h) return;
    // One more short bounded wait, in case the caller's own Wait timed out
    // moments ago: most callers call Finish right after. Never longer than
    // this — see the class comment on why an unresolved run is left pending
    // rather than forced.
    const auto deadline = Clock::now() + std::chrono::milliseconds(500);
    while (!h->resolved && Clock::now() < deadline) {
      if (PollOnce(*h)) break;
      linuxptrace::RunPending();
      usleep(kPollUs);
    }
    if (h->resolved) RemoveLive(impl_->pid, impl_->tid);
    // else: genuinely still running (or a hung stub). Left in g_live; the
    // next Wait/Finish/FinishPendingFor on this pid keeps checking.
  });
}

void FinishPendingFor(uint32_t pid, uint32_t boundedMs) {
  linuxptrace::OnTracer([&] {
    const auto deadline = Clock::now() + std::chrono::milliseconds(boundedMs);
    for (;;) {
      bool anyPending = false;
      for (auto& h : g_live) {
        if (h->pid != pid || h->resolved) continue;
        if (!PollOnce(*h)) anyPending = true;
      }
      if (!anyPending) break;
      if (Clock::now() >= deadline) {
        fprintf(stderr,
                "apprentice: a remote call on process %u did not finish within %u ms; its "
                "borrowed thread may be left stopped until it does\n",
                pid, boundedMs);
        break;
      }
      linuxptrace::RunPending();
      usleep(kPollUs);
    }
    g_live.erase(std::remove_if(g_live.begin(), g_live.end(),
                                 [&](const auto& h) { return h->pid == pid && h->resolved; }),
                 g_live.end());
  });
}

}  // namespace linuxremote
