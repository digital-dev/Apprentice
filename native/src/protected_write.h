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

  // Refuse BEFORE writing anything if any page is free or uncommitted.
  // Deliberately not `readable`: PAGE_NOACCESS and guard pages are committed
  // and were writable once protected, so they must stay writable.
  for (uintptr_t page = firstPage; page <= lastPage; page += ps) {
    platform::Region r;
    if (!platform::QueryRegion(h, page, r) || !r.committed) return false;
  }

  // One chunk per page. Each chunk is written through the protect dance; if
  // that cannot make the page writable (e.g. a mapped section view without
  // execute rights) fall back to a plain write, as the pre-port code did.
  struct Chunk {
    uintptr_t address;
    size_t offset;
    size_t size;
    std::vector<uint8_t> backup; // empty when the page was unreadable
  };
  std::vector<Chunk> done;

  const uint8_t* src = static_cast<const uint8_t*>(data);
  uintptr_t cursor = address;
  size_t offset = 0;
  while (offset < size) {
    const uintptr_t pageEnd = (cursor & ~(ps - 1)) + ps;
    const size_t len = static_cast<size_t>(std::min<uintptr_t>(pageEnd - cursor, size - offset));

    Chunk c{cursor, offset, len, std::vector<uint8_t>(len)};
    if (!platform::ReadMemory(h, cursor, c.backup.data(), len)) c.backup.clear();

    bool ok = platform::WriteMemory(h, cursor, src + offset, len) ||
              platform::WriteMemoryUnprotected(h, cursor, src + offset, len);
    if (!ok) {
      // Best-effort undo of the chunks already written.
      for (size_t i = done.size(); i-- > 0;) {
        const Chunk& d = done[i];
        if (d.backup.empty()) continue;
        if (!platform::WriteMemory(h, d.address, d.backup.data(), d.size))
          platform::WriteMemoryUnprotected(h, d.address, d.backup.data(), d.size);
      }
      return false;
    }
    done.push_back(std::move(c));
    cursor += len;
    offset += len;
  }
  return true;
}
