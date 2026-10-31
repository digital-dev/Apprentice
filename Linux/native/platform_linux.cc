#include "platform.h"

// Linux backend: most of it real now, the rest declared but not yet
// implemented. `IsSupported()` stays false until the whole chain this flag
// gates (including Mono/IL2CPP remote calls, Task 13-14) is real — flipping
// it early would tell the app features work that do not yet. The hardware
// write-watch (Task 15) is real as of platform_linux_debug.cc, but it alone
// does not move this flag: ipc.ts's platformSupportsInjection reads it for
// the whole injection chain, not write-watch specifically.
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
//   SupportsHardwareWatch, DebugSession (Attach/SetHwBreakpoint/Wait/
//   Continue/Detach)          platform_linux_debug.cc — the ptrace hardware
//                             write-watch backend, also on the tracer thread.
namespace platform {

bool IsSupported() { return false; }
const char* Name() { return "linux"; }

// ListProcesses, OpenProcess, CloseProcess, IsAlive and MainModuleBase live in
// platform_linux_process.cc; ReadMemory, QueryRegion, PageSize, ListModules,
// ListModuleRanges and ResolveExport in platform_linux_memory.cc; AllocateNear,
// FreeMemory, CreateRemoteThread, WaitForRemoteThread, CloseRemoteThread and
// PlatformAbiFor in platform_linux_remote.cc; SuspendAll, ResumeAll,
// SuspendAllError, SleepMs, ListThreads and GetThreadRegisters in
// platform_linux_ptrace.cc; SupportsHardwareWatch and DebugSession in
// platform_linux_debug.cc.

} // namespace platform
