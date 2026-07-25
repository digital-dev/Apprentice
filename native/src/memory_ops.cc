#include "memory_ops.h"
#include <windows.h>
#include <string>
#include <vector>
#include <cstdint>
#include <optional>

namespace {

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

std::optional<uintptr_t> ResolveChain(HANDLE h, uintptr_t base, const std::vector<uintptr_t>& offsets) {
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

std::vector<uintptr_t> ParseOffsets(const Napi::Array& arr) {
  std::vector<uintptr_t> out;
  for (uint32_t i = 0; i < arr.Length(); i++) {
    out.push_back(ParseHex(arr.Get(i).As<Napi::String>().Utf8Value()));
  }
  return out;
}

} // namespace

Napi::Value ReadValue(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t base = ParseHex(info[1].As<Napi::String>().Utf8Value());
  auto offsets = ParseOffsets(info[2].As<Napi::Array>());
  std::string dataType = info[3].As<Napi::String>().Utf8Value();

  auto addr = ResolveChain(h, base, offsets);
  if (!addr) {
    Napi::Error::New(env, "pointer chain did not resolve").ThrowAsJavaScriptException();
    return env.Null();
  }

  SIZE_T read;
  if (dataType == "int32") {
    int32_t v;
    if (!ReadProcessMemory(h, (LPCVOID)*addr, &v, sizeof(v), &read) || read != sizeof(v)) {
      Napi::Error::New(env, "ReadProcessMemory failed").ThrowAsJavaScriptException();
      return env.Null();
    }
    return Napi::Number::New(env, v);
  } else {
    float v;
    if (!ReadProcessMemory(h, (LPCVOID)*addr, &v, sizeof(v), &read) || read != sizeof(v)) {
      Napi::Error::New(env, "ReadProcessMemory failed").ThrowAsJavaScriptException();
      return env.Null();
    }
    return Napi::Number::New(env, v);
  }
}

Napi::Value WriteValue(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t base = ParseHex(info[1].As<Napi::String>().Utf8Value());
  auto offsets = ParseOffsets(info[2].As<Napi::Array>());
  std::string dataType = info[3].As<Napi::String>().Utf8Value();
  double value = info[4].As<Napi::Number>().DoubleValue();

  auto addr = ResolveChain(h, base, offsets);
  if (!addr) return Napi::Boolean::New(env, false);

  SIZE_T written;
  bool ok;
  if (dataType == "int32") {
    int32_t v = (int32_t)value;
    ok = WriteProcessMemory(h, (LPVOID)*addr, &v, sizeof(v), &written) && written == sizeof(v);
  } else {
    float v = (float)value;
    ok = WriteProcessMemory(h, (LPVOID)*addr, &v, sizeof(v), &written) && written == sizeof(v);
  }
  return Napi::Boolean::New(env, ok);
}
