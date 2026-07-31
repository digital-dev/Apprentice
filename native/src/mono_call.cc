#include "mono_call.h"
#include "platform/platform.h"
#include <cstdio>
#include <string>

namespace {
uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}
std::string ToHex(uintptr_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}
} // namespace

Napi::Value ResolveExport(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t moduleBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  std::string name = info[2].As<Napi::String>().Utf8Value();

  uintptr_t addr = platform::ResolveExport(handle, moduleBase, name);
  if (addr == 0) return env.Null();
  return Napi::String::New(env, ToHex(addr));
}
