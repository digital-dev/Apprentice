#include "module_info.h"
#include "platform/platform.h"
#include <vector>
#include <cstdio>

Napi::Value ListModules(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "listModules(handle) expects a number").ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));

  std::vector<platform::ModuleInfo> mods;
  if (!platform::ListModules(handle, mods)) {
    // Not an exception: a protected or exiting process is an expected
    // outcome, and the caller's answer to it is "cannot verify", not "crash".
    return Napi::Array::New(env);
  }

  Napi::Array result = Napi::Array::New(env);
  uint32_t i = 0;
  for (const auto& m : mods) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("name", Napi::String::New(env, m.name));
    char hex[32];
    snprintf(hex, sizeof(hex), "0x%llx", (unsigned long long)m.base);
    o.Set("base", Napi::String::New(env, hex));
    o.Set("size", Napi::Number::New(env, m.size));
    o.Set("timestamp", Napi::Number::New(env, m.timestamp));
    if (m.version.empty()) o.Set("version", env.Null());
    else o.Set("version", Napi::String::New(env, m.version));
    result.Set(i++, o);
  }
  return result;
}
