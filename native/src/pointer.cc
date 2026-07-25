#include "pointer.h"
#include <windows.h>
#include <psapi.h>
#include <vector>
#include <string>
#include <cstdint>
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

// FindChain(target, levelsLeft) returns an offset list which, when resolved
// via the standard "deref all but the last offset" walk starting at
// moduleBase, lands exactly on `target` itself (not a dereference of it).
// That's the same invariant the exported offsets must satisfy per the task
// interface: *(moduleBase + offsets[0]) + offsets[1] ... == targetAddress,
// with the final offset added but not dereferenced.
//
// Base case: a pointer entry `e` whose stored value equals `target` and
// whose own address already sits inside the module (reachable from
// moduleBase with zero dereferences via [e.address - moduleBase]). To go
// from "address of e" to "value stored at e" (== target) requires exactly
// one more dereference. In offset-list terms, appending a trailing 0 makes
// the previously-last offset become non-last (so it gets dereferenced) and
// the new last offset (0) is added without dereferencing, landing on
// target. So the base case must return {e.address - moduleBase, 0}, not
// just {e.address - moduleBase} (which would land on the address of e, one
// dereference short of target).
//
// Recursive case: entry `e` whose value equals `target` but whose address
// is not itself in the module. Recurse to find `inner`, an offset list
// that lands on e.address (by the same invariant, applied to the smaller
// problem "reach e.address from moduleBase"). Since *e.address == target,
// appending a trailing 0 to `inner` forces one more dereference at the
// point that used to be `inner`'s last step, producing target — exactly
// mirroring the base case's fix.
std::optional<std::vector<uintptr_t>> FindChain(
    HANDLE h, uintptr_t moduleBase, uintptr_t moduleEnd,
    uintptr_t target, int levelsLeft, const std::vector<PointerEntry>& pointers) {
  for (const auto& e : pointers) {
    if (e.value != target) continue;
    if (e.address >= moduleBase && e.address < moduleEnd) {
      return std::vector<uintptr_t>{e.address - moduleBase, 0};
    }
    if (levelsLeft > 0) {
      auto inner = FindChain(h, moduleBase, moduleEnd, e.address, levelsLeft - 1, pointers);
      if (inner) {
        inner->push_back(0);
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
  uintptr_t moduleBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t target = ParseHex(info[2].As<Napi::String>().Utf8Value());
  int maxLevels = info[3].As<Napi::Number>().Int32Value();

  MODULEINFO modInfo{};
  HMODULE mod = reinterpret_cast<HMODULE>(moduleBase);
  GetModuleInformation(h, mod, &modInfo, sizeof(modInfo));
  uintptr_t moduleEnd = moduleBase + modInfo.SizeOfImage;

  auto pointers = CollectPointers(h);
  auto chain = FindChain(h, moduleBase, moduleEnd, target, maxLevels, pointers);

  if (!chain) return env.Null();

  Napi::Object result = Napi::Object::New(env);
  Napi::Array offsets = Napi::Array::New(env);
  for (size_t i = 0; i < chain->size(); i++) {
    offsets.Set((uint32_t)i, Napi::String::New(env, ToHex((*chain)[i])));
  }
  result.Set("offsets", offsets);
  return result;
}
