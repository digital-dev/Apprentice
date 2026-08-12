#pragma once
#include <windows.h>
#include <psapi.h>
#include <cstdint>
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
    HANDLE h, uintptr_t base, const std::vector<uintptr_t>& offsets) {
  uintptr_t addr = base;
  for (size_t i = 0; i < offsets.size(); i++) {
    addr += offsets[i];
    if (i + 1 < offsets.size()) {
      uintptr_t next;
      SIZE_T read;
      if (!ReadProcessMemory(h, (LPCVOID)addr, &next, sizeof(next), &read) || read != sizeof(next))
        return std::nullopt;
      addr = next;
    }
  }
  return addr;
}

// Minimal module-base lookup — script_ops.cc's resolvePointer binding
// only needs the base address, not pointer.cc's full ModuleRange/
// FindContainingModule machinery (that supports the REVERSE pointer scan;
// this supports the forward walk above).
inline std::optional<uintptr_t> FindModuleBase(HANDLE h, const std::string& moduleName) {
  HMODULE mods[1024];
  DWORD needed;
  if (!EnumProcessModulesEx(h, mods, sizeof(mods), &needed, LIST_MODULES_ALL)) return std::nullopt;
  DWORD count = needed / sizeof(HMODULE);
  if (count > 1024) count = 1024;
  for (DWORD i = 0; i < count; i++) {
    char nameBuf[MAX_PATH];
    if (GetModuleBaseNameA(h, mods[i], nameBuf, sizeof(nameBuf)) &&
        _stricmp(nameBuf, moduleName.c_str()) == 0) {
      return reinterpret_cast<uintptr_t>(mods[i]);
    }
  }
  return std::nullopt;
}
