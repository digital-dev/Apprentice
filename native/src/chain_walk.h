#pragma once
#include "platform/platform.h"
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string>
#include <vector>

// The forward base+offsets pointer walk: dereference every offset except
// the last, add the last without dereferencing. Shared by memory_ops.cc
// (ReadValue/WriteValue) and script_ops.cc's resolvePointer Lua binding —
// hoisted out of memory_ops.cc's former anonymous namespace so both use
// exactly one implementation. This is the FORWARD walk (module base ->
// target address); it is unrelated to pointer.cc's ResolvePointerChain,
// which does the REVERSE search (target address -> a chain that reaches
// it) via a whole-process pointer scan.
inline uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

inline std::optional<uintptr_t> ResolveChain(
    platform::ProcessHandle h, uintptr_t base, const std::vector<uintptr_t>& offsets) {
  uintptr_t addr = base;
  for (size_t i = 0; i < offsets.size(); i++) {
    addr += offsets[i];
    if (i + 1 < offsets.size()) {
      uintptr_t next;
      if (!platform::ReadMemory(h, addr, &next, sizeof(next))) return std::nullopt;
      addr = next;
    }
  }
  return addr;
}

// Minimal module-base lookup — script_ops.cc's resolvePointer binding
// only needs the base address, not pointer.cc's full ModuleRange/
// FindContainingModule machinery (that supports the REVERSE pointer scan;
// this supports the forward walk above).
inline std::optional<uintptr_t> FindModuleBase(platform::ProcessHandle h, const std::string& moduleName) {
  std::vector<platform::ModuleRange> mods;
  if (!platform::ListModuleRanges(h, mods)) return std::nullopt;
  for (const auto& m : mods) {
    if (_stricmp(m.name.c_str(), moduleName.c_str()) == 0) return m.base;
  }
  return std::nullopt;
}
