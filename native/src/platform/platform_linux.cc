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

bool ReadMemory(ProcessHandle, uintptr_t, void*, size_t) { return false; }
bool WriteMemory(ProcessHandle, uintptr_t, const void*, size_t) { return false; }
bool QueryRegion(ProcessHandle, uintptr_t, Region&) { return false; }
uintptr_t AllocateNear(ProcessHandle, uintptr_t, size_t) { return 0; }
bool SuspendAll(ProcessHandle, uint32_t) { return false; }
void ResumeAll() {}

} // namespace platform
