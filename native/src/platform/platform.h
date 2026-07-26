#pragma once
#include <cstdint>
#include <cstddef>

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

} // namespace platform
