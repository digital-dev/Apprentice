#pragma once
#include <napi.h>

Napi::Value ReadBytes(const Napi::CallbackInfo& info);
Napi::Value WriteBytes(const Napi::CallbackInfo& info);
