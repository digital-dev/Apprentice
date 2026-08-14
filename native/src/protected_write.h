#pragma once
#include <windows.h>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

// Writes into a live process's memory, which may sit on a read-only or
// read-execute page (game code, or a data page the OS mapped read-only):
// temporarily makes the page writable, writes, restores the original
// protection, then flushes the target's instruction cache so the CPU
// doesn't keep executing/caching a stale copy of the bytes just changed.
// Safe to call for pure data writes too — FlushInstructionCache is a no-op
// there. Factored out of patch_ops.cc's WriteBytes so memory_ops.cc's
// WriteValue and script_ops.cc's LuaWrite{Value,Bytes} share one
// implementation of this dance instead of a second (and third) copy of it.
//
// TWO entry points, not one, because code patching and data writing have
// genuinely different correctness requirements at a page boundary — see
// each function's own comment. Everything else (the protect/write/restore/
// flush sequence, the lock) is shared.

namespace protected_write {

// VirtualProtectEx changes every page touched by [address, address+size),
// but it reports only the FIRST page's PRIOR protection in oldProtect. So a
// range that straddles a page boundary cannot be protected-and-restored in
// one call without stamping page 1's protection onto page 2 — leaving that
// page with wrong, permanent protection.
inline uintptr_t PageSize() {
  static const uintptr_t pageSize = [] {
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    return static_cast<uintptr_t>(si.dwPageSize);
  }();
  return pageSize;
}

inline bool Straddles(uintptr_t address, size_t size) {
  const uintptr_t ps = PageSize();
  return (address & ~(ps - 1)) != ((address + size - 1) & ~(ps - 1));
}

// Serializes the ENTIRE protect -> write -> restore -> flush sequence
// against every other caller in this process.
//
// Not a theoretical concern: Lua scripts run on a libuv worker thread
// (script_ops.cc's RunScriptWorker), so LuaWriteValue/LuaWriteBytes run
// this dance OFF the main thread, potentially at the same instant as the
// main-thread freeze loop's WriteValue running it against the same target
// process and even the same page (two cheats writing neighbouring fields
// is ordinary). Interleaved, two dances can each read the other's
// temporary PAGE_EXECUTE_READWRITE as "the original protection" and both
// restore it — leaving the page permanently RWX — or one can have its
// protection yanked back to read-only by the other between its own
// VirtualProtectEx and its WriteProcessMemory, silently failing the write.
// A mutex around a handful of syscalls costs nothing next to that.
inline std::mutex& Lock() {
  static std::mutex m;
  return m;
}

// Caller must already hold Lock().
inline bool WriteOnePageRange(HANDLE h, uintptr_t address, const void* data, size_t size) {
  DWORD oldProtect = 0;
  if (!VirtualProtectEx(h, (LPVOID)address, size, PAGE_EXECUTE_READWRITE, &oldProtect))
    return false;

  SIZE_T written = 0;
  bool ok = WriteProcessMemory(h, (LPVOID)address, data, size, &written) && written == size;

  // Restore protection regardless of whether the write succeeded — leaving
  // a page permanently writable is exactly the kind of residue this helper
  // promises never to leave behind.
  DWORD ignored = 0;
  VirtualProtectEx(h, (LPVOID)address, size, oldProtect, &ignored);
  FlushInstructionCache(h, (LPCVOID)address, size);
  return ok;
}

} // namespace protected_write

// CODE writes (patch_ops.cc's WriteBytes). Refuses a straddling write
// outright, and that refusal is load-bearing rather than laziness: the
// caller is patching one captured CPU instruction, so a range crossing a
// page boundary means the instruction itself spans two pages with two
// (potentially different) protections, and the oldProtect-reports-page-1-
// only hazard above would silently mis-restore the second one. Refusing is
// the original, correct patch_ops.cc behaviour and is preserved exactly.
inline bool ProtectedCodeWrite(HANDLE h, uintptr_t address, const void* data, size_t size) {
  if (size == 0) return false;
  if (protected_write::Straddles(address, size)) return false;

  std::lock_guard<std::mutex> guard(protected_write::Lock());
  return protected_write::WriteOnePageRange(h, address, data, size);
}

// DATA writes (memory_ops.cc's WriteValue, script_ops.cc's LuaWriteValue
// and LuaWriteBytes). These write ordinary values, not instructions, and
// before this helper existed they went through a bare WriteProcessMemory
// with no page restriction at all — an int64/double landing in the last
// few bytes of a page, or a 256-byte Lua writeBytes (which straddles a
// page boundary roughly 6% of the time), simply worked. Refusing them here
// would turn a working write into a silent permanent failure, so instead a
// straddle is handled PER PAGE: each page the range touches is protected
// and restored on its own, so every page gets back its own protection.
//
// Restores run in reverse order purely so the sequence unwinds exactly as
// it was applied; the single-page case (the overwhelmingly common one) is
// byte-for-byte the same dance ProtectedCodeWrite performs.
inline bool ProtectedDataWrite(HANDLE h, uintptr_t address, const void* data, size_t size) {
  if (size == 0) return false;

  std::lock_guard<std::mutex> guard(protected_write::Lock());

  if (!protected_write::Straddles(address, size))
    return protected_write::WriteOnePageRange(h, address, data, size);

  const uintptr_t ps = protected_write::PageSize();
  const uintptr_t firstPage = address & ~(ps - 1);
  const uintptr_t lastPage = (address + size - 1) & ~(ps - 1);

  struct Restored {
    uintptr_t page;
    DWORD oldProtect;
  };
  std::vector<Restored> restored;

  bool protectedAll = true;
  for (uintptr_t page = firstPage; page <= lastPage; page += ps) {
    DWORD oldProtect = 0;
    if (!VirtualProtectEx(h, (LPVOID)page, ps, PAGE_EXECUTE_READWRITE, &oldProtect)) {
      // A page in the middle of the range isn't protectable (unmapped, or
      // a guard page). Don't half-apply: unwind and fall back to the plain
      // unprotected write below, which is exactly what this code path did
      // before this helper existed.
      protectedAll = false;
      break;
    }
    restored.push_back({page, oldProtect});
  }

  SIZE_T written = 0;
  bool ok = protectedAll &&
            WriteProcessMemory(h, (LPVOID)address, data, size, &written) && written == size;

  for (size_t i = restored.size(); i-- > 0;) {
    DWORD ignored = 0;
    VirtualProtectEx(h, (LPVOID)restored[i].page, ps, restored[i].oldProtect, &ignored);
  }

  if (!protectedAll) {
    // Plain write, no protection games — the pre-existing behaviour for a
    // range we can't safely protect page by page.
    written = 0;
    ok = WriteProcessMemory(h, (LPVOID)address, data, size, &written) && written == size;
  }

  FlushInstructionCache(h, (LPCVOID)address, size);
  return ok;
}
