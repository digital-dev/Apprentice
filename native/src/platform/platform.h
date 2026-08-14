#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>

// The OS operations code injection needs, and nothing else. Windows is the
// platform that works today; the Linux backend is a stub that refuses
// cleanly, so a Linux build compiles and loads rather than pretending.
//
// Only NEW code goes through here. The existing scanner, pointer walker,
// memory ops, write-watch and patch ops still call Win32 directly; porting
// those is a separate sub-project.
namespace platform {

// A HANDLE on Windows, a pid on Linux. Opaque to callers.
using ProcessHandle = uintptr_t;

struct Region {
  uintptr_t base = 0;
  size_t size = 0;
  bool free = false;
  bool readable = false;
  bool executable = false;
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

bool IsSupported();
const char* Name();

bool ReadMemory(ProcessHandle handle, uintptr_t address, void* out, size_t size);
// Must succeed against read-execute pages: implementations handle whatever
// protection dance their OS requires and leave protection as they found it.
bool WriteMemory(ProcessHandle handle, uintptr_t address, const void* data, size_t size);
bool QueryRegion(ProcessHandle handle, uintptr_t address, Region& out);
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

} // namespace platform
