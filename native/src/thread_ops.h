#pragma once
#include <napi.h>

Napi::Value ListThreads(const Napi::CallbackInfo& info);
Napi::Value GetThreadRegisters(const Napi::CallbackInfo& info);
