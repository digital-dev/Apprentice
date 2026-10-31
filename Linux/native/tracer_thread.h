#pragma once
// The one thread that makes every ptrace call of this process.
//
// ptrace requests are only valid from the thread that attached, and the addon is
// called from whichever Node/libuv thread happens to run (the main thread, worker
// threads, AsyncWorker pool threads). So a SuspendAll on one call and the ResumeAll
// on the next can arrive on different threads. Everything ptrace therefore runs
// here: a lazily started thread with a task queue. Callers block until their
// task has run and get its result back.
//
// Lifetime: started on first use (never from a static initializer). At process
// exit (atexit, or dlclose of the addon) the thread drains its queue, runs the
// AtTracerExit hooks (which detach every held tracee, so no target is left
// stopped) and is joined. In a forked child the tracer is unavailable: the child
// has no tracer thread and the parent's tracees are not its own.
#include <functional>
#include <type_traits>

namespace linuxptrace {

// True on the tracer thread.
bool OnTracerThread();

// Runs `task` on the tracer thread and waits for it to finish. Called on the
// tracer thread itself it runs inline (no deadlock). An exception thrown by the
// task is swallowed on the tracer thread. False when the tracer is unavailable
// (shut down, forked child, or the thread could not be started); the task did
// not run then.
bool RunOnTracer(const std::function<void()>& task);

// RunOnTracer with a result: the task's return value, or a value-initialized R
// (false, 0, empty) when the task threw or the tracer is unavailable.
template <class F>
auto OnTracer(F f) -> decltype(f()) {
  using R = decltype(f());
  if constexpr (std::is_void_v<R>) {
    RunOnTracer([&] { f(); });
  } else {
    R result{};
    RunOnTracer([&] { result = f(); });
    return result;
  }
}

// Tracer thread only: runs every task queued so far. For long-running tracer
// work (a DebugSession waitpid loop polled in short slices) to keep serving
// other callers between slices.
void RunPending();

// Background work for the tracer thread itself. After each batch of tasks, and
// every kIdleTickMs while the last call returned true, the idle thread calls
// `tick`; it returns whether it wants to be called again soon. Returning false
// puts the thread back to sleeping until the next task. One tick at a time; a
// later call replaces it. Tracer thread only.
constexpr int kIdleTickMs = 5;
void SetIdleTick(bool (*tick)());

// Registers `hook` to run on the tracer thread just before it exits.
void AtTracerExit(std::function<void()> hook);

// Stops the tracer thread now: queued tasks finish, exit hooks run, the thread
// is joined, and later RunOnTracer calls return false. Idempotent. Also run at
// process exit.
void ShutdownTracer();

}  // namespace linuxptrace
