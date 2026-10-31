// Linux hardware write-watch backend: platform::DebugSession and
// SupportsHardwareWatch, via ptrace hardware data breakpoints (Dr0-Dr3/Dr7),
// the Linux analogue of platform_win32.cc's DebugActiveProcess-based one.
//
// Every ptrace call in this process runs on the one tracer thread
// (tracer_thread.h) — ptrace requests are only valid from the thread that
// attached, and this backend is called from whichever Node/libuv thread
// happens to be running write_watch.cc's dedicated DebugLoop thread. Every
// public DebugSession method therefore dispatches through
// linuxptrace::OnTracer, which is what makes "the thread that called Attach"
// (platform.h's own cross-platform rule) true here too: it is always the
// SAME tracer thread underneath, regardless of which calling thread issues
// the request.
//
// PTRACE_SEIZE (never PTRACE_ATTACH) with PTRACE_O_TRACECLONE is used to
// attach, matching ptrace_core.h's own rule: no stray SIGSTOP, and new
// threads the target spawns are auto-attached by the kernel rather than
// racing us to see them first. Debug registers are per-thread CPU state that
// a clone()'d thread does NOT inherit, so every new thread still needs its
// own SetHwBreakpoint call from the caller — exactly like a freshly attached
// one — which is why ThreadCreated exists as its own event kind.
//
// A long-lived ptrace session needs machinery StopGuard (ptrace_core.h)
// deliberately does not offer: StopGuard exists for a brief stop-poke-resume
// round trip and detaches again immediately, where this backend holds threads
// attached indefinitely across many stop/continue cycles, needs to tell "I
// stopped this thread myself" apart from "ptrace already stopped it for me",
// and has to cope with new threads appearing mid-session. So this file keeps
// its own small, longer-lived state (DebugSession::State) instead, reusing
// only the pieces of ptrace_core.h that do not assume StopGuard's shape:
// kPtraceDeniedMessage, SuppressStopSigchld, GetRegs and ToThreadRegisters.
#include "platform.h"
#include "proc_parse.h"
#include "ptrace_core.h"
#include "tracer_thread.h"

#include <dirent.h>
#include <signal.h>
#include <sys/ptrace.h>
#include <sys/types.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <set>
#include <string>
#include <vector>

