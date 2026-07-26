#include <napi.h>
#include "process_utils.h"
#include "scanner.h"
#include "pointer.h"
#include "memory_ops.h"
#include "write_watch.h"
#include "patch_ops.h"
#include "cave_ops.h"
#include "platform/platform.h"

#include <string>
#include <vector>

Napi::Value Ping(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "pong");
}

Napi::Value PlatformName(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  result.Set("name", Napi::String::New(env, platform::Name()));
  result.Set("supported", Napi::Boolean::New(env, platform::IsSupported()));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Cold-start workaround, confirmed reproducible on a clean tree (no
  // debug instrumentation) via tests/native/scanner.test.ts run in
  // isolation and a standalone ad-hoc probe script calling attach()
  // fresh: without this line,
  // the very first Napi::Number::New(...) created in a fresh addon
  // Environment (one per worker thread/process, since this addon is
  // context-aware) reads back on the JS side as a denormalized double
  // (e.g. attach()'s `handle` field arriving as ~3e-313 instead of a
  // small integer), which then breaks every downstream use of that
  // value (e.g. scanFirst's reinterpret_cast<HANDLE> becomes garbage
  // and VirtualQueryEx fails immediately, yielding zero candidates).
  // Every Number created after this first one is fine.
  //
  // Root cause is NOT understood — this is not V8/N-API's documented
  // behavior and no UB was found in this addon's code paths that would
  // explain it. Do not extend this pattern elsewhere without also
  // reproducing it there; treat it as a confirmed but unexplained
  // toolchain quirk, not a general N-API property.
  //
  // (An earlier version of this comment additionally cited
  // listProcesses()'s first entry showing pid: 0 as corruption
  // evidence. That was a misdiagnosis: pid 0 is the genuine PID of the
  // Windows System Idle Process, not a corrupted value. That evidence
  // has been retracted; only the handle-corruption reproduction above
  // is relied on.)
  Napi::Number::New(env, 0.0);

  exports.Set("ping", Napi::Function::New(env, Ping));
  exports.Set("listProcesses", Napi::Function::New(env, ListProcesses));
  exports.Set("attach", Napi::Function::New(env, Attach));
  exports.Set("scanFirst", Napi::Function::New(env, ScanFirst));
  exports.Set("scanNext", Napi::Function::New(env, ScanNext));
  exports.Set("resolvePointerChain", Napi::Function::New(env, ResolvePointerChain));
  exports.Set("getModuleBase", Napi::Function::New(env, GetModuleBase));
  exports.Set("readValue", Napi::Function::New(env, ReadValue));
  exports.Set("writeValue", Napi::Function::New(env, WriteValue));
  exports.Set("startWriteWatch", Napi::Function::New(env, StartWriteWatch));
  exports.Set("pollWriteWatch", Napi::Function::New(env, PollWriteWatch));
  exports.Set("stopWriteWatch", Napi::Function::New(env, StopWriteWatch));
  exports.Set("readBytes", Napi::Function::New(env, ReadBytes));
  exports.Set("writeBytes", Napi::Function::New(env, WriteBytes));
  exports.Set("scanAob", Napi::Function::New(env, ScanAob));
  exports.Set("platformName", Napi::Function::New(env, PlatformName));
  exports.Set("allocateCave", Napi::Function::New(env, AllocateCave));
  exports.Set("decodeRun", Napi::Function::New(env, DecodeRun));
  exports.Set("encodeStore", Napi::Function::New(env, EncodeStore));
  exports.Set("encodeJump", Napi::Function::New(env, EncodeJump));
  return exports;
}

NODE_API_MODULE(memory_addon, Init)
