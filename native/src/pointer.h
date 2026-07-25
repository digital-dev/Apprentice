#pragma once
#include <napi.h>

Napi::Value ResolvePointerChain(const Napi::CallbackInfo& info);
Napi::Value GetModuleBase(const Napi::CallbackInfo& info);
