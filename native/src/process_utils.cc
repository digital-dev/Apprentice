#include "process_utils.h"
#include "platform/platform.h"
#include <cstdio>
#include <string>
#include <vector>

Napi::Value ListProcesses(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array result = Napi::Array::New(env);

  std::vector<platform::ProcessEntry> procs;
  if (!platform::ListProcesses(procs)) {
    Napi::Error::New(env, "CreateToolhelp32Snapshot failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  uint32_t i = 0;
  for (const auto& p : procs) {
    Napi::Object item = Napi::Object::New(env);
    item.Set("pid", Napi::Number::New(env, p.pid));
    item.Set("name", Napi::String::New(env, p.name));
    result.Set(i++, item);
  }
  return result;
}

Napi::Value Attach(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "attach(pid) expects a number").ThrowAsJavaScriptException();
    return env.Null();
  }
  uint32_t pid = info[0].As<Napi::Number>().Uint32Value();

  std::string error;
  platform::ProcessHandle process = platform::OpenProcess(pid, error);
  if (process == 0) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Null();
  }

  uintptr_t base = platform::MainModuleBase(process);
  if (base == 0) {
    platform::CloseProcess(process);
    Napi::Error::New(env, "EnumProcessModules failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("handle", Napi::Number::New(env, static_cast<double>(process)));
  char hex[32];
  snprintf(hex, sizeof(hex), "0x%llx", (unsigned long long)base);
  result.Set("baseAddress", Napi::String::New(env, hex));
  return result;
}

bool IsProcessAlive(uintptr_t handle) {
  return platform::IsAlive(handle);
}

// Always returns true: platform::CloseProcess is void, unlike the old CloseHandle result.
Napi::Value Detach(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "detach(handle) expects a number").ThrowAsJavaScriptException();
    return env.Null();
  }
  platform::CloseProcess(
      static_cast<platform::ProcessHandle>(info[0].As<Napi::Number>().Int64Value()));
  return Napi::Boolean::New(env, true);
}
