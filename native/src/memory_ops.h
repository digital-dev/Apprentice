#pragma once
#include <napi.h>

Napi::Value ReadValue(const Napi::CallbackInfo& info);
Napi::Value WriteValue(const Napi::CallbackInfo& info);
Napi::Value ResolveAddress(const Napi::CallbackInfo& info);
