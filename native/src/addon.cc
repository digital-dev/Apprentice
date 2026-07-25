#include <napi.h>
#include "process_utils.h"
#include "scanner.h"

Napi::Value Ping(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "pong");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Warm up N-API's double boxing: on this toolchain the very first
  // Napi::Number::New(...) created in the addon's lifetime reads back
  // as a corrupted (denormalized-looking) value on the JS side; every
  // subsequent Number is fine. Creating and discarding one harmless
  // number here absorbs that one-time cold start before any real
  // Number-returning export (attach's handle, listProcesses' pid, ...)
  // is called.
  Napi::Number::New(env, 0.0);

  exports.Set("ping", Napi::Function::New(env, Ping));
  exports.Set("listProcesses", Napi::Function::New(env, ListProcesses));
  exports.Set("attach", Napi::Function::New(env, Attach));
  exports.Set("scanFirst", Napi::Function::New(env, ScanFirst));
  exports.Set("scanNext", Napi::Function::New(env, ScanNext));
  return exports;
}

NODE_API_MODULE(memory_addon, Init)
