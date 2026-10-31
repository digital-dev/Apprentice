#pragma once
// ptrace primitives for the Linux backend: stop one thread, read/write its
// registers, release it. Everything here must run on the tracer thread
// (tracer_thread.h); a StopGuard built anywhere else refuses.
//
// Attaching uses PTRACE_SEIZE + PTRACE_INTERRUPT, never PTRACE_ATTACH (no
// SIGSTOP is sent, so a target that is not ours to stop never sees a stray
// stop signal) and never PTRACE_O_EXITKILL (a target outlives its tracer: if
// this process dies, the kernel detaches and the target runs on).
//
// Every wait is bounded (waitpid WNOHANG polling): a thread that will not stop
// fails the operation instead of hanging the caller.
#include "platform.h"

#include <sys/types.h>
#include <sys/user.h>

#include <cstddef>
#include <string>

namespace linuxptrace {

// The error text for an attach the kernel refused for lack of privilege (Yama
// ptrace_scope, a different uid, a non-dumpable target). Stable: the UI keys on it.
extern const char kPtraceDeniedMessage[];

// True when `err` is kPtraceDeniedMessage.
bool PtraceDenied(const std::string& err);

// Holds one thread stopped for the guard's lifetime: attaches and interrupts it,
// waits (bounded) for the stop, and detaches in the destructor on every path,
// re-delivering a signal the stop intercepted. On failure ok() is false and
// `err` says why: kPtraceDeniedMessage, "already traced", "exited", a timeout.
class StopGuard {
 public:
  StopGuard(pid_t tid, std::string& err);
  ~StopGuard();
  StopGuard(const StopGuard&) = delete;
  StopGuard& operator=(const StopGuard&) = delete;

  bool ok() const { return ok_; }
  // The thread exited (or never existed) before it could be stopped: a benign
  // race when walking a live thread list, not a failure of the whole operation.
  bool gone() const { return gone_; }
  pid_t tid() const { return tid_; }

 private:
  pid_t tid_;
  bool attached_ = false;
  bool ok_ = false;
  bool gone_ = false;
  int pendingSignal_ = 0;  // intercepted by the stop; delivered on detach
};

// PTRACE_GETREGS / PTRACE_SETREGS on a thread this tracer holds stopped.
bool GetRegs(pid_t tid, user_regs_struct& out);
bool SetRegs(pid_t tid, const user_regs_struct& regs);

// The platform register file from a ptrace one.
void ToThreadRegisters(const user_regs_struct& in, platform::ThreadRegisters& out);

// Threads whose detach could not finish (still running after a stop timed out,
// or exited but not yet reapable) are kept and retried here; every operation
// retries them first. Tracer thread only.
void RetryDeferredDetaches();
size_t DeferredDetachCount();

// Test seam: called on the tracer thread after each successful stop.
using StopObserver = void (*)(pid_t tid);
void SetStopObserverForTest(StopObserver observer);

}  // namespace linuxptrace
