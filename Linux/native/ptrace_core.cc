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
std::vector<pid_t> g_deferred;  // tracer thread only

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

// One attempt to end tracing `tid`. True when nothing of it is left to this tracer: detached,
// exited and released, or not ours at all.
bool TryDetach(pid_t tid, int signal) {
  if (ptrace(PTRACE_DETACH, tid, nullptr, (void*)(long)signal) == 0) return true;
  // ESRCH: running (a stop that never came), exited, or not traced by us.
  siginfo_t info{};
  if (waitid(P_PID, (id_t)tid, &info, WEXITED | WSTOPPED | WNOHANG | __WALL | WNOWAIT) != 0)
    return errno == ECHILD;
  if (info.si_pid == 0) {
    // Nothing to report: still running, or a zombie leader waiting for its other threads.
    if (!Gone(ThreadState(tid))) ptrace(PTRACE_INTERRUPT, tid, nullptr, nullptr);
    return false;
  }
  if (info.si_code == CLD_TRAPPED || info.si_code == CLD_STOPPED) {
    int st;
    waitpid(tid, &st, __WALL | WNOHANG);
    return ptrace(PTRACE_DETACH, tid, nullptr, (void*)(long)signal) == 0;
  }
  // Exited. A traced thread that exits waits for its tracer to reap it; until then its
  // process cannot finish exiting.
  if (!IsOurChildLeader(tid)) {
    int st;
    waitpid(tid, &st, __WALL | WNOHANG);
  }
  return true;
}

void Detach(pid_t tid, int signal) {
  const auto deadline = Clock::now() + kDetachTimeout;
  while (!TryDetach(tid, signal)) {
    if (Clock::now() >= deadline) {
      if (std::find(g_deferred.begin(), g_deferred.end(), tid) == g_deferred.end()) g_deferred.push_back(tid);
      return;
    }
    usleep(kPollUs);
  }
}

// Every ptrace stop of a tracee sends this process a SIGCHLD. When the target is also a child
// of this process (a game the app launched; the test harness), libuv answers that SIGCHLD with
// waitpid(child, WNOHANG), which then CONSUMES the leader thread's stop report (tracer and real
// parent are one thread group, so the kernel shows ptrace stops to both) and reports the child
// as exited: Node fires 'exit' and closes its stdio while it still runs. Seen in tests.
// SA_NOCLDSTOP on the installed handler stops the kernel from sending SIGCHLD for stops; libuv
// only acts on exits, so its behaviour is otherwise unchanged. Reapplied before every attach
// because libuv reinstalls its handler (without the flag) when it re-registers. With no handler
// installed (SIG_DFL/SIG_IGN) nothing reacts to the signal and the disposition is left alone.
void SuppressStopSigchld() {
  struct sigaction sa;
  if (sigaction(SIGCHLD, nullptr, &sa) != 0) return;
  if ((sa.sa_flags & SA_SIGINFO) == 0 && (sa.sa_handler == SIG_DFL || sa.sa_handler == SIG_IGN)) return;
  if (sa.sa_flags & SA_NOCLDSTOP) return;
  sa.sa_flags |= SA_NOCLDSTOP;
  sigaction(SIGCHLD, &sa, nullptr);
}

}  // namespace

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
  SuppressStopSigchld();
  if (ptrace(PTRACE_SEIZE, tid, nullptr, nullptr) != 0) {
    err = AttachError(tid, errno, gone_);
    return;
  }
  attached_ = true;
  if (ptrace(PTRACE_INTERRUPT, tid, nullptr, nullptr) != 0) {
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
  if (attached_) Detach(tid_, pendingSignal_);
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
  g_deferred.erase(std::remove_if(g_deferred.begin(), g_deferred.end(), [](pid_t t) { return TryDetach(t, 0); }),
                   g_deferred.end());
}

size_t DeferredDetachCount() { return g_deferred.size(); }

void SetStopObserverForTest(StopObserver observer) { g_observer = observer; }

}  // namespace linuxptrace