namespace platform {
namespace {

// ---- Debug-register bit layout (x86 architectural, identical to Win32's
// SetHwBreakpoint — this is CPU state, not an OS API) -----------------------

// Byte offset of u_debugreg[slot] inside `struct user`, computed from the
// array's own offset rather than `offsetof(struct user, u_debugreg[slot])`
// with a runtime `slot`: the latter is accepted by GCC/Clang as an
// extension but is not standard C++.
uintptr_t DebugRegOffset(int slot) {
  return offsetof(struct user, u_debugreg) + (uintptr_t)slot * sizeof(((struct user*)nullptr)->u_debugreg[0]);
}

// Reads Dr6 on a stopped thread and returns which watchpoint slot (0-3) its
// B0-B3 bits name, or -1 if none are set (a SIGTRAP from something else —
// the target's own int3, a signal-delivery race, ...). Clears Dr6 afterward:
// the CPU does not clear it on its own, and a stale bit left over from this
// trap must never be misread as naming a later, unrelated stop.
int ReadHitSlotAndClear(pid_t tid) {
  errno = 0;
  long dr6 = ptrace(PTRACE_PEEKUSER, tid, (void*)DebugRegOffset(6), nullptr);
  if (dr6 == -1 && errno != 0) return -1;
  int slot = -1;
  for (int i = 0; i < 4; ++i) {
    if (dr6 & (1L << i)) { slot = i; break; }
  }
  ptrace(PTRACE_POKEUSER, tid, (void*)DebugRegOffset(6), (void*)0L);
  return slot;
}

// Arms or disarms one slot's Dr7 bits, preserving every other slot's bits
// (a read-modify-write: Dr7 is shared across all 4 watchpoints). Caller must
// already have `tid` ptrace-stopped. False on either ptrace call failing —
// seen in practice on a kernel/hypervisor that does not expose hardware
// breakpoints at all (nested virtualization; see APPRENTICE_FORCE_NO_DEBUGREGS
// below for how CI exercises the resulting error path deterministically).
bool WriteDr7(pid_t tid, int slot, bool enable, uint64_t lenBits) {
  errno = 0;
  long dr7 = ptrace(PTRACE_PEEKUSER, tid, (void*)DebugRegOffset(7), nullptr);
  if (dr7 == -1 && errno != 0) return false;
  uint64_t v = (uint64_t)dr7;
  const uint64_t enableBit = (uint64_t)0x1 << (slot * 2);  // Ln (local enable)
  const int rwShift = 16 + slot * 4;                       // R/Wn, then LENn at +2
  v &= ~((uint64_t)0xF << rwShift);  // clear this slot's condition+len regardless
  if (enable) {
    v |= enableBit;
    v |= ((uint64_t)0x1 << rwShift);  // 01 = break on data write
    v |= (lenBits << (rwShift + 2));
  } else {
    v &= ~enableBit;
  }
  return ptrace(PTRACE_POKEUSER, tid, (void*)DebugRegOffset(7), (void*)v) == 0;
}

// ---- Bounded waits --------------------------------------------------------

constexpr auto kStopTimeout = std::chrono::milliseconds(2000);
constexpr useconds_t kPollUs = 500;
// Wait()'s own idle-poll granularity, per the brief: short enough that other
// callers queued on the shared tracer thread (tracer_thread.h's RunPending,
// invoked every lap below) are never starved for long by one session's wait.
constexpr useconds_t kWaitPollUs = 5000;

// Waits (bounded) for `tid`'s next ptrace stop report. True with `status`
// filled on a stop; false with `gone` set if the thread exited/was reaped
// out from under us (a benign race, not a failure of whatever operation was
// waiting), false with `gone` clear on a plain timeout.
bool WaitForTidStop(pid_t tid, int& status, bool& gone) {
  const auto deadline = std::chrono::steady_clock::now() + kStopTimeout;
  for (;;) {
    int st = 0;
    pid_t r = waitpid(tid, &st, __WALL | WNOHANG);
    if (r == tid) {
      if (WIFSTOPPED(st)) { status = st; return true; }
      gone = true;
      return false;
    }
    if (r < 0 && errno == EINTR) continue;
    if (r < 0) { gone = true; return false; }  // ECHILD: not (or no longer) ours
    if (std::chrono::steady_clock::now() >= deadline) return false;
    usleep(kPollUs);
  }
}

// Interrupts an already-seized thread that is believed to be running right
// now and waits for the resulting stop. Used both for SetHwBreakpoint on a
// running thread and to bring every other thread to a stop for a
// ThreadCreated event (see HandleClone below).
bool InterruptRunningThread(pid_t tid, bool& gone) {
  if (ptrace(PTRACE_INTERRUPT, tid, nullptr, nullptr) != 0) {
    gone = (errno == ESRCH);
    return false;
  }
  int status = 0;
  return WaitForTidStop(tid, status, gone);
}

// ---- Attach / error classification ----------------------------------------

std::string ReadProcFile(pid_t tid, const char* leaf) {
  std::string path = "/proc/" + std::to_string(tid) + "/" + leaf;
  FILE* f = fopen(path.c_str(), "rb");
  if (!f) return std::string();
  std::string out;
  char buf[256];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
  fclose(f);
  return out;
}

// Why PTRACE_SEIZE failed. Mirrors ptrace_core.cc's own AttachError (not
// exported — it is tied to StopGuard's narrower error set), reusing the one
// piece that IS shared: kPtraceDeniedMessage, the UI-visible string for "no
// privilege to trace this".
std::string ClassifySeizeError(pid_t tid, int err, bool& gone) {
  if (err == ESRCH) {
    gone = true;
    return "thread " + std::to_string(tid) + " exited";
  }
  if (err == EPERM) {
    long tracer = linuxproc::StatusField(ReadProcFile(tid, "status"), "TracerPid");
    if (tracer == getpid())
      return "thread " + std::to_string(tid) + " is already traced by this process";
    if (tracer > 0)
      return "thread " + std::to_string(tid) + " is already traced by process " + std::to_string(tracer) +
             " (a debugger?)";
    return std::string(linuxptrace::kPtraceDeniedMessage);
  }
  return "ptrace attach to thread " + std::to_string(tid) + " failed: " + strerror(err);
}

bool ReadTaskIds(uint32_t pid, std::vector<pid_t>& out) {
  out.clear();
  const std::string path = "/proc/" + std::to_string(pid) + "/task";
  DIR* dir = opendir(path.c_str());
  if (!dir) return false;
  while (dirent* ent = readdir(dir)) {
    if (int tid = linuxproc::TaskId(ent->d_name)) out.push_back(tid);
  }
  closedir(dir);
  return true;
}

// Seizes one not-yet-traced thread and brings it to its first stop (the
// "safe point" every Attach round needs before arming anything). On
// failure, `gone` true means the thread exited in the race between listing
// it and attaching — a benign skip, not a reason to fail the whole attach.
bool SeizeAndStopThread(pid_t tid, std::string& err, bool& gone) {
  linuxptrace::SuppressStopSigchld();
  if (ptrace(PTRACE_SEIZE, tid, nullptr, (void*)(long)PTRACE_O_TRACECLONE) != 0) {
    err = ClassifySeizeError(tid, errno, gone);
    return false;
  }
  if (ptrace(PTRACE_INTERRUPT, tid, nullptr, nullptr) != 0) {
    int e = errno;
    ptrace(PTRACE_DETACH, tid, nullptr, nullptr);  // undo the seize; best effort
    gone = (e == ESRCH);
    err = gone ? ("thread " + std::to_string(tid) + " exited")
               : ("ptrace interrupt failed: " + std::string(strerror(e)));
    return false;
  }
  int status = 0;
  if (!WaitForTidStop(tid, status, gone)) {
    if (!gone) ptrace(PTRACE_DETACH, tid, nullptr, nullptr);
    err = gone ? ("thread " + std::to_string(tid) + " exited")
               : ("thread " + std::to_string(tid) + " did not stop within 2 s");
    return false;
  }
  return true;
}

// Rounds of "list /proc/<pid>/task, seize the threads we haven't seen yet"
// before giving up on a target that keeps spawning threads faster than this
// loop can attach to them. Same shape and bound as platform_linux_ptrace.cc's
// SuspendOnTracer (kMaxSuspendRounds) — a round that attaches nothing new
// proves every thread is now held.
constexpr int kMaxAttachRounds = 20;

}  // namespace

// The actual session state. A plain, fully-accessible struct so every free
// helper function below can take it by reference — DebugSession::State
// itself (platform.h's opaque forward declaration) is a PRIVATE nested
// type, so only DebugSession's own member functions may name it; this
// struct is what they hand down to everything else, via the public-base
// upcast DebugSession::State performs just below.
struct SessionData {
  pid_t pid = 0;
  bool attached = false;
  // Wait() synthesizes the very first event (Attached) itself, without
  // touching ptrace: Attach already brought every thread to a stop, so
  // there is nothing left to wait for — this just reports that fact once.
  bool reportedAttach = false;
  // The process is confirmed gone (its leader thread exited): Detach and
  // Continue both become no-ops once this is set, mirroring Win32's
  // "never continue the exit event, but Detach is still safe to call".
  bool processGone = false;

