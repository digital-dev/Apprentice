#pragma once
#include <windows.h>
#include <cstddef>
#include <cstdint>

// Writes into a live process's memory, which may sit on a read-only or
// read-execute page (game code, or a data page the OS mapped read-only):
// temporarily makes the page writable, writes, restores the original
// protection, then flushes the target's instruction cache so the CPU
// doesn't keep executing/caching a stale copy of the bytes just changed.
// Safe to call for pure data writes too — FlushInstructionCache is a no-op
// there. Factored out of patch_ops.cc's WriteBytes so memory_ops.cc's
// WriteValue and script_ops.cc's LuaWriteBytes share one implementation of
// this dance instead of a second (and third) copy of it.
//
// VirtualProtectEx changes every page touched by [address, address+size),
// but it reports only the FIRST page's PRIOR protection in oldProtect. If
// the range straddled a page boundary, blindly restoring oldProtect across
// the whole range would stamp page 1's protection onto page 2 — leaving
// that page with wrong, permanent protection. Every current caller writes a
// small, fixed-size value (at most 8 bytes for a scalar, a handful for a
// patched instruction), so a straddle is an edge case near a page boundary
// rather than the common case — but it can happen, so it is refused here
// rather than silently mishandled, matching patch_ops.cc's original
// behaviour exactly.
inline bool ProtectedWriteProcessMemory(HANDLE h, uintptr_t address, const void* data, size_t size) {
  if (size == 0) return false;

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
  bool ok = WriteProcessMemory(h, (LPVOID)address, data, size, &written) && written == size;

  // Restore protection regardless of whether the write succeeded — leaving
  // a page permanently writable is exactly the kind of residue this helper
  // promises never to leave behind.
  DWORD ignored = 0;
  VirtualProtectEx(h, (LPVOID)address, size, oldProtect, &ignored);
  FlushInstructionCache(h, (LPCVOID)address, size);

  return ok;
}
