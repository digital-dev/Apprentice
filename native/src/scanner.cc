#include "scanner.h"
#include <windows.h>
#include <vector>
#include <string>
#include <cstdint>

namespace {

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

std::string ToHex(uintptr_t addr) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)addr);
  return buf;
}

bool MatchesInt32(HANDLE h, uintptr_t addr, int32_t target) {
  int32_t buf;
  SIZE_T read;
  if (!ReadProcessMemory(h, (LPCVOID)addr, &buf, sizeof(buf), &read) || read != sizeof(buf))
    return false;
  return buf == target;
}

bool ReadInt32(HANDLE h, uintptr_t addr, int32_t* out) {
  SIZE_T read;
  return ReadProcessMemory(h, (LPCVOID)addr, out, sizeof(*out), &read) && read == sizeof(*out);
}

} // namespace

Napi::Value ScanFirst(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  std::string dataType = info[1].As<Napi::String>().Utf8Value();
  int32_t target = info[2].As<Napi::Number>().Int32Value();

  if (dataType != "int32") {
    Napi::Error::New(env, "only int32 supported in v1").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array result = Napi::Array::New(env);
  uint32_t count = 0;

  MEMORY_BASIC_INFORMATION mbi;
  uintptr_t addr = 0;
  while (VirtualQueryEx(h, (LPCVOID)addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
    bool readable = (mbi.State == MEM_COMMIT) &&
        (mbi.Protect & (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE)) &&
        !(mbi.Protect & PAGE_GUARD);

    if (readable) {
      for (uintptr_t p = (uintptr_t)mbi.BaseAddress;
           p + sizeof(int32_t) <= (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
           p += sizeof(int32_t)) {
        if (MatchesInt32(h, p, target)) {
          result.Set(count++, Napi::String::New(env, ToHex(p)));
        }
      }
    }

    uintptr_t next = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
    if (next <= addr) break; // guard against non-advancing regions
    addr = next;
  }

  return result;
}

Napi::Value ScanNext(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  Napi::Array addrs = info[1].As<Napi::Array>();
  // info[2] is dataType ('int32' | 'float') per the public signature
  // scanNext(handle, addresses, dataType, filter); only int32 is
  // supported in v1 (mirrors ScanFirst), so it is accepted but unused
  // beyond this point. The filter object is info[3].
  Napi::Object filter = info[3].As<Napi::Object>();
  std::string mode = filter.Get("mode").As<Napi::String>().Utf8Value();

  Napi::Array result = Napi::Array::New(env);
  uint32_t count = 0;

  for (uint32_t i = 0; i < addrs.Length(); i++) {
    uintptr_t addr = ParseHex(addrs.Get(i).As<Napi::String>().Utf8Value());
    int32_t current;
    if (!ReadInt32(h, addr, &current)) continue;

    bool keep = false;
    if (mode == "exact") {
      int32_t target = filter.Get("value").As<Napi::Number>().Int32Value();
      keep = current == target;
    } else {
      int32_t previous = filter.Get("previous").As<Napi::Array>()
                              .Get(i).As<Napi::Number>().Int32Value();
      if (mode == "changed") keep = current != previous;
      else if (mode == "unchanged") keep = current == previous;
      else if (mode == "increased") keep = current > previous;
      else if (mode == "decreased") keep = current < previous;
    }

    if (keep) result.Set(count++, Napi::String::New(env, ToHex(addr)));
  }

  return result;
}
