#pragma once
#include <cstdint>
#include <cstddef>
#include <cstring>
#ifndef _WIN32
#include <strings.h>
#endif
#include <memory>
#include <string>
#include <vector>

// The OS operations code injection needs, and nothing else. Windows is the
// platform that works today; the Linux backend is a stub that refuses
// cleanly, so a Linux build compiles and loads rather than pretending.
//
// Callers are being moved onto this layer file by file (the linux-port
// plan); write-watch goes through DebugSession and no longer calls Win32.
namespace platform {

// Case-insensitive name compare (module names); _stricmp on Windows, strcasecmp elsewhere.
inline bool EqualsIgnoreCase(const std::string& a, const std::string& b) {
#ifdef _WIN32
  return _stricmp(a.c_str(), b.c_str()) == 0;
#else
  return strcasecmp(a.c_str(), b.c_str()) == 0;
#endif
}

// A HANDLE on Windows, a pid on Linux. Opaque to callers.
using ProcessHandle = uintptr_t;

struct Region {
  uintptr_t base = 0;
  size_t size = 0;
  bool free = false;
  // Backed by committed memory (Windows MEM_COMMIT), whatever its protection:
  // true for PAGE_NOACCESS and guard pages too, unlike `readable`.
  bool committed = false;
  bool readable = false;
  bool writable = false;
  bool executable = false;
  // Windows PAGE_EXECUTE_WRITECOPY (a copy-on-write executable image page).
  // `writable` is true for it, but the data scanners (scanner.cc,
  // pointer.cc) have always skipped it, so they need to tell it apart to
  // keep their results byte-identical. Always false on Linux.
  bool execCopyOnWrite = false;
};

struct ModuleInfo {
  std::string name;      // file name only, e.g. "GameAssembly.dll"
  uintptr_t base = 0;
  uint32_t size = 0;      // PE SizeOfImage
  uint32_t timestamp = 0; // PE TimeDateStamp
  std::string version;    // file version resource, empty when absent
};

// Every module loaded in the target. False on failure (protected or exiting
// process); callers treat that as "cannot verify" rather than as an error.
bool ListModules(ProcessHandle handle, std::vector<ModuleInfo>& out);

// The address of an exported function or variable inside a module already
// loaded in the target, found by walking that module's own PE export
// directory in the target's memory — not GetProcAddress, which only works
// on modules loaded in THIS process. Returns 0 when the module isn't a
// well-formed PE, the name isn't exported, or the export is a forwarder
// (a string naming another DLL's export rather than a real address) —
// none of this sub-project's targets are forwarded, and resolving a
// forwarder chain is not attempted.
uintptr_t ResolveExport(ProcessHandle handle, uintptr_t moduleBase, const std::string& name);

// Name, base and size only: no PE-header read, no file-version lookup. For
// hot paths (per-read module lookups, the pointer scan's anchor list) where
// ListModules' per-module disk and header I/O is too costly. Same module
// order as ListModules; unlike it, modules whose PE headers are unreadable
// are still returned.
struct ModuleRange {
  std::string name;
  uintptr_t base = 0;
  uintptr_t size = 0; // 0 when the OS could not report it
};
bool ListModuleRanges(ProcessHandle handle, std::vector<ModuleRange>& out);

using ThreadHandle = uintptr_t;

// Starts a thread in the target at `startAddress`, passing `param` as its
// single argument (matching LPTHREAD_START_ROUTINE's ABI: one pointer,
// arriving in RCX). Returns 0 on failure.
ThreadHandle CreateRemoteThread(ProcessHandle handle, uintptr_t startAddress, uintptr_t param);
// Waits up to timeoutMs for the thread to exit. False on timeout OR error
// — the caller must not free anything the thread could still be running
// inside when this returns false; see the never-free-a-live-cave rule.
bool WaitForRemoteThread(ThreadHandle thread, uint32_t timeoutMs);
void CloseRemoteThread(ThreadHandle thread);

// One running process, as ListProcesses enumerates it. `name` is the
// executable's file name (including ".exe" on Windows).
struct ProcessEntry {
  uint32_t pid = 0;
  std::string name;
};

// Every running process. False only if the enumeration itself failed.
bool ListProcesses(std::vector<ProcessEntry>& out);
// Opens `pid` with the rights memory read/write/query need. Returns 0 and
// fills `error` on failure (access denied, no such process).
ProcessHandle OpenProcess(uint32_t pid, std::string& error);
void CloseProcess(ProcessHandle handle);
// True while the process behind `handle` is still running.
bool IsAlive(ProcessHandle handle);
// Base address of the process's main executable image; 0 on failure.
uintptr_t MainModuleBase(ProcessHandle handle);

// Calling convention a target's native code uses for remote calls.
enum class Abi { Ms64, SysV };
// Which ABI the module at `moduleBase` in the target follows. Windows
// targets are always Ms64.
Abi PlatformAbiFor(ProcessHandle handle, uintptr_t moduleBase);

bool IsSupported();
const char* Name();

bool ReadMemory(ProcessHandle handle, uintptr_t address, void* out, size_t size);
// Must succeed against read-execute pages: implementations handle whatever
// protection dance their OS requires and leave protection as they found it.
bool WriteMemory(ProcessHandle handle, uintptr_t address, const void* data, size_t size);
// Plain write with no protection change, for pages WriteMemory could not
// make writable but which are already writable as mapped. Flushes the
// instruction cache where the OS needs it.
bool WriteMemoryUnprotected(ProcessHandle handle, uintptr_t address, const void* data, size_t size);
bool QueryRegion(ProcessHandle handle, uintptr_t address, Region& out);
// The OS page size, in bytes (a power of two). Cached.
uintptr_t PageSize();
// Returns 0 on failure. `nearAddr` matters: a 5-byte relative jump reaches
// ±2GB, so an allocation outside that range is useless to the caller.
// (Named `nearAddr` rather than `near`: windows.h's windef.h defines `near`
// as an empty legacy macro for 16-bit segment compatibility, which silently
// eats the identifier wherever it appears.)
uintptr_t AllocateNear(ProcessHandle handle, uintptr_t nearAddr, size_t size);
// Releases memory a prior AllocateNear call reserved. ONLY call this once
// the thread that ran inside the cave has provably finished (WaitForRemoteThread
// returned true) — freeing a cave a thread might still be executing inside
// is the "never free a live cave" hazard AllocateNear's own callers already
// reason about. A *patch* cave (code the game jumps into on every hit of a
// hooked instruction, potentially forever) must NEVER be freed at all —
// this is only for scratch caves used for one throwaway remote call/string
// and then done with.
bool FreeMemory(ProcessHandle handle, uintptr_t address);
// All-or-nothing: on failure nothing stays suspended.
// Not reentrant: a second call before the matching ResumeAll() refuses
// (returns false, touches nothing) rather than adding to the held set,
// because the held set is shared process-wide state — if it were allowed to
// grow and a later call then failed partway, that call's own cleanup would
// resume every handle in the set, including threads an earlier caller is
// still relying on staying frozen. Always pair one SuspendAll with one
// ResumeAll before suspending again.
bool SuspendAll(ProcessHandle handle, uint32_t pid);
void ResumeAll();

// A calling-thread sleep, not a target-process operation — exists so
// callers that create-and-tear-down many throwaway remote threads in quick
// succession (RunRemoteCall's per-call thread, invoked in a loop by
// anything that walks Mono metadata one item at a time) can space them
// out. Found necessary empirically: a burst of on the order of a hundred
// CreateRemoteThread/CloseHandle cycles within a couple of seconds against
// a real game correlated with the target process crashing shortly after,
// even though no single call was ever pointed at bad data — the executable-
// region guard in RunRemoteCall already rules that out. Throttling the rate
// of thread churn, not the total call count, is the target of this.
void SleepMs(uint32_t ms);

// One thread belonging to a process, as enumerated by ListThreads. Only
// the id — everything else (start address, etc.) neither this feature nor
// any caller today needs.
struct ThreadInfo {
  uint32_t tid = 0;
};

// Every thread's register file, as GetThreadRegisters reads it. General
// purpose registers plus rip/rsp/rbp and eflags — enough to make sense of
// a disassembly view (cmp/mov operands, the current instruction pointer)
// without reaching for the full CONTEXT structure's FPU/XMM state, which
// nothing in this codebase decodes or displays.
struct ThreadRegisters {
  uint64_t rax = 0, rbx = 0, rcx = 0, rdx = 0;
  uint64_t rsi = 0, rdi = 0, rbp = 0, rsp = 0, rip = 0;
  uint64_t r8 = 0, r9 = 0, r10 = 0, r11 = 0;
  uint64_t r12 = 0, r13 = 0, r14 = 0, r15 = 0;
  uint64_t rflags = 0;
};

// Every thread owned by `pid`, via a point-in-time Toolhelp32 snapshot —
// same source SuspendAll already walks. False only if the snapshot itself
// couldn't be taken (out param left empty either way); an empty-but-valid
// result (process has no threads left, or none matched) is `true` with an
// empty `out`, not a failure.
bool ListThreads(uint32_t pid, std::vector<ThreadInfo>& out);

// One thread's register file, read via a brief suspend/GetThreadContext/
// resume (the same three-call shape DebugSession::SetHwBreakpoint uses to
// read/modify debug registers). False when
// the thread has already exited (the snapshot ListThreads read it from is
// a point-in-time copy — same race SuspendAll's own OpenThread failure
// handling documents) or the platform doesn't support this.
bool GetThreadRegisters(uint32_t tid, ThreadRegisters& out);

// Whether DebugSession works on this platform (hardware data breakpoints
// through a debugger attachment).
bool SupportsHardwareWatch();

// What a DebugSession::Wait reported. Every event except `detached` leaves
// the target stopped until Continue: for Attached and ThreadCreated the
// backend must leave ALL target threads stopped (the caller arms threads
// other than the reporting one), for Hit and Other at least the reporting
// thread. (Windows stops the whole process for every debug event; ptrace
// stops only the reporting thread, so a ptrace backend stops the rest.)
enum class DebugEventKind {
  // First stop after attach: the safe point to arm every existing thread.
  // (Windows: CREATE_PROCESS_DEBUG_EVENT.)
  Attached,
  // A thread born mid-session; `tid` is the new thread, which has none of
  // the session's breakpoints yet and must be armed by the caller.
  ThreadCreated,
  // A hardware breakpoint fired. `rip` is the trap address, which for a
  // data breakpoint is the instruction AFTER the write (trap-style #DB).
  Hit,
  // Anything else (DLL load, the attach breakpoint, the target's own
  // exceptions, thread exit...). Handled inside the session; the caller
  // only has to Continue it.
  Other,
};

struct WatchEvent {
  DebugEventKind kind = DebugEventKind::Other;
  uint32_t tid = 0;
  uint64_t rip = 0;
  // Debug-register slot that fired, or -1 when the backend does not say.
  // Windows reports -1: it treats every single-step exception as a hit
  // without consulting Dr6, as write-watch always has.
  int slot = -1;
  // The trapping thread's registers, Hit only; `hasRegs` false when they
  // could not be read (the thread can be gone by then).
  ThreadRegisters regs;
  bool hasRegs = false;
  // The target exited. The session is over: do not Continue this event, but
  // still Detach (or destroy the session).
  bool detached = false;
};

// A debugger attachment to one process, for hardware write breakpoints.
//
// Thread rule: Attach, SetHwBreakpoint, Wait, Continue and Detach must all
// run on the SAME thread. Windows delivers debug events only to the thread
// that called DebugActiveProcess, and Linux ptrace only lets the tracing
// thread operate on its tracees, so a caller runs the whole session on one
// dedicated thread.
class DebugSession {
 public:
  // Attaches as a debugger. The target is NOT killed when this process
  // exits or detaches. Returns null and fills `error` on failure (bad pid,
  // already being debugged, access denied).
  static std::unique_ptr<DebugSession> Attach(uint32_t pid, std::string& error);

