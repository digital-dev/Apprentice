#pragma once
#include <napi.h>

Napi::Value AllocateCave(const Napi::CallbackInfo& info);
Napi::Value DecodeRun(const Napi::CallbackInfo& info);
Napi::Value EncodeStore(const Napi::CallbackInfo& info);
Napi::Value EncodeCapture(const Napi::CallbackInfo& info);
Napi::Value EncodeJump(const Napi::CallbackInfo& info);
Napi::Value SuspendThreads(const Napi::CallbackInfo& info);
Napi::Value ResumeThreads(const Napi::CallbackInfo& info);
