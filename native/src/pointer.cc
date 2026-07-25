#include "pointer.h"
#include <windows.h>
#include <psapi.h>
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>
#include <optional>

namespace {

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

std::string ToHex(uintptr_t addr) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)addr);
  return buf;
}

struct PointerEntry {
  uintptr_t address;
  uintptr_t value;
};

struct ModuleRange {
  std::string name;
  uintptr_t base;
  uintptr_t end;
};

// Real games (Unity/Mono in particular) very often keep the static roots
// that lead to gameplay state in a runtime DLL (e.g. mono-2.0-bdwgc.dll,
// UnityPlayer.dll) rather than in the main .exe module. Anchoring only to
// the .exe (as a first version of this function did) means a genuinely
// static, valid chain gets reported as "not found" whenever the real
// anchor lives in a different module. Enumerate every loaded module and
// treat any of them as a valid anchor.
std::vector<ModuleRange> ListModules(HANDLE h) {
  std::vector<ModuleRange> out;
  HMODULE mods[1024];
  DWORD needed;
  if (!EnumProcessModulesEx(h, mods, sizeof(mods), &needed, LIST_MODULES_ALL)) {
    return out;
  }
  DWORD count = needed / sizeof(HMODULE);
  if (count > 1024) count = 1024;

  for (DWORD i = 0; i < count; i++) {
    char nameBuf[MAX_PATH];
    MODULEINFO info{};
    if (GetModuleBaseNameA(h, mods[i], nameBuf, sizeof(nameBuf)) &&
        GetModuleInformation(h, mods[i], &info, sizeof(info))) {
      uintptr_t base = reinterpret_cast<uintptr_t>(mods[i]);
      out.push_back({nameBuf, base, base + info.SizeOfImage});
    }
  }
  return out;
}

// Returns the module containing `addr`, or nullptr if it's not inside any
// loaded module's static range (e.g. it's heap/stack memory).
const ModuleRange* FindContainingModule(const std::vector<ModuleRange>& modules, uintptr_t addr) {
  for (const auto& m : modules) {
    if (addr >= m.base && addr < m.end) return &m;
  }
  return nullptr;
}

std::vector<PointerEntry> CollectPointers(HANDLE h) {
  std::vector<PointerEntry> out;
  MEMORY_BASIC_INFORMATION mbi;
  uintptr_t addr = 0;
  while (VirtualQueryEx(h, (LPCVOID)addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
    bool readable = (mbi.State == MEM_COMMIT) &&
        (mbi.Protect & (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE)) &&
        !(mbi.Protect & PAGE_GUARD);
    if (readable) {
      for (uintptr_t p = (uintptr_t)mbi.BaseAddress;
           p + sizeof(uintptr_t) <= (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
           p += sizeof(uintptr_t)) {
        uintptr_t val;
        SIZE_T read;
        if (ReadProcessMemory(h, (LPCVOID)p, &val, sizeof(val), &read) && read == sizeof(val)) {
          if (val != 0) out.push_back({p, val});
        }
      }
    }
    uintptr_t next = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
    if (next <= addr) break; // guard against non-advancing regions
    addr = next;
  }
  return out;
}

struct ChainResult {
  std::string moduleName;
  std::vector<uintptr_t> offsets;
};

// FindChain(target, levelsLeft) returns an offset list which, when resolved
// via the standard "deref all but the last offset" walk starting at the
// anchor module's base, lands exactly on `target` itself (not a dereference
// of it). That's the same invariant the exported offsets must satisfy per
// the task interface: *(moduleBase + offsets[0]) + offsets[1] ... ==
// targetAddress, with the final offset added but not dereferenced.
//
// The anchor is not restricted to a single module: any loaded module whose
// static range contains the pointer entry is accepted, since real games
// (Unity/Mono especially) frequently keep static roots in a runtime DLL
// rather than the main .exe.
//
// Base case: a pointer entry `e` whose stored value equals `target` and
// whose own address already sits inside some module M (reachable from
// M's base with zero dereferences via [e.address - M.base]). To go from
// "address of e" to "value stored at e" (== target) requires exactly one
// more dereference. In offset-list terms, appending a trailing 0 makes the
// previously-last offset become non-last (so it gets dereferenced) and the
// new last offset (0) is added without dereferencing, landing on target.
// So the base case must return {e.address - M.base, 0}, not just
// {e.address - M.base} (which would land on the address of e, one
// dereference short of target).
//
// Recursive case: entry `e` whose value equals `target` but whose address
// is not itself in any module. Recurse to find `inner`, an offset list
// that lands on e.address (by the same invariant, applied to the smaller
// problem "reach e.address from some module's base"). Since *e.address ==
// target, appending a trailing 0 to `inner` forces one more dereference at
// the point that used to be `inner`'s last step, producing target —
// exactly mirroring the base case's fix.
std::optional<ChainResult> FindChain(
    const std::vector<ModuleRange>& modules,
    uintptr_t target, int levelsLeft, const std::vector<PointerEntry>& pointers) {
  for (const auto& e : pointers) {
    if (e.value != target) continue;
    if (const ModuleRange* m = FindContainingModule(modules, e.address)) {
      return ChainResult{m->name, {e.address - m->base, 0}};
    }
    if (levelsLeft > 0) {
      auto inner = FindChain(modules, e.address, levelsLeft - 1, pointers);
      if (inner) {
        inner->offsets.push_back(0);
        return inner;
      }
    }
  }
  return std::nullopt;
}

} // namespace

Napi::Value ResolvePointerChain(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t target = ParseHex(info[1].As<Napi::String>().Utf8Value());
  int maxLevels = info[2].As<Napi::Number>().Int32Value();

  auto modules = ListModules(h);
  auto pointers = CollectPointers(h);
  auto chain = FindChain(modules, target, maxLevels, pointers);

  if (!chain) return env.Null();

  Napi::Object result = Napi::Object::New(env);
  result.Set("moduleName", Napi::String::New(env, chain->moduleName));
  Napi::Array offsets = Napi::Array::New(env);
  for (size_t i = 0; i < chain->offsets.size(); i++) {
    offsets.Set((uint32_t)i, Napi::String::New(env, ToHex(chain->offsets[i])));
  }
  result.Set("offsets", offsets);
  return result;
}

// Looks up a currently-loaded module's base address by name. Used to
// re-resolve a saved cheat's anchor module every read/write, since a cheat
// can be anchored to any loaded module, not just the one the process
// happened to attach against.
Napi::Value GetModuleBase(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  std::string moduleName = info[1].As<Napi::String>().Utf8Value();

  auto modules = ListModules(h);
  for (const auto& m : modules) {
    if (_stricmp(m.name.c_str(), moduleName.c_str()) == 0) {
      return Napi::String::New(env, ToHex(m.base));
    }
  }
  return env.Null();
}