  // Arms (or with enable=false disarms) an on-write data breakpoint in
  // debug-register `slot` (0-3) of one thread. `len` must be 1, 2, 4 or 8
  // and `address` aligned to it: x86 leaves a misaligned data breakpoint
  // undefined, so this refuses one. `address`/`len` are ignored when
  // disarming.
  //
  // Callable at any time on the session thread, whether or not the target
  // is stopped at an event: write-watch disarms every thread AFTER its loop
  // has continued the last event, while the target runs. The backend stops
  // the thread itself if it is not already stopped and leaves it in the
  // state it found it (Windows: SuspendThread/ResumeThread around the
  // context write; ptrace: PTRACE_INTERRUPT and wait, POKEUSER, resume).
  // A disarm that silently failed would leave the breakpoint armed through
  // Detach and kill the target on its next write.
  bool SetHwBreakpoint(uint32_t tid, int slot, uintptr_t address, size_t len, bool enable);

  // Waits up to timeoutMs for the next debug event. False on timeout.
  bool Wait(uint32_t timeoutMs, WatchEvent& out);

  // Resumes the target after `ev`, with whatever continue status the event
  // needs (the target's own exceptions go back to it unhandled). `ev` must
  // be the event Wait last returned and that is still pending; a backend
  // with several stopped threads uses ev.tid to know which stop it ends.
  // No-op when nothing is pending.
  void Continue(const WatchEvent& ev);

  // Drains any debug event already in flight, then detaches, leaving the
  // target running. Idempotent. Continues a still-pending event first,
  // except the exit event. Disarms NOTHING on its own: callers disarm every
  // breakpoint they armed via SetHwBreakpoint before calling it, because an
  // exception that fires after detach has no debugger to take it and kills
  // the target.
  void Detach();

  ~DebugSession();
  DebugSession(const DebugSession&) = delete;
  DebugSession& operator=(const DebugSession&) = delete;

 private:
  struct State; // per-backend
  explicit DebugSession(std::unique_ptr<State> state);
  std::unique_ptr<State> state_;
};

} // namespace platform
