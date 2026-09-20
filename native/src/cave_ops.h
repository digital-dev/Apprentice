#pragma once
#include <napi.h>

Napi::Value AllocateCave(const Napi::CallbackInfo& info);
Napi::Value FreeCave(const Napi::CallbackInfo& info);
Napi::Value DecodeRun(const Napi::CallbackInfo& info);
// Decode half of DecodeRun over an already-read buffer.
Napi::Object DecodeRunBuffer(Napi::Env env, const uint8_t* window, size_t got, size_t minBytes);
Napi::Value EncodeStore(const Napi::CallbackInfo& info);
Napi::Value EncodeStoreRegister(const Napi::CallbackInfo& info);
Napi::Value EncodeScale(const Napi::CallbackInfo& info);
Napi::Value EncodeConditionalScale(const Napi::CallbackInfo& info);
Napi::Value EncodeCaptureOnce(const Napi::CallbackInfo& info);
Napi::Value EncodeGuardedSkip(const Napi::CallbackInfo& info);
Napi::Value EncodeImmuneGuard(const Napi::CallbackInfo& info);
Napi::Value EncodeJump(const Napi::CallbackInfo& info);
Napi::Value SuspendThreads(const Napi::CallbackInfo& info);
Napi::Value ResumeThreads(const Napi::CallbackInfo& info);
