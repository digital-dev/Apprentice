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
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(env, "resolveExport(handle, moduleBase, name) expects (number, string, string)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t moduleBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  std::string name = info[2].As<Napi::String>().Utf8Value();

  uintptr_t addr = platform::ResolveExport(handle, moduleBase, name);
  if (addr == 0) return env.Null();
  return Napi::String::New(env, ToHex(addr));
}

// A simple, synchronous create-wait-close for this task's proof; Task 3's
// callRemoteFunction wraps the same three platform calls in an AsyncWorker
// so the interesting, potentially-slower version doesn't block Electron's
// main thread. This one exists to test CreateRemoteThread/WaitForRemote
// Thread/CloseRemoteThread in isolation, on a trivial one-argument target.
Napi::Value CreateRemoteThread(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(env, "createRemoteThread(handle, startAddress, param) expects (number, string, string)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t startAddress = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t param = ParseHex(info[2].As<Napi::String>().Utf8Value());

  platform::ThreadHandle thread = platform::CreateRemoteThread(handle, startAddress, param);
  if (thread == 0) return Napi::Boolean::New(env, false);

  bool ok = platform::WaitForRemoteThread(thread, 2000);
  platform::CloseRemoteThread(thread);
  return Napi::Boolean::New(env, ok);
}
