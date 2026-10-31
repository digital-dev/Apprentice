#pragma once
#include <vector>
#include <sys/types.h>

// Lets other Linux backend code (remote_exec.cc) ask whether SuspendAll is
// currently holding a given process's threads stopped, so a remote call can
// reuse one of them directly instead of attaching a second tracer to it
// (which the kernel refuses: a tracee has only one tracer) — and so it knows
// to leave that thread stopped afterward rather than resuming it itself,
// since SuspendAll's own ResumeAll still owns it. Tracer thread only.
// Implemented in platform_linux_ptrace.cc, which owns the held set.
namespace platform_linux {

// Every tid SuspendAll currently holds stopped for `pid`, or empty when
// nothing is suspended (including when a different pid is held — the held
// set is one process at a time, like SuspendAll itself).
std::vector<pid_t> HeldThreadIds(uint32_t pid);

}  // namespace platform_linux