  // Every thread currently under this session's ptrace attachment.
  std::vector<pid_t> tids;
  // The subset of `tids` presently sitting in a ptrace stop (as opposed to
  // running free) — tracked explicitly because POKEUSER/PTRACE_CONT are
  // only valid on a stopped tracee, and because Continue needs to know
  // exactly which threads a given event left stopped.
  std::set<pid_t> stoppedTids;

  // A stop already collected via waitpid but not yet turned into a
  // WatchEvent and handed to the caller — Wait() reports one event at a
  // time (matching Win32's one-event-per-WaitForDebugEvent-call contract),
  // so anything extra a sweep turns up waits here for the next call.
  struct RawStop { pid_t tid; int status; };
  std::deque<RawStop> rawQueue;

  // The event Wait last returned that still needs Continue.
  bool pending = false;
  // True for Attached/ThreadCreated: Continue resumes every tid in
  // `stoppedTids`, not just pendingTid (platform.h's WatchEvent contract —
  // ptrace only naturally stops the thread that trapped, so this backend
  // must have explicitly stopped the rest itself to satisfy it, and must
  // resume all of them together afterward).
  bool pendingStopsAll = false;
  pid_t pendingTid = 0;
  // Re-injected on Continue for a signal that is not ours (Other events):
  // 0 means "ours, swallow it" (a watchpoint trap, already handled).
  int pendingSignal = 0;
};

// Per-backend state (platform.h declares this as an opaque forward
// declaration; every backend defines its own shape here). Adds nothing of
// its own — SessionData above holds every field — purely so a private
// nested type exists for platform.h's Pimpl (std::unique_ptr<State>) to
// name; DebugSession's member functions upcast it to SessionData& (a
// public base, so this needs no access of its own) before handing it to
// any of the free functions below.
struct DebugSession::State : SessionData {};

namespace {

bool IsTracked(const SessionData& s, pid_t tid) {
  return std::find(s.tids.begin(), s.tids.end(), tid) != s.tids.end();
}

void Untrack(SessionData& s, pid_t tid) {
  s.tids.erase(std::remove(s.tids.begin(), s.tids.end(), tid), s.tids.end());
  s.stoppedTids.erase(tid);
}

// Detaches every currently-tracked thread, clearing Dr7 first wherever the
// thread can be reached in a stop. Used both by Detach (the public,
// documented path) and by Attach's own cleanup when a round fails partway
// through — in the latter case nothing has been armed yet, so the Dr7
// clear is a no-op in practice, but going through one shared path keeps
// there from being two slightly different "let every thread go" sequences
// to maintain.
void DetachAll(SessionData& s) {
  for (pid_t tid : s.tids) {
    bool stopped = s.stoppedTids.count(tid) != 0;
    if (!stopped) {
      bool gone = false;
      stopped = InterruptRunningThread(tid, gone);
      // If this thread could not be stopped and is not even confirmed
      // gone, its Dr7 (if armed) cannot be cleared before we let go of it
      // — a real, narrow crash risk on its next write to the watched
      // address (the same hazard platform.h's Detach doc calls out for
      // callers that skip disarming). ptrace offers no safer fallback
      // here; detaching still proceeds so a stuck thread never hangs the
      // whole session.
    }
    if (stopped) ptrace(PTRACE_POKEUSER, tid, (void*)DebugRegOffset(7), (void*)0L);
    ptrace(PTRACE_DETACH, tid, nullptr, nullptr);
  }
  s.tids.clear();
  s.stoppedTids.clear();
}

// Ends whatever event is pending, resuming exactly the thread(s) it left
// stopped. `ev` is unused, like Win32's Continue: pid/tid/signal are kept in
// State, set when the event was produced, not re-derived from the caller's
// copy of it.
void ContinueOnTracer(SessionData& s, const WatchEvent&) {
  if (!s.pending) return;
  s.pending = false;
  if (s.pendingStopsAll) {
    for (pid_t tid : s.tids) {
      if (s.stoppedTids.count(tid)) {
        ptrace(PTRACE_CONT, tid, nullptr, nullptr);
        s.stoppedTids.erase(tid);
      }
    }
  } else if (s.stoppedTids.count(s.pendingTid)) {
    ptrace(PTRACE_CONT, s.pendingTid, nullptr, (void*)(long)s.pendingSignal);
    s.stoppedTids.erase(s.pendingTid);
  }
  s.pendingSignal = 0;
}

void DetachOnTracer(SessionData& s) {
  // Continue a still-outstanding event first (the exit event never reaches
  // here pending, since ProcessRawStop below never marks it pending) —
  // the same "never leave a stop nobody ended" rule Win32's Detach follows.
  ContinueOnTracer(s, WatchEvent{});
  DetachAll(s);
}

// Rescans /proc/<pid>/task for any tid not yet in `s.tids` and tries to pull
// each one into the tracked set with a plain PTRACE_INTERRUPT+wait — never
// PTRACE_SEIZE, since a tid this discovers is, by construction, one the
// kernel already auto-attached via PTRACE_O_TRACECLONE the moment it was
// cloned (re-seizing an already-traced tid would just fail "already traced
// by this process"). Used by HandleClone's GETEVENTMSG-failure path below,
// where the new tid can't be learned any other way: without this, that
// thread would stay kernel-attached and completely unknown to this
// SessionData, armed with nothing and never reached by DetachAll — a ptrace
// attachment leaked until the whole process exits. Bounded (one sweep); a
// tid that still can't be reached (interrupt fails, not because it's gone)
// stays untracked, the same narrow, already-documented residual DetachAll's
// own "can't stop in time" case accepts for a thread it is trying to
// RELEASE — here it's a thread never successfully picked up in the first
// place, but the shape of the risk (and the fact that there is no safer
// fallback ptrace offers) is the same.
void RecoverUntrackedClones(SessionData& s) {
  std::vector<pid_t> tids;
  if (!ReadTaskIds((uint32_t)s.pid, tids)) return;
  for (pid_t tid : tids) {
    if (IsTracked(s, tid)) continue;
    bool gone = false;
    if (InterruptRunningThread(tid, gone)) {
      s.tids.push_back(tid);
      s.stoppedTids.insert(tid);
    }
    // Else: exited before we could reach it (nothing to track), or genuinely
    // unreachable within the bounded wait (documented above) — either way
    // there is nothing further to do for this tid on this sweep.
  }
}

// Brings a freshly-cloned thread into the session and, to satisfy the
// ThreadCreated contract ("leave ALL threads stopped"), stops every other
// tracked thread that is not already stopped. `parentTid` is the thread
// whose PTRACE_EVENT_CLONE stop we are handling.
bool HandleClone(SessionData& s, pid_t parentTid, WatchEvent& out) {
  unsigned long msg = 0;
  if (ptrace(PTRACE_GETEVENTMSG, parentTid, nullptr, &msg) != 0) {
    // Could not learn the new tid from the clone event itself — the tracee
    // is definitely stopped at a clone-event stop when this runs, so this
    // should essentially never happen, but if it does the new thread is
    // STILL auto-attached by the kernel (PTRACE_O_TRACECLONE fired
    // regardless of whether we could read its eventmsg) and must not be
    // silently abandoned. Recover it the slow way: find it by re-listing
    // /proc/<pid>/task instead of losing track of it entirely.
    RecoverUntrackedClones(s);
    ptrace(PTRACE_CONT, parentTid, nullptr, nullptr);
    s.stoppedTids.erase(parentTid);
    return false;
  }
  pid_t child = (pid_t)msg;

  // The new thread auto-attached (PTRACE_O_TRACECLONE) and is already
  // sitting in its own initial stop, but the parent's clone-event report
  // and the child's own first-stop report can arrive in either order —
  // wait for it directly here instead of hoping a later sweep finds it.
  bool gone = false;
  int childStatus = 0;
  if (!WaitForTidStop(child, childStatus, gone) && !gone) {
    // Have the tid but could not confirm its stop within budget. It is
    // still kernel-attached regardless of that timeout, so track it
    // (unconfirmed — NOT in stoppedTids) rather than abandoning it: every
    // other call here already knows how to deal with a tracked tid that
    // isn't (yet) known to be stopped (interrupt it first), and the next
    // ordinary Wait() sweep will pick up whatever stop it eventually
    // reports through the ordinary waitpid loop, same as any other thread.
    s.tids.push_back(child);
    ptrace(PTRACE_CONT, parentTid, nullptr, nullptr);
    s.stoppedTids.erase(parentTid);
    return false;
  }
  if (!gone) {
    s.tids.push_back(child);
    s.stoppedTids.insert(child);
  }

  for (pid_t tid : s.tids) {
    if (s.stoppedTids.count(tid)) continue;
    bool g = false;
    if (InterruptRunningThread(tid, g)) s.stoppedTids.insert(tid);
    else if (g) Untrack(s, tid);
  }

  out = WatchEvent{};
  out.kind = DebugEventKind::ThreadCreated;
  out.tid = (uint32_t)child;
  s.pending = true;
  s.pendingStopsAll = true;
  s.pendingTid = child;
  return true;
}

// Decodes one already-collected waitpid status into a WatchEvent. Returns
// false for a status that is not worth surfacing to the caller (a secondary
// thread's ordinary exit, or a stop we caused ourselves via PTRACE_INTERRUPT
// racing this sweep) — the polling loop in WaitOnTracer keeps going in that
// case, within its own timeout budget.
bool ProcessRawStop(SessionData& s, const SessionData::RawStop& r, WatchEvent& out) {
  pid_t tid = r.tid;
  int st = r.status;

  if (WIFEXITED(st) || WIFSIGNALED(st)) {
    bool wasLeader = (tid == s.pid);
    Untrack(s, tid);
    if (wasLeader || s.tids.empty()) {
      s.processGone = true;
      out = WatchEvent{};
      out.detached = true;
      out.tid = (uint32_t)tid;
      return true;
    }
    return false;  // an ordinary secondary-thread exit: nothing to report
  }

  // WIFSTOPPED from here.
  int sig = WSTOPSIG(st);
  unsigned event = (unsigned)st >> 16;
  s.stoppedTids.insert(tid);

  if (event == PTRACE_EVENT_CLONE) return HandleClone(s, tid, out);

  if (event == PTRACE_EVENT_STOP) {
    // Our own PTRACE_INTERRUPT landed here instead of being consumed
    // synchronously by whichever helper sent it (InterruptRunningThread's
    // own WaitForTidStop call and this sweep both poll the same tid; one
    // of them wins the race). Nothing of ours to report — let it run.
    ptrace(PTRACE_CONT, tid, nullptr, nullptr);
    s.stoppedTids.erase(tid);
    return false;
  }

  if (sig == SIGTRAP && event == 0) {
    int slot = ReadHitSlotAndClear(tid);
    out = WatchEvent{};
    out.tid = (uint32_t)tid;
    if (slot >= 0) {
      out.kind = DebugEventKind::Hit;
      out.slot = slot;
      user_regs_struct regs{};
      out.hasRegs = linuxptrace::GetRegs(tid, regs);
      if (out.hasRegs) {
        linuxptrace::ToThreadRegisters(regs, out.regs);
        // A hardware data breakpoint is trap-style: rip is already past the
        // instruction that wrote (see write_watch.cc's own comment on this
        // same fact for Win32) — out.rip mirrors out.regs.rip for callers
        // that only look at the WatchEvent, not its embedded registers.
        out.rip = out.regs.rip;
      }
      s.pending = true;
      s.pendingStopsAll = false;
      s.pendingTid = tid;
      s.pendingSignal = 0;  // ours: swallow it
    } else {
      // A SIGTRAP with no Dr6 bit set: not one of our watchpoints (the
      // target's own int3, or similar) — hand it back unconsumed like any
      // other signal that is not ours.
      out.kind = DebugEventKind::Other;
      s.pending = true;
      s.pendingStopsAll = false;
      s.pendingTid = tid;
      s.pendingSignal = SIGTRAP;
    }
    return true;
  }

  // Any other real signal (SIGSEGV, SIGILL, an external SIGSTOP, ...):
  // not ours, passed straight back on Continue so the target's own
  // handler still sees it (the ptrace equivalent of Win32's
  // DBG_EXCEPTION_NOT_HANDLED).
  out = WatchEvent{};
  out.kind = DebugEventKind::Other;
  out.tid = (uint32_t)tid;
  s.pending = true;
  s.pendingStopsAll = false;
  s.pendingTid = tid;
  s.pendingSignal = sig;
  return true;
}

// Polls every tracked thread for a stop report in WNOHANG slices (never a
// blocking waitpid(-1): this session's threads are not the only ptrace
// attachment this process may hold — SuspendAll or another DebugSession
// could be watching threads of a different target at the same time, on the
// same shared tracer thread — and a -1 wait would be free to reap a stop
// meant for one of those instead). Between slices, RunPending lets any
// OTHER caller queued on the tracer thread run (tracer_thread.h's own
// stated reason RunPending exists: "a DebugSession waitpid loop polled in
// short slices, to keep serving other callers between slices") — without
// it, a long-running Wait(100, ...) call like write_watch.cc's DebugLoop
// makes would starve everything else on the tracer thread for its entire
// timeout, not just its own share of it.
bool WaitOnTracer(SessionData& s, uint32_t timeoutMs, WatchEvent& out) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  for (;;) {
    if (!s.rawQueue.empty()) {
      SessionData::RawStop r = s.rawQueue.front();
      s.rawQueue.pop_front();
      if (ProcessRawStop(s, r, out)) return true;
      continue;
    }
    bool any = false;
    std::vector<pid_t> snapshot = s.tids;  // HandleClone can grow s.tids mid-sweep
    for (pid_t tid : snapshot) {
      int st = 0;
      pid_t r = waitpid(tid, &st, __WALL | WNOHANG);
      if (r == tid) {
        s.rawQueue.push_back({tid, st});
        any = true;
      }
    }
    if (any) continue;
    linuxptrace::RunPending();
    if (std::chrono::steady_clock::now() >= deadline) return false;
    usleep(kWaitPollUs);  // 5 ms, per the brief
  }
}

// Fills `s` (already pid-stamped, otherwise default-constructed) in place.
// True on success; on failure `s` is left fully detached (DetachAll) and
// `error` says why.
bool AttachOnTracer(uint32_t pid, SessionData& s, std::string& error) {
  if ((pid_t)pid == (pid_t)getpid()) {
    error = "cannot attach to this process itself";
    return false;
  }

  std::vector<pid_t> tids;
  for (int round = 0; round < kMaxAttachRounds; ++round) {
    if (!ReadTaskIds(pid, tids)) {
      error = "process " + std::to_string(pid) + " not found";
      break;
    }
    bool addedAny = false;
    bool hardFailure = false;
    for (pid_t tid : tids) {
      if (IsTracked(s, tid)) continue;
      bool gone = false;
      if (!SeizeAndStopThread(tid, error, gone)) {
        if (gone) { error.clear(); continue; }  // raced with its own exit: skip it
        hardFailure = true;
        break;
      }
      s.tids.push_back(tid);
      s.stoppedTids.insert(tid);
      addedAny = true;
    }
    if (hardFailure) break;
    if (!addedAny) {
      if (s.tids.empty()) {
        error = "process " + std::to_string(pid) + " has no attachable threads";
        break;
      }
      s.attached = true;
      return true;
    }
    // A new thread may have appeared mid-round; list again.
  }
  if (error.empty())
    error = "process " + std::to_string(pid) + " kept creating threads; could not attach to them all";
  DetachAll(s);
  return false;
}

bool SetHwBreakpointOnTracer(SessionData& s, pid_t tid, int slot, uintptr_t address, size_t len, bool enable) {
  if (slot < 0 || slot > 3) return false;
  uint64_t lenBits = 0;
  if (enable) {
    switch (len) {
      case 1: lenBits = 0x0; break;
      case 2: lenBits = 0x1; break;
      case 4: lenBits = 0x3; break;
      case 8: lenBits = 0x2; break;
      default: return false;
    }
    if (address & (len - 1)) return false;  // misaligned: architecturally undefined
  }
  if (!IsTracked(s, tid)) return false;

  bool wasStopped = s.stoppedTids.count(tid) != 0;
  bool weStoppedIt = false;
  if (!wasStopped) {
    bool gone = false;
    if (!InterruptRunningThread(tid, gone)) {
      if (gone) Untrack(s, tid);
      return false;
    }
    weStoppedIt = true;
    s.stoppedTids.insert(tid);
  }

  long drValue = enable ? (long)address : 0L;
  bool ok = ptrace(PTRACE_POKEUSER, tid, (void*)DebugRegOffset(slot), (void*)drValue) == 0;
  if (ok) ok = WriteDr7(tid, slot, enable, lenBits);

  if (weStoppedIt) {
    // Leave the thread exactly as found: running.
    ptrace(PTRACE_CONT, tid, nullptr, nullptr);
    s.stoppedTids.erase(tid);
  }
  return ok;
}

// Forks a disposable, idle child process and tries to arm/disarm Dr0 on it,
// per the brief ("probes by arming and disarming Dr0 on one thread"). This
// is the only reliable way to answer "does this kernel/hypervisor actually
// expose hardware breakpoints" (nested virtualization can hide them even
// though ptrace itself works fine) without touching a real target.
bool ProbeHardwareWatchOnTracer() {
  pid_t child = fork();
  if (child < 0) return false;
  if (child == 0) {
    // Child: nothing to do but sit still until the probe kills it. No
    // further use of this process's C++ runtime state beyond this point
    // (standard fork-in-a-multithreaded-process hygiene) — just a bare
    // syscall loop.
    for (;;) pause();
  }

  bool ok = false;
  std::string err;
  bool gone = false;
  if (SeizeAndStopThread(child, err, gone)) {
    errno = 0;
    bool armed = ptrace(PTRACE_POKEUSER, child, (void*)DebugRegOffset(0), (void*)0x10L) == 0;
    if (armed) armed = WriteDr7(child, 0, /*enable=*/true, /*lenBits=*/0x0);
    // Disarm regardless of whether arming fully succeeded, then detach.
    ptrace(PTRACE_POKEUSER, child, (void*)DebugRegOffset(7), (void*)0L);
    ptrace(PTRACE_POKEUSER, child, (void*)DebugRegOffset(0), (void*)0L);
    ptrace(PTRACE_DETACH, child, nullptr, nullptr);
    ok = armed;
  }
  kill(child, SIGKILL);
  int status = 0;
  waitpid(child, &status, 0);  // reap; bounded by definition (SIGKILL above)
  return ok;
}

}  // namespace

