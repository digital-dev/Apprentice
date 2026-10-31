#include "platform.h"

// Linux backend: declared, not implemented. A Linux build of the addon
// compiles and loads, and every injection operation refuses with
// IsSupported() == false, so the app can say "not on this platform yet"
// instead of appearing to work.
//
// Implementing this needs a Linux machine to test on; writing it blind
// would produce code indistinguishable from working code until someone ran
// it. Rough shape when someone does:
//   ReadMemory/WriteMemory  process_vm_readv/writev, or /proc/<pid>/mem,
//                           which can write pages that are not writable
//   QueryRegion             parse /proc/<pid>/maps
//   SuspendAll/ResumeAll    ptrace(PTRACE_ATTACH) per thread in
//                           /proc/<pid>/task, or SIGSTOP the group
//   AllocateNear            the hard one. Linux has no VirtualAllocEx:
//                           hijack a thread, save its registers, point them
//                           at mmap with MAP_FIXED_NOREPLACE near the
//                           target, single-step it, restore the registers.
namespace platform {

bool IsSupported() { return false; }
const char* Name() { return "linux"; }

// ListProcesses, OpenProcess, CloseProcess, IsAlive and MainModuleBase live in
// platform_linux_process.cc; ReadMemory, QueryRegion, PageSize, ListModules,
// ListModuleRanges and ResolveExport in platform_linux_memory.cc.
// Stub; a later task replaces this with a real ABI probe.
Abi PlatformAbiFor(ProcessHandle, uintptr_t) { return Abi::SysV; }

uintptr_t AllocateNear(ProcessHandle, uintptr_t, size_t) { return 0; }
bool FreeMemory(ProcessHandle, uintptr_t) { return false; }
bool SuspendAll(ProcessHandle, uint32_t) { return false; }
void ResumeAll() {}
void SleepMs(uint32_t) {}
ThreadHandle CreateRemoteThread(ProcessHandle, uintptr_t, uintptr_t) { return 0; }
bool WaitForRemoteThread(ThreadHandle, uint32_t) { return false; }
void CloseRemoteThread(ThreadHandle) {}
bool ListThreads(uint32_t, std::vector<ThreadInfo>& out) {
  out.clear();
  return false;
}
bool GetThreadRegisters(uint32_t, ThreadRegisters&) { return false; }

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
