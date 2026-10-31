#include "platform.h"

// Linux backend: most of it real now, the rest declared but not yet
// implemented. `IsSupported()` stays false until the whole chain this flag
// gates (including Mono/IL2CPP remote calls, Task 13-14, and the hardware
// write-watch, Task 15) is real — flipping it early would tell the app
// features work that do not yet.
//
//   ReadMemory/WriteMemory, QueryRegion, ListModules, ResolveExport,
//   PlatformAbiFor            platform_linux_memory.cc / platform_linux_remote.cc
//   SuspendAll/ResumeAll, ListThreads, GetThreadRegisters
//                             platform_linux_ptrace.cc (PTRACE_SEIZE per
//                             thread in /proc/<pid>/task, on the tracer thread)
//   AllocateNear/FreeMemory/CreateRemoteThread/WaitForRemoteThread/
//   CloseRemoteThread         platform_linux_remote.cc, on remote_exec.h's
//                             thread-hijack primitive (no VirtualAllocEx or
//                             CreateRemoteThread equivalent exists on Linux;
//                             a stopped thread of the target runs the mmap/
//                             munmap syscall or the caller's own code for a
//                             few instructions, then is restored exactly as
//                             found — see remote_exec.h)
namespace platform {

bool IsSupported() { return false; }
const char* Name() { return "linux"; }

// ListProcesses, OpenProcess, CloseProcess, IsAlive and MainModuleBase live in
// platform_linux_process.cc; ReadMemory, QueryRegion, PageSize, ListModules,
// ListModuleRanges and ResolveExport in platform_linux_memory.cc; AllocateNear,
// FreeMemory, CreateRemoteThread, WaitForRemoteThread, CloseRemoteThread and
// PlatformAbiFor in platform_linux_remote.cc; SuspendAll, ResumeAll,
// SuspendAllError, SleepMs, ListThreads and GetThreadRegisters in
// platform_linux_ptrace.cc.

// Stub. The ptrace backend, all on the one tracer thread:
//   Attach          seize every thread in /proc/<pid>/task with
//                   PTRACE_O_TRACECLONE; report Attached once ALL are stopped.
//   ThreadCreated   PTRACE_EVENT_CLONE (debug registers are not inherited by
//                   the new thread); stop ALL threads before reporting it.
//   Hit             SIGTRAP whose Dr6 names the slot; the reporting thread
//                   stays stopped.
//   SetHwBreakpoint PTRACE_POKEUSER on u_debugreg. Callable on a running
//                   thread too (the disarm after the loop): if the thread is
//                   not stopped, PTRACE_INTERRUPT and wait for it, poke, then
//                   resume it — POKEUSER on a running tracee fails with ESRCH.
//   Continue        resume the stop ev.tid names (and any threads the backend
//                   stopped for it), re-injecting a non-ours signal.
//   Detach          drain, then PTRACE_DETACH every thread; disarms nothing.
bool SupportsHardwareWatch() { return false; }

struct DebugSession::State {};
DebugSession::DebugSession(std::unique_ptr<State> state) : state_(std::move(state)) {}
DebugSession::~DebugSession() { Detach(); }
std::unique_ptr<DebugSession> DebugSession::Attach(uint32_t, std::string& error) {
  error = "not supported on this platform yet";
  return nullptr;
}
bool DebugSession::SetHwBreakpoint(uint32_t, int, uintptr_t, size_t, bool) { return false; }
bool DebugSession::Wait(uint32_t, WatchEvent&) { return false; }
void DebugSession::Continue(const WatchEvent&) {}
void DebugSession::Detach() {}

} // namespace platform
