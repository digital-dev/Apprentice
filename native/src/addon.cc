#include <napi.h>
#include "process_utils.h"

Napi::Value Ping(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "pong");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("ping", Napi::Function::New(env, Ping));
  exports.Set("listProcesses", Napi::Function::New(env, ListProcesses));
  return exports;
}

NODE_API_MODULE(memory_addon, Init)
