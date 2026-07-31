#pragma once
#include <napi.h>

Napi::Value ResolveExport(const Napi::CallbackInfo& info);
Napi::Value CreateRemoteThread(const Napi::CallbackInfo& info);
