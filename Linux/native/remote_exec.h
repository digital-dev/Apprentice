#pragma once
#include <cstdint>
#include <memory>

// The one real injection primitive on Linux: borrow one already-stopped
// thread of the target for a few instructions, then put it back exactly as
// found. No thread is ever created or destroyed in the target — unlike
// Windows' real CreateRemoteThread, which starts a disposable one — because
// a burst of real thread create/destroy cycles has been observed to crash a
// real game (see platform.h's SleepMs doc); this avoids that entirely, at
// the cost of briefly running on a thread the target itself still owns (see
// hijack_pick.h for how that risk is kept small, never eliminated).
//
// Both primitives below pick a thread the same way: one SuspendAll already
// holds stopped, if any (reused directly — ptrace allows only one tracer
// per tracee, so attaching again would fail "already traced" — and left
// stopped again afterward, never resumed, since SuspendAll's own ResumeAll
// still owns it); otherwise a thread this call stops itself for just its
// own duration. Either way the thread's full original register file is
// restored before it is given back, including orig_rax, so a syscall it
// was blocked in when picked restarts exactly as if none of this had
// happened (the kernel's syscall-restart check runs again, with the true
// original values, only once the thread is actually resumed with them).
// Everything here runs on the tracer thread (tracer_thread.h) internally —
// callers do not need their own OnTracer wrapper.
namespace linuxremote {

// Runs one syscall inside a thread of `pid`. Overwrites 3 bytes AT the
// chosen thread's current rip with `syscall; int3` (0F 05 CC — rip is
// executable by definition, so this needs no scratch memory of its own,
// which matters for the very first call: AllocateNear's own mmap has
// nowhere else to run before any cave exists), loads `nr`/`args` into
// rax/rdi/rsi/rdx/r10/r8/r9, resumes, waits (bounded) for the trap, reads
// rax, restores the 3 original bytes and every register.
//
// Callers must only ever pass a syscall number that cannot block (this
// project uses it for mmap/munmap only): on the rare defensive timeout —
// ptrace trouble, not a slow syscall — the thread is restored immediately
// rather than left pending, unlike Hijack below, which must assume its
// caller-supplied code might run for a while.
//
// False only when no thread could be stopped or the trap never arrived
// (process gone, every thread looked unusable, or the bounded wait expired);
// `result` holds the syscall's raw return value (negative = -errno in
// twos-complement) whenever true comes back.
bool RemoteSyscall(uint32_t pid, long nr, const uint64_t args[6], uint64_t& result);

// A thread of `pid` running caller-supplied code, from Start until
// Wait/Finish (or destruction) give it back. Opaque; `platform::
// CreateRemoteThread`'s ThreadHandle is one of these, cast.
class Hijack {
 public:
  // Picks a thread, saves its registers, points it at `startAddress` with
  // `param` in both rcx and rdi (so either calling convention's first
  // argument sees it) and a stack built the same way a real `call` would
  // leave it (16-aligned at entry, `trampoline` pushed as the return
  // address — so the caller's own stub ending in a plain `ret` lands
  // there), and resumes it. Null on failure (no thread available, or the
  // target is gone); `trampoline` must already hold one 0xCC byte.
  static std::unique_ptr<Hijack> Start(uint32_t pid, uintptr_t startAddress, uintptr_t param,
                                        uintptr_t trampoline);

  // Waits up to timeoutMs for the trampoline's trap (or any other signal
  // the hijacked thread takes, which aborts the run — see the class
  // comment above on why a failed run still must not leave the thread's
  // registers as the stub left them). False on timeout; the trap is still
  // being waited for internally and a later Wait/Finish call picks up
  // where this one left off. True means resolved either way: check no
  // further state — there is none to check — this call and Finish are all
  // a caller needs.
  bool Wait(uint32_t timeoutMs);

  // Restores the thread (registers, and — for a thread this Hijack
  // attached itself rather than borrowed — detaches it) once its trap has
  // been seen, waiting a little longer first if Wait never got there.
  // Never touches the thread's registers while the run might still be in
  // progress: a Hijack whose code truly never finishes is deliberately
  // left pending rather than forced closed, the same "never free a live
  // cave" trade-off AllocateNear's own callers already make. Idempotent;
  // also run by the destructor, so calling it is optional but recommended
  // (it is where the restore actually happens, and not calling it delays
  // that until the object goes out of scope, or forever if it is leaked).
  void Finish();

  ~Hijack();
  Hijack(const Hijack&) = delete;
  Hijack& operator=(const Hijack&) = delete;

 private:
  struct Impl;
  explicit Hijack(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};

// Called before ResumeAll actually releases `pid`'s threads: waits
// (bounded by boundedMs) for any Hijack still borrowing one of them to
// resolve, so ResumeAll never resumes a thread whose registers are still
// the hijacked ones. A print to stderr, not a crash, if the bound is hit —
// see Hijack::Finish's own comment on why that thread is left as-is rather
// than forced.
void FinishPendingFor(uint32_t pid, uint32_t boundedMs);

}  // namespace linuxremote