// `APPRENTICE_FORCE_NO_DEBUGREGS=1` makes this report unsupported
// unconditionally, without ever touching ptrace — the deterministic path
// the "reports a clear error when debug registers are unavailable" test
// needs, since a CI kernel's actual hardware-breakpoint support cannot be
// controlled from the test itself (nested virtualization may or may not
// expose Dr0-Dr3 depending on the host, which this project does not
// control). Checked fresh on every call, never cached, so a test that sets
// it for one case does not affect any other.
bool SupportsHardwareWatch() {
  const char* forced = getenv("APPRENTICE_FORCE_NO_DEBUGREGS");
  if (forced && std::string(forced) == "1") return false;
  return linuxptrace::OnTracer([] { return ProbeHardwareWatchOnTracer(); });
}

DebugSession::DebugSession(std::unique_ptr<State> state) : state_(std::move(state)) {}

DebugSession::~DebugSession() { Detach(); }

std::unique_ptr<DebugSession> DebugSession::Attach(uint32_t pid, std::string& error) {
  auto state = std::make_unique<State>();
  state->pid = (pid_t)pid;
  std::string err;
  bool ok = linuxptrace::OnTracer([&] { return AttachOnTracer(pid, *state, err); });
  if (!ok) {
    error = err.empty() ? "ptrace tracer thread unavailable" : err;
    return nullptr;
  }
  return std::unique_ptr<DebugSession>(new DebugSession(std::move(state)));
}

