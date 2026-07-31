#pragma once
#include <napi.h>

// Resolves a MonoClass* by namespace + name, and a MonoClassField*'s offset
// or its own storage address, by making the target call its own Mono
// runtime's introspection functions on a throwaway attached thread. See
// mono_bridge.cc for the attach -> call -> detach sequence every export
// here shares.
Napi::Value MonoResolveClass(const Napi::CallbackInfo& info);
Napi::Value MonoResolveField(const Napi::CallbackInfo& info);
Napi::Value MonoStaticFieldAddress(const Napi::CallbackInfo& info);
