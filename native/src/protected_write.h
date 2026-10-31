#pragma once
#include "platform/platform.h"
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>
#include <algorithm>

// Writes into a live process's memory, which may sit on a read-only or
// read-execute page (game code, or a data page the OS mapped read-only).
// The OS-specific part (on Windows: temporarily make the page writable,
// write, restore the original protection, flush the target's instruction
// cache) lives in platform::WriteMemory; this header adds the policy on top:
// the lock, and what to do when a range straddles a page boundary.
// Safe to call for pure data writes too. Factored out of patch_ops.cc's
// WriteBytes so memory_ops.cc's WriteValue and script_ops.cc's
// LuaWrite{Value,Bytes} share one implementation.
//
// TWO entry points, not one, because code patching and data writing have
// genuinely different correctness requirements at a page boundary — see
// each function's own comment.

namespace protected_write {

// platform::WriteMemory protects and restores one page range at a time, and
// (on Windows) VirtualProtectEx reports only the FIRST page's prior
// protection, so a range that straddles a page boundary cannot be handled by
// a single call without stamping page 1's protection onto page 2. Callers
// here split on page boundaries instead.
inline uintptr_t PageSize() { return platform::PageSize(); }

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

} // namespace protected_write

// CODE writes (patch_ops.cc's WriteBytes). Refuses a straddling write
// outright, and that refusal is load-bearing rather than laziness: the
// caller is patching one captured CPU instruction, so a range crossing a
// page boundary means the instruction itself spans two pages with two
// (potentially different) protections, and the oldProtect-reports-page-1-
// only hazard above would silently mis-restore the second one. Refusing is
// the original, correct patch_ops.cc behaviour and is preserved exactly.
inline bool ProtectedCodeWrite(platform::ProcessHandle h, uintptr_t address, const void* data, size_t size) {
  if (size == 0) return false;
  if (protected_write::Straddles(address, size)) return false;

  std::lock_guard<std::mutex> guard(protected_write::Lock());
  return platform::WriteMemory(h, address, data, size);
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
inline bool ProtectedDataWrite(platform::ProcessHandle h, uintptr_t address, const void* data, size_t size) {
  if (size == 0) return false;

  std::lock_guard<std::mutex> guard(protected_write::Lock());

  if (!protected_write::Straddles(address, size))
    return platform::WriteMemory(h, address, data, size);

  const uintptr_t ps = protected_write::PageSize();
  const uintptr_t firstPage = address & ~(ps - 1);
  const uintptr_t lastPage = (address + size - 1) & ~(ps - 1);

  // All-or-nothing: every page must be mapped before anything is written, so
  // an unmapped trailing page cannot leave the leading bytes written.
  for (uintptr_t page = firstPage; page <= lastPage; page += ps) {
    platform::Region r;
    if (!platform::QueryRegion(h, page, r) || r.free) return false;
  }

  // Best-effort backup so a write that fails partway can be undone.
  std::vector<uint8_t> backup(size);
  const bool haveBackup = platform::ReadMemory(h, address, backup.data(), size);

  const uint8_t* src = static_cast<const uint8_t*>(data);
  uintptr_t cursor = address;
  size_t done = 0;
  while (done < size) {
    const uintptr_t pageEnd = (cursor & ~(ps - 1)) + ps;
    const size_t chunk = static_cast<size_t>(std::min<uintptr_t>(pageEnd - cursor, size - done));
    if (!platform::WriteMemory(h, cursor, src + done, chunk)) {
      if (haveBackup && done > 0) platform::WriteMemory(h, address, backup.data(), done);
      return false;
    }
    cursor += chunk;
    done += chunk;
  }
  return true;
}
