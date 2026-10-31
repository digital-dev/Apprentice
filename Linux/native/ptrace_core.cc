#include "ptrace_core.h"
#include "proc_parse.h"
#include "tracer_thread.h"

#include <signal.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fstream>
#include <sstream>
#include <vector>

namespace linuxptrace {

const char kPtraceDeniedMessage[] =
    "ptrace denied: run with CAP_SYS_PTRACE or set /proc/sys/kernel/yama/ptrace_scope to 0";

bool PtraceDenied(const std::string& err) { return err == kPtraceDeniedMessage; }

namespace {

using Clock = std::chrono::steady_clock;

// How long a thread gets to reach its stop after PTRACE_INTERRUPT.
constexpr auto kStopTimeout = std::chrono::milliseconds(2000);
// How long a detach waits for a thread that is not (yet) stopped or reapable before deferring it.
constexpr auto kDetachTimeout = std::chrono::milliseconds(200);
// A thread seen in a ptrace stop ('t') for this long without its stop being reported to us
// counts as stopped: another waiter in this process consumed the report (libuv's waitpid on
// its own child process, when the target is one).
constexpr auto kUnreportedStopGrace = std::chrono::milliseconds(100);
constexpr useconds_t kPollUs = 500;

StopObserver g_observer = nullptr;

std::string StillDetaching(pid_t tid) { return "thread " + std::to_string(tid) + " still detaching"; }

std::string ReadProc(pid_t tid, const char* leaf) {
  std::ifstream f("/proc/" + std::to_string(tid) + "/" + leaf);
  if (!f) return std::string();
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

// Scheduler state letter; 0 when the thread is gone.
char ThreadState(pid_t tid) { return linuxproc::StatState(ReadProc(tid, "stat")); }

bool Gone(char state) { return state == 0 || state == 'Z' || state == 'X'; }

std::string Exited(pid_t tid) { return "thread " + std::to_string(tid) + " exited"; }

// Why PTRACE_SEIZE failed. The kernel says EPERM for "not allowed", "already traced" and
// "already exiting" alike, so /proc tells them apart.
std::string AttachError(pid_t tid, int e, bool& gone) {
  if (e == ESRCH || (e == EPERM && Gone(ThreadState(tid)))) {
    gone = true;
    return Exited(tid);
  }
  if (e == EPERM) {
    long tracer = linuxproc::StatusField(ReadProc(tid, "status"), "TracerPid");
    if (tracer == getpid()) return StillDetaching(tid);  // ours, never "a debugger"
    if (tracer > 0)
      return "thread " + std::to_string(tid) + " is already traced by process " + std::to_string(tracer) +
             " (a debugger?)";
    return kPtraceDeniedMessage;
  }
  return "ptrace attach to thread " + std::to_string(tid) + " failed: " + strerror(e);
}

enum class StopResult { Stopped, Reaped, Dying, Timeout };

// Waits (bounded) for `tid`'s stop report. A signal-delivery stop counts too: the thread is
// stopped all the same, and `signal` is set so the detach re-delivers it.
StopResult WaitForStop(pid_t tid, int& signal) {
  const auto deadline = Clock::now() + kStopTimeout;
  Clock::time_point tracedSince{};
  for (;;) {
    int st = 0;
    pid_t r = waitpid(tid, &st, __WALL | WNOHANG);
    if (r == tid) {
      if (WIFEXITED(st) || WIFSIGNALED(st)) return StopResult::Reaped;
      if (WIFSTOPPED(st)) {
        if ((st >> 16) == 0) signal = WSTOPSIG(st);
        return StopResult::Stopped;
      }
      continue;
    }
    if (r < 0 && errno == EINTR) continue;
    if (r < 0) return StopResult::Reaped;  // ECHILD: no longer ours
    char state = ThreadState(tid);
    if (Gone(state)) return StopResult::Dying;
    if (state == 't') {
      if (tracedSince == Clock::time_point{}) tracedSince = Clock::now();
      else if (Clock::now() - tracedSince >= kUnreportedStopGrace) return StopResult::Stopped;
    } else {
      tracedSince = {};
    }
    if (Clock::now() >= deadline) return StopResult::Timeout;
    usleep(kPollUs);
  }
}

// A thread-group leader whose real parent is this process: when it exits, its exit status
// belongs to that parent (Node's child_process, a test's waitpid), so it is never reaped here.
bool IsOurChildLeader(pid_t tid) {
  std::string st = ReadProc(tid, "status");
  return linuxproc::StatusField(st, "Tgid") == tid && linuxproc::StatusField(st, "PPid") == getpid();
}

// A tracee being let go: the signal to hand back with PTRACE_DETACH, and whether a
// PTRACE_INTERRUPT is already pending for it (one is enough: a second would re-arm a stop
// after the first was consumed and leave the thread frozen with nobody to detach it).
struct Detaching {
  pid_t tid;
  int signal;
  bool interrupted;
};

// Detaches that could not finish yet; retried by the tracer thread every kIdleTickMs.
std::vector<Detaching> g_deferred;  // tracer thread only

// One attempt to end tracing `d.tid`. True when nothing of it is left to this tracer: detached,
// exited and released, or not ours at all.
bool TryDetach(Detaching& d) {
  // Look first: a stop not yet collected must be collected before detaching. PTRACE_DETACH
  // succeeds on any stopped tracee and would silently drop the signal of an uncollected
  // signal-delivery stop.
  siginfo_t info{};
  if (waitid(P_PID, (id_t)d.tid, &info, WEXITED | WSTOPPED | WNOHANG | __WALL | WNOWAIT) != 0)
    return errno == ECHILD;  // not (or no longer) ours
  if (info.si_pid == 0) {
    // Nothing to collect: stopped in a stop we already collected (the guard's own), still
    // running (blocked where no stop can reach it), or a zombie leader waiting for its threads.
    if (ptrace(PTRACE_DETACH, d.tid, nullptr, (void*)(long)d.signal) == 0) return true;
    // Make sure exactly one stop is on its way; never a second.
    if (!d.interrupted && !Gone(ThreadState(d.tid)) && ptrace(PTRACE_INTERRUPT, d.tid, nullptr, nullptr) == 0)
      d.interrupted = true;
    return false;
  }
  if (info.si_code == CLD_TRAPPED || info.si_code == CLD_STOPPED) {
    int st = 0;
    // A signal-delivery stop holds the target's own signal (a SIGSEGV its runtime handles, a GC
    // suspend signal): it goes back with the detach. A trap/event stop keeps what we carry.
    if (waitpid(d.tid, &st, __WALL | WNOHANG) == d.tid && WIFSTOPPED(st) && (st >> 16) == 0)
      d.signal = WSTOPSIG(st);
    return ptrace(PTRACE_DETACH, d.tid, nullptr, (void*)(long)d.signal) == 0;
  }
  // Exited. A traced thread that exits waits for its tracer to reap it; until then its
  // process cannot finish exiting.
  if (!IsOurChildLeader(d.tid)) {
    int st;
    waitpid(d.tid, &st, __WALL | WNOHANG);
  }
  return true;
}

bool IdleRetry() {
  RetryDeferredDetaches();
  return !g_deferred.empty();
}

void Detach(pid_t tid, int signal, bool interrupted) {
  Detaching d{tid, signal, interrupted};
  const auto deadline = Clock::now() + kDetachTimeout;
  while (!TryDetach(d)) {
    if (Clock::now() >= deadline) {
      if (!DetachPending(tid)) g_deferred.push_back(d);
      SetIdleTick(IdleRetry);  // the tracer thread keeps retrying on its own until it is done
      return;
    }
    usleep(kPollUs);
  }
}

}  // namespace

// Every ptrace stop of a tracee sends this process a SIGCHLD. When the target is also a child
// of this process (a game the app launched; the test harness), libuv answers that SIGCHLD with
// waitpid(child, WNOHANG), which then CONSUMES the leader thread's stop report (tracer and real
// parent are one thread group, so the kernel shows ptrace stops to both) and reports the child
// as exited: Node fires 'exit' and closes its stdio while it still runs. Seen in tests.
// SA_NOCLDSTOP on the installed handler stops the kernel from sending SIGCHLD for stops; libuv
// only acts on exits, so its behaviour is otherwise unchanged. Reapplied before every attach
// because libuv reinstalls its handler (without the flag) when it re-registers. With no handler
// installed (SIG_DFL/SIG_IGN) nothing reacts to the signal and the disposition is left alone.
// Exported (ptrace_core.h): DebugSession::Attach (platform_linux_debug.cc) seizes threads
// directly, without going through StopGuard, so it needs to apply this itself too.
void SuppressStopSigchld() {
  struct sigaction sa;
  if (sigaction(SIGCHLD, nullptr, &sa) != 0) return;
  if ((sa.sa_flags & SA_SIGINFO) == 0 && (sa.sa_handler == SIG_DFL || sa.sa_handler == SIG_IGN)) return;
  if (sa.sa_flags & SA_NOCLDSTOP) return;
  sa.sa_flags |= SA_NOCLDSTOP;
  sigaction(SIGCHLD, &sa, nullptr);
}

StopGuard::StopGuard(pid_t tid, std::string& err) : tid_(tid) {
  if (!OnTracerThread()) {
    err = "internal error: ptrace used off the tracer thread";
    return;
  }
  if (tid <= 0) {
    gone_ = true;
    err = Exited(tid);
    return;
  }
  if (DetachPending(tid)) {
    err = StillDetaching(tid);
    return;
  }
  SuppressStopSigchld();
  if (ptrace(PTRACE_SEIZE, tid, nullptr, nullptr) != 0) {
    err = AttachError(tid, errno, gone_);
    return;
  }
  attached_ = true;
  interrupted_ = ptrace(PTRACE_INTERRUPT, tid, nullptr, nullptr) == 0;
  if (!interrupted_) {
    gone_ = errno == ESRCH;
    err = gone_ ? Exited(tid) : std::string("ptrace interrupt failed: ") + strerror(errno);
    return;
  }
  switch (WaitForStop(tid, pendingSignal_)) {
    case StopResult::Stopped:
      ok_ = true;
      if (g_observer) g_observer(tid);
      return;
    case StopResult::Reaped:
      attached_ = false;
      gone_ = true;
      err = Exited(tid);
      return;
    case StopResult::Dying:
      gone_ = true;
      err = Exited(tid);
      return;
    case StopResult::Timeout:
      err = "thread " + std::to_string(tid) + " did not stop within 2 s";
      return;
  }
}

StopGuard::~StopGuard() {
  if (attached_) Detach(tid_, pendingSignal_, interrupted_);
}

bool GetRegs(pid_t tid, user_regs_struct& out) {
  return ptrace(PTRACE_GETREGS, tid, nullptr, &out) == 0;
}

bool SetRegs(pid_t tid, const user_regs_struct& regs) {
  return ptrace(PTRACE_SETREGS, tid, nullptr, &regs) == 0;
}

void ToThreadRegisters(const user_regs_struct& in, platform::ThreadRegisters& out) {
  out.rax = in.rax; out.rbx = in.rbx; out.rcx = in.rcx; out.rdx = in.rdx;
  out.rsi = in.rsi; out.rdi = in.rdi; out.rbp = in.rbp; out.rsp = in.rsp; out.rip = in.rip;
  out.r8 = in.r8; out.r9 = in.r9; out.r10 = in.r10; out.r11 = in.r11;
  out.r12 = in.r12; out.r13 = in.r13; out.r14 = in.r14; out.r15 = in.r15;
  out.rflags = in.eflags;
}

void RetryDeferredDetaches() {
  g_deferred.erase(std::remove_if(g_deferred.begin(), g_deferred.end(), [](Detaching& d) { return TryDetach(d); }),
                   g_deferred.end());
}

bool DetachPending(pid_t tid) {
  return std::any_of(g_deferred.begin(), g_deferred.end(), [&](const Detaching& d) { return d.tid == tid; });
}

size_t DeferredDetachCount() { return g_deferred.size(); }

void SetStopObserverForTest(StopObserver observer) { g_observer = observer; }

}  // namespace linuxptrace
