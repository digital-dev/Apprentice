#include "platform.h"
#include <windows.h>
#include <tlhelp32.h>
#include <vector>

namespace platform {
namespace {
std::vector<HANDLE> g_suspended;
constexpr uintptr_t kJumpReach = 0x7FFF0000;
} // namespace

bool IsSupported() { return true; }
const char* Name() { return "windows"; }

bool ReadMemory(ProcessHandle handle, uintptr_t address, void* out, size_t size) {
  SIZE_T read = 0;
  return ReadProcessMemory((HANDLE)handle, (LPCVOID)address, out, size, &read) &&
         read == size;
}

// Writing into a live process's CODE, which normally sits on read-execute
// pages: temporarily make the page writable, write, put the original
// protection back, then flush the target's instruction cache so the CPU
// doesn't keep executing a stale cached copy of the bytes we just changed.
// Same contract as patch_ops.cc's WriteBytes.
bool WriteMemory(ProcessHandle handle, uintptr_t address, const void* data, size_t size) {
  HANDLE h = (HANDLE)handle;

  // VirtualProtectEx changes every page touched by [address, address+size),
  // but it reports only the FIRST page's prior protection in oldProtect.
  // If the range straddled a page boundary (an instruction can span one),
  // restoring oldProtect across the whole range would stamp page 1's
  // protection onto page 2 — leaving that page with wrong, unintended
  // protection permanently, which is exactly the residue this feature
  // promises never to leave. This addon only ever patches a single
  // captured instruction, so a straddling range is an anomaly: refuse it
  // rather than add per-page VirtualQueryEx/restore machinery for a case
  // that should not arise in normal use.
  static const uintptr_t pageSize = [] {
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    return static_cast<uintptr_t>(si.dwPageSize);
  }();
  uintptr_t firstPage = address & ~(pageSize - 1);
  uintptr_t lastPage = (address + size - 1) & ~(pageSize - 1);
  if (firstPage != lastPage) return false;

  DWORD oldProtect = 0;
  if (!VirtualProtectEx(h, (LPVOID)address, size, PAGE_EXECUTE_READWRITE, &oldProtect))
    return false;

  SIZE_T written = 0;
  bool ok = WriteProcessMemory(h, (LPVOID)address, data, size, &written) &&
            written == size;

  // Restore protection regardless of whether the write succeeded — leaving
  // a game's code page permanently writable is exactly the kind of residue
  // this feature promises never to leave behind.
  DWORD ignored = 0;
  VirtualProtectEx(h, (LPVOID)address, size, oldProtect, &ignored);
  FlushInstructionCache(h, (LPCVOID)address, size);

  return ok;
}

bool QueryRegion(ProcessHandle handle, uintptr_t address, Region& out) {
  MEMORY_BASIC_INFORMATION mbi;
  if (VirtualQueryEx((HANDLE)handle, (LPCVOID)address, &mbi, sizeof(mbi)) != sizeof(mbi))
    return false;
  out.base = (uintptr_t)mbi.BaseAddress;
  out.size = mbi.RegionSize;
  out.free = mbi.State == MEM_FREE;
  out.readable = mbi.State == MEM_COMMIT && !(mbi.Protect & PAGE_GUARD) &&
                 (mbi.Protect & (PAGE_READWRITE | PAGE_READONLY | PAGE_WRITECOPY |
                                 PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                                 PAGE_EXECUTE_WRITECOPY));
  out.executable = mbi.State == MEM_COMMIT && !(mbi.Protect & PAGE_GUARD) &&
                   (mbi.Protect & (PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                                   PAGE_EXECUTE_WRITECOPY));
  return true;
}

// Walks free regions outward from `near` and commits the first page within
// jump reach. Windows allocates on 64KB granularity, so candidates align to
// that rather than to the page size.
uintptr_t AllocateNear(ProcessHandle handle, uintptr_t nearAddr, size_t size) {
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  const uintptr_t granularity = si.dwAllocationGranularity;

  uintptr_t low = (nearAddr > kJumpReach) ? nearAddr - kJumpReach : 0;
  uintptr_t high = nearAddr + kJumpReach;

  // Upward first, then downward: either direction is equally valid, and most
  // processes have free space above their modules.
  for (int direction = 0; direction < 2; direction++) {
    uintptr_t addr = nearAddr;
    while (addr >= low && addr <= high) {
      MEMORY_BASIC_INFORMATION mbi;
      if (VirtualQueryEx((HANDLE)handle, (LPCVOID)addr, &mbi, sizeof(mbi)) != sizeof(mbi))
        break;

      if (mbi.State == MEM_FREE && mbi.RegionSize >= size) {
        uintptr_t candidate =
            ((uintptr_t)mbi.BaseAddress + granularity - 1) & ~(granularity - 1);
        if (candidate >= low && candidate <= high &&
            candidate + size <= (uintptr_t)mbi.BaseAddress + mbi.RegionSize) {
          LPVOID got = VirtualAllocEx((HANDLE)handle, (LPVOID)candidate, size,
                                      MEM_RESERVE | MEM_COMMIT,
                                      PAGE_EXECUTE_READWRITE);
          if (got) return (uintptr_t)got;
        }
      }

      if (direction == 0) {
        uintptr_t next = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
        if (next <= addr) break;
        addr = next;
      } else {
        if ((uintptr_t)mbi.BaseAddress < granularity) break;
        addr = (uintptr_t)mbi.BaseAddress - granularity;
      }
    }
  }
  return 0;
}

bool SuspendAll(ProcessHandle handle, uint32_t pid) {
  (void)handle;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snap == INVALID_HANDLE_VALUE) return false;

  THREADENTRY32 te{};
  te.dwSize = sizeof(te);
  bool failed = false;
  if (Thread32First(snap, &te)) {
    do {
      if (te.th32OwnerProcessID != pid) continue;
      HANDLE th = OpenThread(THREAD_SUSPEND_RESUME, FALSE, te.th32ThreadID);
      if (!th) { failed = true; break; }
      if (SuspendThread(th) == (DWORD)-1) {
        CloseHandle(th);
        failed = true;
        break;
      }
      g_suspended.push_back(th);
    } while (Thread32Next(snap, &te));
  }
  CloseHandle(snap);

  // All or nothing: a half-suspended target must never be written to, so undo
  // a partial suspension before reporting failure.
  if (failed) {
    ResumeAll();
    return false;
  }
  return true;
}

void ResumeAll() {
  for (HANDLE th : g_suspended) { ResumeThread(th); CloseHandle(th); }
  g_suspended.clear();
}

} // namespace platform
