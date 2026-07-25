#pragma once
#include <napi.h>

Napi::Value ScanFirst(const Napi::CallbackInfo& info);
Napi::Value ScanNext(const Napi::CallbackInfo& info);
