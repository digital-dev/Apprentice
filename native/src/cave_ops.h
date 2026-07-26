#pragma once
#include <napi.h>

Napi::Value AllocateCave(const Napi::CallbackInfo& info);
Napi::Value DecodeRun(const Napi::CallbackInfo& info);
Napi::Value EncodeStore(const Napi::CallbackInfo& info);
Napi::Value EncodeJump(const Napi::CallbackInfo& info);
