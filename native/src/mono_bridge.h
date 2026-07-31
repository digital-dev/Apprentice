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
// Finds a method by name on a class (mirrors the field-iterator shape
// above) and compiles it via mono_compile_method to get its live JIT entry
// address. The one export in this bridge that can force real JIT
// compilation of code the game hasn't run yet — callers must treat it as
// an explicit, deliberate action (enforced by later tasks' call sites, not
// here).
Napi::Value MonoCompileMethod(const Napi::CallbackInfo& info);
