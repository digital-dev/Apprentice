#pragma once
#include <napi.h>

Napi::Value ListProcesses(const Napi::CallbackInfo& info);
Napi::Value Attach(const Napi::CallbackInfo& info);
Napi::Value Detach(const Napi::CallbackInfo& info);
