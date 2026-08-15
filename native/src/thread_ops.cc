#include "thread_ops.h"
#include "platform/platform.h"
#include <cstdio>
#include <string>
#include <vector>

namespace {
std::string Hex(uint64_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}
} // namespace

Napi::Value ListThreads(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "listThreads(pid) expects a number").ThrowAsJavaScriptException();
    return env.Null();
  }
  uint32_t pid = info[0].As<Napi::Number>().Uint32Value();

  std::vector<platform::ThreadInfo> threads;
  if (!platform::ListThreads(pid, threads)) {
    // Not an exception: an unsupported platform or a snapshot that
    // couldn't be taken both read as "no threads to report" — same
    // "cannot verify" convention ListModules already follows.
    return Napi::Array::New(env);
  }

  Napi::Array result = Napi::Array::New(env);
  uint32_t i = 0;
  for (const auto& t : threads) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("tid", Napi::Number::New(env, t.tid));
    result.Set(i++, o);
  }
  return result;
}

Napi::Value GetThreadRegisters(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "getThreadRegisters(tid) expects a number")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  uint32_t tid = info[0].As<Napi::Number>().Uint32Value();

  platform::ThreadRegisters regs;
  if (!platform::GetThreadRegisters(tid, regs)) {
    // The thread exited between listThreads() and this call, or the
    // platform doesn't support it. Not an error: the renderer's poll
    // treats null as "this thread is gone, pick another", not a crash.
    return env.Null();
  }

  Napi::Object o = Napi::Object::New(env);
  o.Set("rax", Napi::String::New(env, Hex(regs.rax)));
  o.Set("rbx", Napi::String::New(env, Hex(regs.rbx)));
  o.Set("rcx", Napi::String::New(env, Hex(regs.rcx)));
  o.Set("rdx", Napi::String::New(env, Hex(regs.rdx)));
  o.Set("rsi", Napi::String::New(env, Hex(regs.rsi)));
  o.Set("rdi", Napi::String::New(env, Hex(regs.rdi)));
  o.Set("rbp", Napi::String::New(env, Hex(regs.rbp)));
  o.Set("rsp", Napi::String::New(env, Hex(regs.rsp)));
  o.Set("rip", Napi::String::New(env, Hex(regs.rip)));
  o.Set("r8", Napi::String::New(env, Hex(regs.r8)));
  o.Set("r9", Napi::String::New(env, Hex(regs.r9)));
  o.Set("r10", Napi::String::New(env, Hex(regs.r10)));
  o.Set("r11", Napi::String::New(env, Hex(regs.r11)));
  o.Set("r12", Napi::String::New(env, Hex(regs.r12)));
  o.Set("r13", Napi::String::New(env, Hex(regs.r13)));
  o.Set("r14", Napi::String::New(env, Hex(regs.r14)));
  o.Set("r15", Napi::String::New(env, Hex(regs.r15)));
  o.Set("rflags", Napi::String::New(env, Hex(regs.rflags)));
  return o;
}