bool DebugSession::SetHwBreakpoint(uint32_t tid, int slot, uintptr_t address, size_t len, bool enable) {
  State* s = state_.get();
  if (!s->attached || s->processGone) return false;
  return linuxptrace::OnTracer([&] {
    return SetHwBreakpointOnTracer(*s, (pid_t)tid, slot, address, len, enable);
  });
}

bool DebugSession::Wait(uint32_t timeoutMs, WatchEvent& out) {
  State* s = state_.get();
  if (!s->attached) return false;

  // First call after Attach: Attach already stopped every thread, so this
  // is a pure bookkeeping event, not a real wait.
  if (!s->reportedAttach) {
    s->reportedAttach = true;
    out = WatchEvent{};
    out.kind = DebugEventKind::Attached;
    out.tid = (uint32_t)s->pid;
    s->pending = true;
    s->pendingStopsAll = true;
    s->pendingTid = s->pid;
    return true;
  }
  if (s->processGone) return false;

  return linuxptrace::OnTracer([&] { return WaitOnTracer(*s, timeoutMs, out); });
}

void DebugSession::Continue(const WatchEvent& ev) {
  State* s = state_.get();
  if (!s->attached) return;
  linuxptrace::OnTracer([&] { ContinueOnTracer(*s, ev); });
}

void DebugSession::Detach() {
  State* s = state_.get();
  if (!s->attached) return;
  linuxptrace::OnTracer([&] { DetachOnTracer(*s); });
  s->attached = false;
}

}  // namespace platform
