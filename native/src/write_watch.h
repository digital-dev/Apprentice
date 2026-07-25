#pragma once
#include <napi.h>

Napi::Value StartWriteWatch(const Napi::CallbackInfo& info);
Napi::Value PollWriteWatch(const Napi::CallbackInfo& info);
Napi::Value StopWriteWatch(const Napi::CallbackInfo& info);
