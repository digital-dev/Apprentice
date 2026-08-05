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
// Loop-driven name listers: the same iterator loop MonoResolveField/
// MonoCompileMethod already run, collecting every name instead of
// stopping at the first match.
Napi::Value MonoListFieldNames(const Napi::CallbackInfo& info);
Napi::Value MonoListMethodNames(const Napi::CallbackInfo& info);
// The one genuinely new mechanism in this bridge: mono_assembly_foreach is
// callback-based, so this injects a small collector stub the target calls
// INTO once per assembly, appending each result to a growable buffer read
// back once the top-level call returns. See mono_bridge.cc's
// BuildAssemblyCollectorStub for the hand-encoded bytes.
Napi::Value MonoListAssemblies(const Napi::CallbackInfo& info);
// Same assemblies as MonoListAssemblies, but each paired with a
// human-readable name (mono_image_get_name) instead of an opaque handle
// alone — for a UI picker, where a person needs to choose between them.
Napi::Value MonoListAssemblyNames(const Napi::CallbackInfo& info);
// Walks a chosen assembly's image's TypeDef metadata table (there is no
// callback-driven "for each class" the way mono_assembly_foreach exists
// for assemblies) to list every (namespace, className) pair in it.
Napi::Value MonoListClassesInImage(const Napi::CallbackInfo& info);

// Calls an arbitrary function (game code, not just Mono's own embedding
// API) with up to 4 pointer-sized args, on one continuous injected thread
// that attaches to Mono first and detaches after — the same fix every
// other export in this bridge already required, extended to calls that
// aren't Mono API calls themselves. See ResolveClassSingleThread's comment
// in mono_bridge.cc for why calling into Mono from an unattached thread is
// unsafe; a managed method's body (e.g. Character.GetHealth(), which
// itself calls into a ZDO lookup) makes exactly the same kind of call this
// whole redesign exists to make safe. Returns both the integer result
// (RAX) and the float result (XMM0, as a 32-bit float) — the caller reads
// whichever one the target function actually returns.
Napi::Value MonoCallAttached(const Napi::CallbackInfo& info);
