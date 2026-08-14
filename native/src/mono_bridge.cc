#include "mono_bridge.h"
#include "mono_call.h"
#include "platform/platform.h"
#include <cstdio>
#include <cstring>
#include <exception>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}
std::string ToHex(uintptr_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}
uintptr_t BytesToPtr(const uint8_t b[8]) {
  uintptr_t v = 0;
  memcpy(&v, b, 8);
  return v;
}

uintptr_t WriteString(platform::ProcessHandle handle, uintptr_t near, const std::string& s) {
  uintptr_t cave = platform::AllocateNear(handle, near, 256);
  if (!cave) return 0;
  std::vector<char> buf(s.begin(), s.end());
  buf.push_back('\0');
  if (!platform::WriteMemory(handle, cave, buf.data(), buf.size())) {
    // No thread has touched this cave yet — nothing ran, safe to free.
    platform::FreeMemory(handle, cave);
    return 0;
  }
  return cave;
}

// The attach/detach pairing every bridge call needs. Returns the root
// domain and the attached thread handle, or 0/0 on failure — a caller that
// gets 0/0 must not proceed to any further call.
struct MonoContext {
  uintptr_t rootDomain = 0;
  uintptr_t attachedThread = 0;
  bool ok = false;
};

MonoContext AttachToMono(platform::ProcessHandle handle, uintptr_t monoDllBase) {
  MonoContext ctx;
  uintptr_t getRootDomain = platform::ResolveExport(handle, monoDllBase, "mono_get_root_domain");
  uintptr_t threadAttach = platform::ResolveExport(handle, monoDllBase, "mono_thread_attach");
  if (!getRootDomain || !threadAttach) return ctx;

  uint8_t result[8] = {0};
  if (!RunRemoteCall(handle, getRootDomain, {}, result)) return ctx;
  ctx.rootDomain = BytesToPtr(result);
  if (!ctx.rootDomain) return ctx;

  if (!RunRemoteCall(handle, threadAttach, {ctx.rootDomain}, result)) return ctx;
  ctx.attachedThread = BytesToPtr(result);
  if (!ctx.attachedThread) return ctx;

  ctx.ok = true;
  return ctx;
}

void DetachFromMono(platform::ProcessHandle handle, uintptr_t monoDllBase, const MonoContext& ctx) {
  if (!ctx.ok) return;
  uintptr_t threadDetach = platform::ResolveExport(handle, monoDllBase, "mono_thread_detach");
  if (!threadDetach) return;
  uint8_t ignored[8];
  RunRemoteCall(handle, threadDetach, {ctx.attachedThread}, ignored);
}

// Forward-declared here, defined below alongside BuildAssemblyCollectorStub
// (which it's built from) — MonoResolveClassWorker needs it and is defined
// earlier in the file than that stub. Every loaded MonoAssembly* handle,
// via the same callback-collector mechanism MonoListAssembliesWorker uses;
// factored out so the delicate hand-encoded stub logic exists in exactly
// one place. `ctx` must already be a successful AttachToMono() result.
std::vector<uintptr_t> EnumerateAssemblies(platform::ProcessHandle handle, uintptr_t monoDllBase,
                                           const MonoContext& ctx);

// Forward-declared here for the same reason as EnumerateAssemblies above;
// defined below alongside BuildResolveClassStub. Runs mono_get_root_domain,
// mono_thread_attach, mono_assembly_foreach (to enumerate assemblies),
// mono_assembly_get_image + mono_class_from_name per assembly, and
// mono_thread_detach — ALL on one continuous injected thread, from attach
// to detach, never handing off between threads in between. Returns the
// resolved class handle, or 0 if not found or any resolution step failed.
// `nsAddr`/`nameAddr` must already be valid remote string pointers.
//
// This does NOT take a MonoContext / run inside an AttachToMono(...)/
// DetachFromMono(...) pair — it is its own complete attach-work-detach
// cycle, on purpose. See the comment on its definition for why.
uintptr_t ResolveClassSingleThread(platform::ProcessHandle handle, uintptr_t monoDllBase,
                                    uintptr_t nsAddr, uintptr_t nameAddr);

// Forward-declared here for the same reason as the two above; defined
// below alongside BuildMemberSearchStub. Shared by field resolution and
// method compilation: both are "attach, iterate a class's fields/methods
// by name, optionally call one more function on the match, detach" — the
// same shape as ResolveClassSingleThread, on one continuous thread for the
// same reason (see that function's comment). `getItemsExport` is
// "mono_class_get_fields" or "mono_class_get_methods"; `getNameExport` is
// "mono_field_get_name" or "mono_method_get_name"; `finishExport` is
// "mono_field_get_offset" or "mono_compile_method" to call the matched
// item through one more function before returning its result, or "" to
// return the matched item's own address unchanged — a MonoClassField* or
// MonoMethod*'s own metadata-descriptor address, NOT where a static
// field's actual value lives at runtime. A static field's real storage
// needs the field's OFFSET (finishExport = "mono_field_get_offset") added
// to its class's static-data blob base (see StaticDataBaseSingleThread,
// below) — monoStaticFieldAddress composes the two rather than ever
// asking this function for a field's raw "" address.
uintptr_t ResolveMemberSingleThread(platform::ProcessHandle handle, uintptr_t monoDllBase,
                                    uintptr_t classHandle, const std::string& getItemsExport,
                                    const std::string& getNameExport, const std::string& finishExport,
                                    const std::string& targetName);

// Forward-declared here for the same reason as the others above; defined
// below alongside BuildStaticDataBaseStub. mono_class_vtable(domain,
// classHandle) -> mono_vtable_get_static_field_data(vtable) -> that
// class's static-data blob base for the current domain — add a static
// field's own offset (from ResolveMemberSingleThread's "mono_field_get_
// offset" path) to get where its value actually lives. Returns 0 on any
// resolution failure.
uintptr_t StaticDataBaseSingleThread(platform::ProcessHandle handle, uintptr_t monoDllBase,
                                     uintptr_t classHandle);

// Forward-declared here for the same reason as the others above; defined
// below alongside BuildMemberListStub. Attach, collect EVERY field/method
// name on `classHandle` (no search, no early exit — this is what backs the
// Mono Explorer's browsable list), detach: one continuous thread. Replaces
// a version that, like the pre-fix MonoResolveClassWorker, called
// AttachToMono on one throwaway thread and then made metadata calls from
// others — reached and crashed live through the Explorer UI (resolve a
// class, then immediately list its fields/methods).
std::vector<std::string> ListMemberNamesSingleThread(platform::ProcessHandle handle, uintptr_t monoDllBase,
                                                     uintptr_t classHandle, const std::string& getItemsExport,
                                                     const std::string& getNameExport);

// Forward-declared here for the same reason as the others above; defined
// below alongside BuildListAssemblyNamesStub. Attach, enumerate every
// assembly (the same foreach-collector EnumerateAssemblies uses), then for
// each one call mono_assembly_get_image + mono_image_get_name to get a
// human-readable label, detach — one continuous thread. Backs a UI
// assembly picker: an opaque assembly handle alone (what
// EnumerateAssemblies/monoListAssemblies already expose) isn't something a
// person can choose between.
std::vector<std::pair<uintptr_t, std::string>> ListAssemblyNamesSingleThread(platform::ProcessHandle handle,
                                                                              uintptr_t monoDllBase);

// One TypeDef row's resolved identity: the class's own name/namespace
// (a person picks a class by these) AND the classHandle mono_class_get
// already produced to get them (a caller resolves BY, e.g. Explorer's own
// "Use as value target"/"Use as patch anchor" hand-off). Returning the
// handle here means a class found by BROWSING never needs a second,
// separate, ambiguous name-only resolveClass call to use it — the exact
// bug that silently resolved the wrong same-named class (e.g. the
// compiler-generated "<>c" closure class, or an unrelated "Player" in a
// different assembly) over and over while building a search index or
// jumping to a browsed class.
struct ClassEntry {
  std::string namespaceName;
  std::string className;
  uintptr_t classHandle;
};

// Forward-declared here for the same reason as the others above; defined
// below alongside BuildListClassesStub. Attach, walk every row of
// `imageHandle`'s TypeDef metadata table (mono_image_get_table_info +
// mono_table_info_get_rows + mono_class_get per row — there is no
// callback-driven "for each class" the way mono_assembly_foreach exists
// for assemblies), collecting each class's name, namespace, AND its own
// resolved classHandle (mono_class_get's own return value — no separate
// resolve needed to use it), detach — one continuous thread. `imageHandle`
// must be a real MonoImage* (e.g. from mono_assembly_get_image, as
// ListAssemblyNamesSingleThread's result already gives).
std::vector<ClassEntry> ListClassesInImageSingleThread(
    platform::ProcessHandle handle, uintptr_t monoDllBase, uintptr_t imageHandle);

} // namespace

class MonoResolveClassWorker : public Napi::AsyncWorker {
 public:
  MonoResolveClassWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase,
                         std::string namespaceName, std::string className)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase),
        namespaceName_(std::move(namespaceName)), className_(std::move(className)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // binding.gyp defines NAPI_DISABLE_CPP_EXCEPTIONS, so node-addon-api does
  // NOT wrap Execute() in a try/catch — an escaped C++ exception on this
  // libuv worker thread calls std::terminate and kills the whole Electron
  // process. SetError routes to OnError instead. Pure safety net: the
  // success path is unchanged. Same shape as scanner.cc/pointer.cc.
  void Execute() override {
    try {
      Run();
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error");
    }
  }

  void Run() {
    // Real mono_class_from_name takes a MonoImage*, not a domain — and a
    // class lives in exactly one assembly's image, which we don't know in
    // advance. Enumerate every loaded assembly and try each one's image in
    // turn, stopping at the first match. Passing a null image is not a
    // safe fallback to try first — Mono's own mono_class_from_name has no
    // documented guarantee it null-checks its image argument.
    //
    // Unlike every other worker in this file, this one does NOT call
    // AttachToMono/DetachFromMono here — ResolveClassSingleThread does its
    // own complete attach-work-detach cycle, on ONE continuous injected
    // thread, and that thread identity is load-bearing: an isolated live
    // test found that mono_assembly_get_image alone, called from a thread
    // that never itself called mono_thread_attach, does not fail cleanly —
    // it HANGS (RunRemoteCall's thread never finishes, timing out at its
    // 2-second wait), leaking a permanently-blocked thread inside the
    // target that took the whole game down shortly afterward. Every prior
    // version of this code (including an earlier "single thread for the
    // search loop" rewrite that still called AttachToMono separately
    // first) attached on one throwaway thread that exited immediately,
    // then made metadata calls from OTHER, never-attached threads — which
    // is the actual bug: Mono's attach/detach contract is per-thread, and
    // every call in between must happen on the thread that attached.
    // mono_assembly_foreach's callback-driven walk (what
    // monoListAssemblies and EnumerateAssemblies use) is the one exception
    // that has never shown this problem even when called from an
    // unattached thread — so it's safe to keep using unchanged elsewhere,
    // but it's also folded into this single continuous thread below rather
    // than relying on that as a hard guarantee.
    uintptr_t nsAddr = WriteString(handle_, monoDllBase_, namespaceName_);
    uintptr_t nameAddr = WriteString(handle_, monoDllBase_, className_);
    if (!nsAddr || !nameAddr) {
      // Whichever of the two succeeded was never handed to any thread —
      // free it now rather than leaking it.
      if (nsAddr) platform::FreeMemory(handle_, nsAddr);
      if (nameAddr) platform::FreeMemory(handle_, nameAddr);
      return;
    }

    // ResolveClassSingleThread owns freeing nsAddr/nameAddr from here on:
    // it has full local visibility into its own RunRemoteCall result (this
    // caller does not), so it can gate those frees exactly the way it
    // already gates freeing its own cave — freed on every path that never
    // started a thread or that confirmed the thread finished, left
    // unfreed (leaked) on the one path that can't rule out the thread
    // still running.
    uintptr_t classHandle = ResolveClassSingleThread(handle_, monoDllBase_, nsAddr, nameAddr);
    if (classHandle) { classHandle_ = classHandle; ok_ = true; }
  }

  void OnOK() override {
    if (!ok_) { deferred_.Resolve(Env().Null()); return; }
    deferred_.Resolve(Napi::String::New(Env(), ToHex(classHandle_)));
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Env().Null()); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_;
  std::string namespaceName_, className_;
  bool ok_ = false;
  uintptr_t classHandle_ = 0;
  Napi::Promise::Deferred deferred_;
};

Napi::Value MonoResolveClass(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsString() ||
      !info[2].IsString() || !info[3].IsString()) {
    Napi::TypeError::New(
        env, "monoResolveClass(handle, monoDllBase, namespaceName, className) expects (number, string, string, string)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  std::string namespaceName = info[2].As<Napi::String>().Utf8Value();
  std::string className = info[3].As<Napi::String>().Utf8Value();

  auto* worker = new MonoResolveClassWorker(env, handle, monoDllBase, namespaceName, className);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class MonoResolveFieldWorker : public Napi::AsyncWorker {
 public:
  MonoResolveFieldWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase,
                         uintptr_t classHandle, std::string fieldName, bool wantAddress)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase),
        classHandle_(classHandle), fieldName_(std::move(fieldName)), wantAddress_(wantAddress),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // binding.gyp defines NAPI_DISABLE_CPP_EXCEPTIONS, so node-addon-api does
  // NOT wrap Execute() in a try/catch — an escaped C++ exception on this
  // libuv worker thread calls std::terminate and kills the whole Electron
  // process. SetError routes to OnError instead. Pure safety net: the
  // success path is unchanged. Same shape as scanner.cc/pointer.cc.
  void Execute() override {
    try {
      Run();
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error");
    }
  }

  void Run() {
    // Attach, iterate, and call mono_field_get_offset on the match, all on
    // one continuous injected thread, via ResolveMemberSingleThread — see
    // ResolveClassSingleThread's comment for why per-call throwaway threads
    // calling Mono metadata functions is unsafe. Always resolves the
    // OFFSET now (never the field's own "" metadata address — see
    // ResolveMemberSingleThread's comment on why that was never the right
    // answer for a static field's actual storage location).
    uintptr_t item = ResolveMemberSingleThread(
        handle_, monoDllBase_, classHandle_, "mono_class_get_fields", "mono_field_get_name",
        "mono_field_get_offset", fieldName_);
    if (!item) return;
    if (!wantAddress_) {
      ok_ = true;
      offset_ = static_cast<int32_t>(item);
      return;
    }
    // wantAddress_: compose the static-data blob base with this offset —
    // the two-step indirection an actual static field's value needs (see
    // StaticDataBaseSingleThread's comment). A second attach/detach cycle,
    // not folded into one stub with the field walk above: the field search
    // and the vtable/static-data lookup are independent operations sharing
    // no state, and keeping ResolveMemberSingleThread generic (usable for
    // methods too, which have no static-data concept at all) matters more
    // than saving one attach round-trip here.
    uintptr_t staticBase = StaticDataBaseSingleThread(handle_, monoDllBase_, classHandle_);
    if (!staticBase) return;
    ok_ = true;
    fieldAddress_ = staticBase + static_cast<int32_t>(item);
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (!ok_) { deferred_.Resolve(env.Null()); return; }
    if (wantAddress_) {
      deferred_.Resolve(Napi::String::New(env, ToHex(fieldAddress_)));
      return;
    }
    Napi::Object out = Napi::Object::New(env);
    out.Set("offset", Napi::Number::New(env, offset_));
    deferred_.Resolve(out);
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Env().Null()); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_, classHandle_;
  std::string fieldName_;
  bool wantAddress_;
  bool ok_ = false;
  int32_t offset_ = 0;
  uintptr_t fieldAddress_ = 0;
  Napi::Promise::Deferred deferred_;
};

namespace {
bool ValidateFieldArgs(const Napi::CallbackInfo& info, const char* usage) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsString() ||
      !info[2].IsString() || !info[3].IsString()) {
    Napi::TypeError::New(env, usage).ThrowAsJavaScriptException();
    return false;
  }
  return true;
}
} // namespace

Napi::Value MonoResolveField(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!ValidateFieldArgs(
          info,
          "monoResolveField(handle, monoDllBase, classHandle, fieldName) expects (number, string, string, string)")) {
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t classHandle = ParseHex(info[2].As<Napi::String>().Utf8Value());
  std::string fieldName = info[3].As<Napi::String>().Utf8Value();

  auto* worker = new MonoResolveFieldWorker(env, handle, monoDllBase, classHandle, fieldName, false);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value MonoStaticFieldAddress(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!ValidateFieldArgs(
          info,
          "monoStaticFieldAddress(handle, monoDllBase, classHandle, fieldName) expects (number, string, string, string)")) {
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t classHandle = ParseHex(info[2].As<Napi::String>().Utf8Value());
  std::string fieldName = info[3].As<Napi::String>().Utf8Value();

  auto* worker = new MonoResolveFieldWorker(env, handle, monoDllBase, classHandle, fieldName, true);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class MonoCompileMethodWorker : public Napi::AsyncWorker {
 public:
  MonoCompileMethodWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase,
                          uintptr_t classHandle, std::string methodName)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase),
        classHandle_(classHandle), methodName_(std::move(methodName)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // binding.gyp defines NAPI_DISABLE_CPP_EXCEPTIONS, so node-addon-api does
  // NOT wrap Execute() in a try/catch — an escaped C++ exception on this
  // libuv worker thread calls std::terminate and kills the whole Electron
  // process. SetError routes to OnError instead. Pure safety net: the
  // success path is unchanged. Same shape as scanner.cc/pointer.cc.
  void Execute() override {
    try {
      Run();
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error");
    }
  }

  void Run() {
    // Attach, iterate methods, and call mono_compile_method on the match —
    // all on one continuous injected thread. See
    // ResolveClassSingleThread's comment for why.
    uintptr_t entry = ResolveMemberSingleThread(
        handle_, monoDllBase_, classHandle_, "mono_class_get_methods", "mono_method_get_name",
        "mono_compile_method", methodName_);
    if (entry) { entryAddress_ = entry; ok_ = true; }
  }

  void OnOK() override {
    if (!ok_) { deferred_.Resolve(Env().Null()); return; }
    deferred_.Resolve(Napi::String::New(Env(), ToHex(entryAddress_)));
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Env().Null()); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_, classHandle_;
  std::string methodName_;
  bool ok_ = false;
  uintptr_t entryAddress_ = 0;
  Napi::Promise::Deferred deferred_;
};

Napi::Value MonoCompileMethod(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!ValidateFieldArgs(
          info,
          "monoCompileMethod(handle, monoDllBase, classHandle, methodName) expects (number, string, string, string)")) {
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t classHandle = ParseHex(info[2].As<Napi::String>().Utf8Value());
  std::string methodName = info[3].As<Napi::String>().Utf8Value();

  auto* worker = new MonoCompileMethodWorker(env, handle, monoDllBase, classHandle, methodName);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

namespace {
bool ValidateClassArgs(const Napi::CallbackInfo& info, const char* usage) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(env, usage).ThrowAsJavaScriptException();
    return false;
  }
  return true;
}
} // namespace

class MonoListFieldNamesWorker : public Napi::AsyncWorker {
 public:
  MonoListFieldNamesWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase,
                           uintptr_t classHandle)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase), classHandle_(classHandle),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // binding.gyp defines NAPI_DISABLE_CPP_EXCEPTIONS, so node-addon-api does
  // NOT wrap Execute() in a try/catch — an escaped C++ exception on this
  // libuv worker thread calls std::terminate and kills the whole Electron
  // process. SetError routes to OnError instead. Pure safety net: the
  // success path is unchanged. Same shape as scanner.cc/pointer.cc.
  void Execute() override {
    try {
      Run();
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error");
    }
  }

  void Run() {
    // Attach, walk every field (no early exit — every item is collected),
    // detach: all on one continuous injected thread, via
    // ListMemberNamesSingleThread. See ResolveClassSingleThread's comment
    // for why per-call throwaway threads calling Mono metadata functions
    // is unsafe — this worker used to be exactly that pattern and was the
    // direct cause of a live crash reached through the Mono Explorer UI
    // (resolve a class, then immediately list its fields/methods).
    names_ = ListMemberNamesSingleThread(handle_, monoDllBase_, classHandle_,
                                          "mono_class_get_fields", "mono_field_get_name");
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array out = Napi::Array::New(env, names_.size());
    for (size_t i = 0; i < names_.size(); i++) out.Set((uint32_t)i, Napi::String::New(env, names_[i]));
    deferred_.Resolve(out);
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Napi::Array::New(Env(), 0)); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_, classHandle_;
  std::vector<std::string> names_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value MonoListFieldNames(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!ValidateClassArgs(
          info, "monoListFieldNames(handle, monoDllBase, classHandle) expects (number, string, string)")) {
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t classHandle = ParseHex(info[2].As<Napi::String>().Utf8Value());

  auto* worker = new MonoListFieldNamesWorker(env, handle, monoDllBase, classHandle);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class MonoListMethodNamesWorker : public Napi::AsyncWorker {
 public:
  MonoListMethodNamesWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase,
                            uintptr_t classHandle)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase), classHandle_(classHandle),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // binding.gyp defines NAPI_DISABLE_CPP_EXCEPTIONS, so node-addon-api does
  // NOT wrap Execute() in a try/catch — an escaped C++ exception on this
  // libuv worker thread calls std::terminate and kills the whole Electron
  // process. SetError routes to OnError instead. Pure safety net: the
  // success path is unchanged. Same shape as scanner.cc/pointer.cc.
  void Execute() override {
    try {
      Run();
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error");
    }
  }

  void Run() {
    // Same rewrite as MonoListFieldNamesWorker, for the same reason — see
    // its comment.
    names_ = ListMemberNamesSingleThread(handle_, monoDllBase_, classHandle_,
                                          "mono_class_get_methods", "mono_method_get_name");
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array out = Napi::Array::New(env, names_.size());
    for (size_t i = 0; i < names_.size(); i++) out.Set((uint32_t)i, Napi::String::New(env, names_[i]));
    deferred_.Resolve(out);
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Napi::Array::New(Env(), 0)); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_, classHandle_;
  std::vector<std::string> names_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value MonoListMethodNames(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!ValidateClassArgs(
          info, "monoListMethodNames(handle, monoDllBase, classHandle) expects (number, string, string)")) {
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t classHandle = ParseHex(info[2].As<Napi::String>().Utf8Value());

  auto* worker = new MonoListMethodNamesWorker(env, handle, monoDllBase, classHandle);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

namespace {

// mono_assembly_foreach's callback signature: void (__stdcall*)(void* data,
// void* userData). This stub is what Mono calls, once per assembly. It
// appends `data` to a growable list in memory: a count at userData+0,
// followed by up to kMaxAssemblies pointer-sized slots starting at
// userData+8 — a fixed cap, matching the bounded-list pattern ListModules
// already uses, rather than unbounded/dynamic growth inside injected code.
//
// 64 was the original cap, sized for the single-assembly fake test host.
// Running this against real Valheim during the sub-project's own
// acceptance pass found it silently truncating: a real Unity/Mono game
// loads on the order of a couple hundred assemblies (mscorlib, System.*,
// Unity.*, then the game's own), so 64 never reached the game's own
// assembly at all — Player/Character were unreachable, not merely slow to
// find. 1024 matches ListModules' own precedent for "generous enough that
// truncation in practice is not a real concern."
constexpr uint32_t kMaxAssemblies = 1024;

// Concretely: RCX = data (the MonoAssembly*), RDX = userData (our buffer).
// Buffer layout: [0..8) = count (uint64), [8 + count*8 ..) = next slot.
//
// Hand-traced byte-by-byte before dispatch (see progress.md) and again
// during implementation: JAE (0x73), not JA (0x77) — a count of exactly
// kMaxAssemblies must be rejected, not fall through, or slots[kMaxAssemblies]
// writes one past the buffer into this stub's own code (stubAddr sits
// immediately after the buffer). REX 0x49 (REX.B=1 extends the SIB base
// r8, REX.X=0 leaves the SIB index as rax), not 0x4A — swapped, the store
// silently retargets from [r8 + rax*8] to [rax + r8*8], a wild address
// write. The cap check itself must be a 32-bit immediate (`81 /7 id`, not
// `83 /7 ib`) once the cap exceeds 127 — an imm8 CMP sign-extends its
// operand, so 128-255 would compare as NEGATIVE, corrupting the check
// entirely rather than just being the wrong number.
//
//   mov rax, [rdx]            48 8B 02                -- rax = count
//   cmp rax, kMaxAssemblies    48 81 F8 <imm32 LE>     -- cap check
//   jae done                   73 0E                   -- rel8=14: byte
//                                                          count of every
//                                                          instruction
//                                                          between here and
//                                                          `ret` — UNCHANGED
//                                                          by the cmp's
//                                                          longer encoding,
//                                                          since the jae's
//                                                          own displacement
//                                                          is measured from
//                                                          AFTER the jae
//                                                          instruction, not
//                                                          from the cmp
//   lea r8, [rdx+8]            4C 8D 42 08             -- r8 = &slots[0]
//   mov [r8+rax*8], rcx        49 89 0C C0             -- slots[count]=data
//   inc rax                    48 FF C0
//   mov [rdx], rax             48 89 02                -- count += 1
// done:
//   ret                        C3
std::vector<uint8_t> BuildAssemblyCollectorStub() {
  std::vector<uint8_t> out = {
    0x48, 0x8B, 0x02,                                     // mov rax, [rdx]
    0x48, 0x81, 0xF8,
    static_cast<uint8_t>(kMaxAssemblies & 0xFF),
    static_cast<uint8_t>((kMaxAssemblies >> 8) & 0xFF),
    static_cast<uint8_t>((kMaxAssemblies >> 16) & 0xFF),
    static_cast<uint8_t>((kMaxAssemblies >> 24) & 0xFF), // cmp rax, kMaxAssemblies
    0x73, 0x0E,                         // jae +0x0E (to `ret`, 14 bytes ahead)
    0x4C, 0x8D, 0x42, 0x08,             // lea r8, [rdx+8]
    0x49, 0x89, 0x0C, 0xC0,             // mov [r8+rax*8], rcx
    0x48, 0xFF, 0xC0,                   // inc rax
    0x48, 0x89, 0x02,                   // mov [rdx], rax
    0xC3,                               // ret
  };
  return out;
}

// Definition of the function forward-declared near AttachToMono/
// DetachFromMono — MonoResolveClassWorker (defined earlier in this file)
// needs it, but it's built from BuildAssemblyCollectorStub/kMaxAssemblies,
// which live here. `ctx` must already be attached; this does not
// attach/detach itself, so callers already inside an AttachToMono/
// DetachFromMono pair (as every caller is) don't pay for a second one.
std::vector<uintptr_t> EnumerateAssemblies(platform::ProcessHandle handle, uintptr_t monoDllBase,
                                           const MonoContext& ctx) {
  if (!ctx.ok) return {};

  uintptr_t foreach_ = platform::ResolveExport(handle, monoDllBase, "mono_assembly_foreach");
  if (!foreach_) return {};

  // Buffer: 8-byte count + kMaxAssemblies pointer-sized slots, right after
  // the collector stub's own code in the same cave.
  uintptr_t cave = platform::AllocateNear(handle, monoDllBase, 8 + kMaxAssemblies * 8 + 64);
  if (!cave) return {};
  uintptr_t bufferAddr = cave;
  uintptr_t stubAddr = cave + 8 + kMaxAssemblies * 8;

  uintptr_t zero = 0;
  platform::WriteMemory(handle, bufferAddr, &zero, sizeof(zero));
  std::vector<uint8_t> stub = BuildAssemblyCollectorStub();
  if (!platform::WriteMemory(handle, stubAddr, stub.data(), stub.size())) {
    // No thread has been created yet — safe to free immediately.
    platform::FreeMemory(handle, cave);
    return {};
  }

  uint8_t ignored[8];
  // RunRemoteCall returns false either because the call never got going or
  // because its 2-second wait timed out — and on timeout it does NOT
  // terminate the injected thread (see mono_call.cc: the cave is
  // deliberately leaked rather than freed out from under a thread that
  // might still be running inside it). That distinction matters more here
  // than anywhere else in this file: the collector stub the injected thread
  // executes lives INSIDE this cave, and the buffer it writes into is in
  // this cave too. Freeing it while that thread is still running would rip
  // out code the target process is executing and memory it is writing —
  // an access violation in the GAME, not in us.
  //
  // So: the buffer is still READ either way (a partially-filled collector
  // buffer is the pre-existing behavior and is harmless — the count field
  // is only ever incremented after a slot is written), but the cave is
  // FREED only when RunRemoteCall returned true, i.e. the thread provably
  // finished. Otherwise the cave is leaked, exactly as every other
  // RunRemoteCall site in this file does.
  bool finished = RunRemoteCall(handle, foreach_, {stubAddr, bufferAddr}, ignored);

  uint64_t count = 0;
  platform::ReadMemory(handle, bufferAddr, &count, sizeof(count));
  if (count > kMaxAssemblies) count = kMaxAssemblies;
  std::vector<uintptr_t> slots(count);
  if (count > 0) {
    platform::ReadMemory(handle, bufferAddr + 8, slots.data(), count * sizeof(uintptr_t));
  }
  if (finished) platform::FreeMemory(handle, cave);
  return slots;
}

// mono_get_root_domain, mono_thread_attach, mono_assembly_foreach (via the
// SAME collector-callback mechanism EnumerateAssemblies uses), a per-
// assembly mono_assembly_get_image + mono_class_from_name search, and
// mono_thread_detach — one hand-encoded straight-line-plus-loop stub, run
// to completion by exactly one RunRemoteCall (one CreateRemoteThread),
// with everything from attach to detach on that single thread.
//
// This exists because two prior designs both crashed the game against
// real Mono, and an isolated live test explained why: an earlier version
// called AttachToMono/DetachFromMono (their own throwaway thread each,
// exiting immediately after) and then made metadata calls — even funneled
// through one shared thread for the calls themselves — from a thread that
// had never itself called mono_thread_attach. Calling
// mono_assembly_get_image alone that way doesn't fail cleanly: it hangs
// (RunRemoteCall's 2-second wait times out, and the now-permanently-
// blocked thread is leaked inside the target, since freeing a cave a live
// thread might still be running in is worse). The game died shortly after,
// every time. Mono's attach/detach contract is per-thread: every call
// after attach must happen on the thread that attached, until that same
// thread detaches. This stub is the fix — attach, do all the work, detach,
// never leaving that one thread.
//
// Nested calls use the same sub rsp,0x28 / call / add rsp,0x28 pattern
// BuildCallStub in mono_call.cc uses, for the same reason: at entry (via
// RunRemoteCall's own outer call to this stub) RSP sits 8 mod 16 — the
// exact precondition BuildCallStub's thread-entry case documents — and
// that invariant holds after every add rsp,0x28 here too, so it's safe to
// repeat for each of the five calls this stub makes in sequence.
//
// Register usage across the whole stub, relying on the Win64 ABI's
// guarantee that an ordinary callee (every Mono export called here)
// preserves RBX and R12-R15:
//   r15 — the attached MonoThread*, set once after mono_thread_attach,
//         needed again at the very end for mono_thread_detach
//   r14 — the resolved class handle, stashed here so the detach call
//         (which clobbers rax) doesn't lose it
//   rbx — &slots[0] (assembly pointer array, filled in by the foreach
//         collector callback before the loop starts)
//   r12 — loop index i
//   r13 — assembly count, read from the buffer AFTER the foreach call,
//         since (unlike the removed single-loop-only version) it isn't
//         known until this stub has actually enumerated them itself
//
//   mov rax, getRootDomainFn   48 B8 <imm64>
//   sub rsp, 0x28              48 83 EC 28
//   call rax                   FF D0
//   add rsp, 0x28              48 83 C4 28
//   mov rcx, rax               48 89 C1            -- rcx = rootDomain
//   mov rax, threadAttachFn    48 B8 <imm64>
//   sub rsp, 0x28              48 83 EC 28
//   call rax                   FF D0
//   add rsp, 0x28              48 83 C4 28
//   mov r15, rax                49 89 C7            -- save attached thread
//   mov rcx, collectorStubAddr  48 B9 <imm64>
//   mov rdx, bufferAddr          48 BA <imm64>
//   mov rax, foreachFn           48 B8 <imm64>
//   sub rsp, 0x28                 48 83 EC 28
//   call rax                      FF D0
//   add rsp, 0x28                 48 83 C4 28
//   mov rax, bufferAddr            48 B8 <imm64>
//   mov r13, [rax]                  4C 8B 28          -- r13 = count
//   xor r12, r12                     4D 31 E4          -- i = 0
//   mov rbx, slotsAddr                 48 BB <imm64>
// loop:
//   cmp r12, r13                       4D 39 EC
//   jae not_found                       73 <+0x7C>      -- i >= count
//   mov rcx, [rbx+r12*8]                 4A 8B 0C E3    -- rcx = slots[i]
//   mov rax, getImageFn                   48 B8 <imm64>
//   sub rsp, 0x28                          48 83 EC 28
//   call rax                               FF D0
//   add rsp, 0x28                          48 83 C4 28
//   test rax, rax                          48 85 C0
//   jz skip                                 74 <+0x30>   -- null image, try next
//   mov rcx, rax                            48 89 C1     -- rcx = image
//   mov rdx, nsAddr                          48 BA <imm64>
//   mov r8,  nameAddr                         49 B8 <imm64>
//   mov rax, classFromNameFn                  48 B8 <imm64>
//   sub rsp, 0x28                              48 83 EC 28
//   call rax                                   FF D0
//   add rsp, 0x28                               48 83 C4 28
//   test rax, rax                               48 85 C0
//   jnz found                                    75 <+0x05>
// skip:
//   inc r12                                       49 FF C4
//   jmp loop                                        EB <-0x57>
// found:
//   mov r14, rax                                    49 89 C6   -- save result
//   mov rcx, r15                                     4C 89 F9  -- rcx = attached thread
//   mov rax, threadDetachFn                           48 B8 <imm64>
//   sub rsp, 0x28                                      48 83 EC 28
//   call rax                                           FF D0
//   add rsp, 0x28                                       48 83 C4 28
//   mov rcx, resultAddress                               48 B9 <imm64>
//   mov [rcx], r14                                        4C 89 31  -- *result = classHandle
//   xor eax, eax                                           31 C0
//   ret                                                     C3
// not_found:
//   mov rcx, r15                                            4C 89 F9
//   mov rax, threadDetachFn                                  48 B8 <imm64>
//   sub rsp, 0x28                                             48 83 EC 28
//   call rax                                                  FF D0
//   add rsp, 0x28                                              48 83 C4 28
//   mov rcx, resultAddress                                      48 B9 <imm64>
//   mov qword [rcx], 0                                           48 C7 01 00000000
//   xor eax, eax                                                  31 C0
//   ret                                                            C3
//
// All jumps are short (rel8): the whole stub is 284 bytes and every
// displacement above was computed by hand against that fixed byte layout
// (each instruction's length is constant regardless of the immediates'
// actual values), then verified against the fake-host test suite before
// ever running against a real game.
std::vector<uint8_t> BuildResolveClassStub(uintptr_t getRootDomainFn, uintptr_t threadAttachFn,
                                            uintptr_t threadDetachFn, uintptr_t foreachFn,
                                            uintptr_t getImageFn, uintptr_t classFromNameFn,
                                            uintptr_t collectorStubAddr, uintptr_t bufferAddr,
                                            uintptr_t slotsAddr, uintptr_t nsAddr, uintptr_t nameAddr,
                                            uintptr_t resultAddress) {
  std::vector<uint8_t> out;
  auto emitMovImm64 = [&](uint8_t rex, uint8_t opcodeByte, uintptr_t imm) {
    out.push_back(rex);
    out.push_back(opcodeByte);
    for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>(imm >> (i * 8)));
  };
  auto emitCall = [&](uintptr_t fn) {
    emitMovImm64(0x48, 0xB8, fn);                      // mov rax, fn
    out.insert(out.end(), {0x48, 0x83, 0xEC, 0x28});   // sub rsp, 0x28
    out.insert(out.end(), {0xFF, 0xD0});               // call rax
    out.insert(out.end(), {0x48, 0x83, 0xC4, 0x28});   // add rsp, 0x28
  };

  emitCall(getRootDomainFn);
  out.insert(out.end(), {0x48, 0x89, 0xC1});           // mov rcx, rax
  emitCall(threadAttachFn);
  out.insert(out.end(), {0x49, 0x89, 0xC7});           // mov r15, rax

  emitMovImm64(0x48, 0xB9, collectorStubAddr);         // mov rcx, collectorStubAddr
  emitMovImm64(0x48, 0xBA, bufferAddr);                // mov rdx, bufferAddr
  emitCall(foreachFn);

  emitMovImm64(0x48, 0xB8, bufferAddr);                // mov rax, bufferAddr
  out.insert(out.end(), {0x4C, 0x8B, 0x28});           // mov r13, [rax]
  out.insert(out.end(), {0x4D, 0x31, 0xE4});           // xor r12, r12
  emitMovImm64(0x48, 0xBB, slotsAddr);                 // mov rbx, slotsAddr

  // loop:
  out.insert(out.end(), {0x4D, 0x39, 0xEC});           // cmp r12, r13
  out.insert(out.end(), {0x73, 0x7C});                 // jae not_found (+0x7C)
  out.insert(out.end(), {0x4A, 0x8B, 0x0C, 0xE3});     // mov rcx, [rbx+r12*8]
  emitCall(getImageFn);
  out.insert(out.end(), {0x48, 0x85, 0xC0});           // test rax, rax
  out.insert(out.end(), {0x74, 0x30});                 // jz skip (+0x30)
  out.insert(out.end(), {0x48, 0x89, 0xC1});           // mov rcx, rax
  emitMovImm64(0x48, 0xBA, nsAddr);                    // mov rdx, nsAddr
  emitMovImm64(0x49, 0xB8, nameAddr);                  // mov r8,  nameAddr
  emitCall(classFromNameFn);
  out.insert(out.end(), {0x48, 0x85, 0xC0});           // test rax, rax
  out.insert(out.end(), {0x75, 0x05});                 // jnz found (+0x05)
  // skip:
  out.insert(out.end(), {0x49, 0xFF, 0xC4});           // inc r12
  out.insert(out.end(), {0xEB, 0xA9});                 // jmp loop (-0x57)
  // found:
  out.insert(out.end(), {0x49, 0x89, 0xC6});           // mov r14, rax
  out.insert(out.end(), {0x4C, 0x89, 0xF9});           // mov rcx, r15
  emitCall(threadDetachFn);
  emitMovImm64(0x48, 0xB9, resultAddress);             // mov rcx, resultAddress
  out.insert(out.end(), {0x4C, 0x89, 0x31});           // mov [rcx], r14
  out.insert(out.end(), {0x31, 0xC0});                 // xor eax, eax
  out.push_back(0xC3);                                 // ret
  // not_found:
  out.insert(out.end(), {0x4C, 0x89, 0xF9});           // mov rcx, r15
  emitCall(threadDetachFn);
  emitMovImm64(0x48, 0xB9, resultAddress);             // mov rcx, resultAddress
  out.insert(out.end(), {0x48, 0xC7, 0x01, 0x00, 0x00, 0x00, 0x00}); // mov qword [rcx], 0
  out.insert(out.end(), {0x31, 0xC0});                 // xor eax, eax
  out.push_back(0xC3);                                 // ret

  return out;
}

// Definition of the function forward-declared near AttachToMono/
// DetachFromMono. Builds and runs BuildResolveClassStub above in one cave:
// [0..8) result slot, [8..) the foreach collector's count+slots buffer
// (same layout EnumerateAssemblies' cave uses), then the collector stub's
// own code (reused from BuildAssemblyCollectorStub — same trusted
// callback, not reimplemented), then this stub's code.
uintptr_t ResolveClassSingleThread(platform::ProcessHandle handle, uintptr_t monoDllBase,
                                    uintptr_t nsAddr, uintptr_t nameAddr) {
  uintptr_t getRootDomain = platform::ResolveExport(handle, monoDllBase, "mono_get_root_domain");
  uintptr_t threadAttach = platform::ResolveExport(handle, monoDllBase, "mono_thread_attach");
  uintptr_t threadDetach = platform::ResolveExport(handle, monoDllBase, "mono_thread_detach");
  uintptr_t foreach_ = platform::ResolveExport(handle, monoDllBase, "mono_assembly_foreach");
  uintptr_t getImage = platform::ResolveExport(handle, monoDllBase, "mono_assembly_get_image");
  uintptr_t classFromName = platform::ResolveExport(handle, monoDllBase, "mono_class_from_name");
  if (!getRootDomain || !threadAttach || !threadDetach || !foreach_ || !getImage || !classFromName) {
    return 0;
  }

  std::vector<uint8_t> collectorStub = BuildAssemblyCollectorStub();

  uintptr_t cave = platform::AllocateNear(
      handle, monoDllBase, 8 + 8 + kMaxAssemblies * 8 + collectorStub.size() + 320);
  if (!cave) return 0;
  uintptr_t resultAddr = cave;
  uintptr_t bufferAddr = cave + 8;
  uintptr_t slotsAddr = bufferAddr + 8;
  uintptr_t collectorStubAddr = bufferAddr + 8 + kMaxAssemblies * 8;
  uintptr_t mainStubAddr = collectorStubAddr + collectorStub.size();

  uint64_t zero = 0;
  if (!platform::WriteMemory(handle, resultAddr, &zero, sizeof(zero)) ||
      !platform::WriteMemory(handle, bufferAddr, &zero, sizeof(zero)) ||
      !platform::WriteMemory(handle, collectorStubAddr, collectorStub.data(), collectorStub.size())) {
    // No thread has been created yet — safe to free immediately. nsAddr/
    // nameAddr (the caller's WriteString results, consumed only by the
    // stub this function is about to build) are equally untouched by any
    // thread at this point, so this function — which has full visibility
    // into whether that thread ever started — owns freeing them too,
    // rather than leaving it to a caller with no such visibility.
    platform::FreeMemory(handle, cave);
    platform::FreeMemory(handle, nsAddr);
    platform::FreeMemory(handle, nameAddr);
    return 0;
  }

  std::vector<uint8_t> mainStub = BuildResolveClassStub(
      getRootDomain, threadAttach, threadDetach, foreach_, getImage, classFromName,
      collectorStubAddr, bufferAddr, slotsAddr, nsAddr, nameAddr, resultAddr);
  if (!platform::WriteMemory(handle, mainStubAddr, mainStub.data(), mainStub.size())) {
    platform::FreeMemory(handle, cave);
    platform::FreeMemory(handle, nsAddr);
    platform::FreeMemory(handle, nameAddr);
    return 0;
  }

  // One RunRemoteCall — one CreateRemoteThread — runs attach, enumerate,
  // search, and detach to completion; its own return value (RAX at the
  // stub's `ret`, always 0) is discarded, since the real answer was
  // written to resultAddr by the stub itself.
  uint8_t ignored[8];
  // Never free on a false return here: this only fails via the timeout
  // path (every failure above this point already returned), which means
  // the thread may still be executing inside `cave` — and may still be
  // reading nsAddr/nameAddr via classFromName — see the
  // never-free-a-live-cave rule. Leak all three together.
  if (!RunRemoteCall(handle, mainStubAddr, {}, ignored)) return 0;

  uint64_t result = 0;
  platform::ReadMemory(handle, resultAddr, &result, sizeof(result));
  platform::FreeMemory(handle, cave);
  platform::FreeMemory(handle, nsAddr);
  platform::FreeMemory(handle, nameAddr);
  return static_cast<uintptr_t>(result);
}

// mono_get_root_domain, mono_thread_attach, then a bounded (256-iteration)
// walk of a class's fields or methods — via mono_class_get_fields/methods'
// same caller-owned-iterator pattern the old per-call-thread version used
// — comparing each item's name (read via mono_field_get_name /
// mono_method_get_name) against `targetNameAddr` with a hand-encoded
// byte-by-byte strcmp, stopping at the first match; then, if `finishFn` is
// nonzero, calling it on the match (mono_field_get_offset or
// mono_compile_method) and using ITS result, or the match's own address
// unchanged if `finishFn` is 0; then mono_thread_detach. All of it on one
// continuous injected thread. Same motivation as BuildResolveClassStub
// above — see its comment.
//
// Unlike BuildResolveClassStub, this stub's length isn't a fixed constant:
// whether the finish-call block is emitted depends on `finishFn`, a
// runtime argument. Every jump here is therefore built as a near
// (rel32) Jcc/JMP with a placeholder displacement, recorded in `fixups`
// alongside the label it targets, and patched to the real displacement
// only after the whole stub (and therefore every label's final offset) has
// been emitted — rel32 rather than rel8 specifically because the
// jae-to-not_found jump alone spans over 150 bytes in the worst case
// (finish call present), well past rel8's ±127 range.
//
// Register usage, relying on the same Win64 ABI callee-preserves-RBX/R12-
// R15 guarantee BuildResolveClassStub's comment explains:
//   r15 — attached MonoThread*, needed again at the end for detach
//   r14 — iteration guard counter (0..256)
//   r12 — the current field/method pointer being tested
//   r13 — the final result value, stashed before the detach call (which
//         clobbers rax) so it survives to the very end
//   rsi/rdi — strcmp cursors (item's name pointer / targetNameAddr)
//
//   mov rax, getRootDomainFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov rcx, rax                                             -- rootDomain
//   mov rax, threadAttachFn  ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov r15, rax                                              -- attached thread
//   xor r14, r14                                              -- guard = 0
// loop_a:
//   cmp r14, 256
//   jae not_found                        (near)
//   inc r14
//   mov rcx, classHandle
//   mov rdx, iterSlotAddr
//   mov rax, getItemsFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   test rax, rax
//   jz not_found                          (near)               -- iteration exhausted
//   mov r12, rax                                                -- item
//   mov rcx, r12
//   mov rax, getNameFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov rsi, rax                                                 -- namePtr
//   mov rdi, targetNameAddr
// strcmp_b:
//   mov al, [rsi]
//   mov bl, [rdi]
//   cmp al, bl
//   jne loop_a                             (near)                 -- mismatch: next item
//   test al, al
//   jz found                                (near)                 -- equal AND both NUL: match
//   inc rsi
//   inc rdi
//   jmp strcmp_b                             (near)
// found:
//   [if finishFn: mov rcx, r12 ; mov rax, finishFn ; sub rsp,0x28 ;
//    call rax ; add rsp,0x28 ; mov r13, rax]
//   [else:        mov r13, r12]
//   mov rcx, r15
//   mov rax, threadDetachFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov rcx, resultAddress
//   mov [rcx], r13
//   xor eax, eax
//   ret
// not_found:
//   mov rcx, r15
//   mov rax, threadDetachFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov rcx, resultAddress
//   mov qword [rcx], 0
//   xor eax, eax
//   ret
//
// Verified functionally against the fake host (both the finish-call and
// no-finish-call shapes, and both the match and no-match paths) before
// ever running against a real game.
std::vector<uint8_t> BuildMemberSearchStub(uintptr_t getRootDomainFn, uintptr_t threadAttachFn,
                                            uintptr_t threadDetachFn, uintptr_t getItemsFn,
                                            uintptr_t getNameFn, uintptr_t finishFn,
                                            uintptr_t classHandle, uintptr_t iterSlotAddr,
                                            uintptr_t targetNameAddr, uintptr_t resultAddress,
                                            uint32_t guardLimit) {
  std::vector<uint8_t> out;
  auto emitMovImm64 = [&](uint8_t rex, uint8_t opcodeByte, uintptr_t imm) {
    out.push_back(rex);
    out.push_back(opcodeByte);
    for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>(imm >> (i * 8)));
  };
  auto emitCall = [&](uintptr_t fn) {
    emitMovImm64(0x48, 0xB8, fn);                      // mov rax, fn
    out.insert(out.end(), {0x48, 0x83, 0xEC, 0x28});   // sub rsp, 0x28
    out.insert(out.end(), {0xFF, 0xD0});               // call rax
    out.insert(out.end(), {0x48, 0x83, 0xC4, 0x28});   // add rsp, 0x28
  };

  enum Label { kLoopA, kNotFound, kStrcmpB, kFound };
  std::unordered_map<int, size_t> labelOffset;
  std::vector<std::pair<size_t, int>> fixups; // (offset of rel32 field, target label)

  auto mark = [&](int label) { labelOffset[label] = out.size(); };
  // Always a near (0F 8x / E9) jump with a 4-byte rel32 placeholder: this
  // stub's length depends on a runtime argument (finishFn), so a jump's
  // span cannot be hand-verified to fit rel8's short range the way the
  // other, fixed-shape stubs in this file do.
  auto emitJump = [&](uint8_t shortOpcode, int label) {
    if (shortOpcode == 0xEB) {
      out.push_back(0xE9);
    } else {
      out.push_back(0x0F);
      out.push_back(static_cast<uint8_t>(shortOpcode + 0x10)); // 0x73->0x83 etc: short Jcc -> near Jcc
    }
    fixups.push_back({out.size(), label});
    out.insert(out.end(), {0x00, 0x00, 0x00, 0x00});
  };

  emitCall(getRootDomainFn);
  out.insert(out.end(), {0x48, 0x89, 0xC1});           // mov rcx, rax
  emitCall(threadAttachFn);
  out.insert(out.end(), {0x49, 0x89, 0xC7});           // mov r15, rax
  out.insert(out.end(), {0x4D, 0x31, 0xF6});           // xor r14, r14

  mark(kLoopA);
  out.insert(out.end(), {0x49, 0x81, 0xFE,             // cmp r14, guardLimit
                          static_cast<uint8_t>(guardLimit & 0xFF),
                          static_cast<uint8_t>((guardLimit >> 8) & 0xFF),
                          static_cast<uint8_t>((guardLimit >> 16) & 0xFF),
                          static_cast<uint8_t>((guardLimit >> 24) & 0xFF)});
  emitJump(0x73, kNotFound);                           // jae not_found
  out.insert(out.end(), {0x49, 0xFF, 0xC6});           // inc r14
  emitMovImm64(0x48, 0xB9, classHandle);               // mov rcx, classHandle
  emitMovImm64(0x48, 0xBA, iterSlotAddr);              // mov rdx, iterSlotAddr
  emitCall(getItemsFn);
  out.insert(out.end(), {0x48, 0x85, 0xC0});           // test rax, rax
  emitJump(0x74, kNotFound);                           // jz not_found (exhausted)
  out.insert(out.end(), {0x49, 0x89, 0xC4});           // mov r12, rax
  out.insert(out.end(), {0x4C, 0x89, 0xE1});           // mov rcx, r12
  emitCall(getNameFn);
  out.insert(out.end(), {0x48, 0x89, 0xC6});           // mov rsi, rax
  emitMovImm64(0x48, 0xBF, targetNameAddr);            // mov rdi, targetNameAddr

  mark(kStrcmpB);
  out.insert(out.end(), {0x8A, 0x06});                 // mov al, [rsi]
  out.insert(out.end(), {0x8A, 0x1F});                 // mov bl, [rdi]
  out.insert(out.end(), {0x38, 0xD8});                 // cmp al, bl
  emitJump(0x75, kLoopA);                              // jne loop_a (mismatch, next item)
  out.insert(out.end(), {0x84, 0xC0});                 // test al, al
  emitJump(0x74, kFound);                              // jz found (equal AND both NUL)
  out.insert(out.end(), {0x48, 0xFF, 0xC6});           // inc rsi
  out.insert(out.end(), {0x48, 0xFF, 0xC7});           // inc rdi
  emitJump(0xEB, kStrcmpB);                            // jmp strcmp_b

  mark(kFound);
  if (finishFn) {
    out.insert(out.end(), {0x4C, 0x89, 0xE1});         // mov rcx, r12
    emitCall(finishFn);
    out.insert(out.end(), {0x49, 0x89, 0xC5});         // mov r13, rax
  } else {
    out.insert(out.end(), {0x4D, 0x89, 0xE5});         // mov r13, r12
  }
  out.insert(out.end(), {0x4C, 0x89, 0xF9});           // mov rcx, r15
  emitCall(threadDetachFn);
  emitMovImm64(0x48, 0xB9, resultAddress);             // mov rcx, resultAddress
  out.insert(out.end(), {0x4C, 0x89, 0x29});           // mov [rcx], r13
  out.insert(out.end(), {0x31, 0xC0});                 // xor eax, eax
  out.push_back(0xC3);                                 // ret

  mark(kNotFound);
  out.insert(out.end(), {0x4C, 0x89, 0xF9});           // mov rcx, r15
  emitCall(threadDetachFn);
  emitMovImm64(0x48, 0xB9, resultAddress);             // mov rcx, resultAddress
  out.insert(out.end(), {0x48, 0xC7, 0x01, 0x00, 0x00, 0x00, 0x00}); // mov qword [rcx], 0
  out.insert(out.end(), {0x31, 0xC0});                 // xor eax, eax
  out.push_back(0xC3);                                 // ret

  for (auto& fx : fixups) {
    size_t pos = fx.first;
    int32_t rel = static_cast<int32_t>(labelOffset[fx.second]) - static_cast<int32_t>(pos + 4);
    out[pos + 0] = static_cast<uint8_t>(rel & 0xFF);
    out[pos + 1] = static_cast<uint8_t>((rel >> 8) & 0xFF);
    out[pos + 2] = static_cast<uint8_t>((rel >> 16) & 0xFF);
    out[pos + 3] = static_cast<uint8_t>((rel >> 24) & 0xFF);
  }

  return out;
}

uintptr_t ResolveMemberSingleThread(platform::ProcessHandle handle, uintptr_t monoDllBase,
                                    uintptr_t classHandle, const std::string& getItemsExport,
                                    const std::string& getNameExport, const std::string& finishExport,
                                    const std::string& targetName) {
  uintptr_t getRootDomain = platform::ResolveExport(handle, monoDllBase, "mono_get_root_domain");
  uintptr_t threadAttach = platform::ResolveExport(handle, monoDllBase, "mono_thread_attach");
  uintptr_t threadDetach = platform::ResolveExport(handle, monoDllBase, "mono_thread_detach");
  uintptr_t getItems = platform::ResolveExport(handle, monoDllBase, getItemsExport);
  uintptr_t getName = platform::ResolveExport(handle, monoDllBase, getNameExport);
  uintptr_t finishFn = 0;
  if (!finishExport.empty()) {
    finishFn = platform::ResolveExport(handle, monoDllBase, finishExport);
    if (!finishFn) return 0;
  }
  if (!getRootDomain || !threadAttach || !threadDetach || !getItems || !getName) return 0;

  uintptr_t nameAddr = WriteString(handle, monoDllBase, targetName);
  if (!nameAddr) return 0;

  uintptr_t cave = platform::AllocateNear(handle, monoDllBase, 8 + 8 + 512);
  if (!cave) {
    platform::FreeMemory(handle, nameAddr);
    return 0;
  }
  uintptr_t resultAddr = cave;
  uintptr_t iterSlotAddr = cave + 8;
  uintptr_t stubAddr = cave + 16;

  uint64_t zero = 0;
  if (!platform::WriteMemory(handle, resultAddr, &zero, sizeof(zero)) ||
      !platform::WriteMemory(handle, iterSlotAddr, &zero, sizeof(zero))) {
    // No thread has been created yet — safe to free both immediately.
    platform::FreeMemory(handle, cave);
    platform::FreeMemory(handle, nameAddr);
    return 0;
  }

  std::vector<uint8_t> stub = BuildMemberSearchStub(getRootDomain, threadAttach, threadDetach,
                                                     getItems, getName, finishFn, classHandle,
                                                     iterSlotAddr, nameAddr, resultAddr, 256);
  if (!platform::WriteMemory(handle, stubAddr, stub.data(), stub.size())) {
    platform::FreeMemory(handle, cave);
    platform::FreeMemory(handle, nameAddr);
    return 0;
  }

  uint8_t ignored[8];
  // Never free on a false return: the thread may still be executing inside
  // `cave`, or still reading `nameAddr` via its strcmp against the target
  // name — see the never-free-a-live-cave rule. Leak both, same as above.
  if (!RunRemoteCall(handle, stubAddr, {}, ignored)) return 0;

  uint64_t result = 0;
  platform::ReadMemory(handle, resultAddr, &result, sizeof(result));
  platform::FreeMemory(handle, cave);
  platform::FreeMemory(handle, nameAddr);
  return static_cast<uintptr_t>(result);
}

// mono_get_root_domain, mono_thread_attach, mono_class_vtable(domain,
// classHandle) -> vtable, mono_vtable_get_static_field_data(vtable) -> the
// class's static-data BLOB base for the current domain, mono_thread_detach.
// One continuous injected thread, same motivation as every other
// SingleThread function in this file.
//
// This is NOT the same address as a MonoClassField*'s own pointer (what a
// plain field lookup returns) — a MonoClassField describes the field
// (name, type, offset into this blob), it is not where the field's VALUE
// lives at runtime. Reading a static field's actual current value needs
// this blob's base PLUS the field's own offset (mono_field_get_offset,
// already resolved correctly elsewhere in this file) — the two-step
// vtable/static-data-blob indirection real Mono embedding requires for any
// static field, not just this codebase's own invention. Returning the
// field's own metadata address instead of this (an earlier version of
// MonoStaticFieldAddress did exactly that) reads back as a real, stable,
// plausible-looking pointer every time — Mono's own internal MonoType*
// describing the field's declared type, most likely — while being
// numerically nothing to do with any actual game object. It never fails
// or looks wrong on inspection; it is simply answering a different
// question than the one being asked.
//
//   [attach]
//   mov rcx, domain              -- from mono_get_root_domain, saved earlier
//   mov rdx, classHandle
//   mov rax, classVtableFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov rcx, rax                                        -- vtable
//   mov rax, staticDataFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov r14, rax                                         -- static data base
//   [detach]
//   mov rcx, resultAddress
//   mov [rcx], r14
//   xor eax, eax
//   ret
std::vector<uint8_t> BuildStaticDataBaseStub(uintptr_t getRootDomainFn, uintptr_t threadAttachFn,
                                              uintptr_t threadDetachFn, uintptr_t classVtableFn,
                                              uintptr_t staticDataFn, uintptr_t classHandle,
                                              uintptr_t resultAddress) {
  std::vector<uint8_t> out;
  auto emitMovImm64 = [&](uint8_t rex, uint8_t opcodeByte, uintptr_t imm) {
    out.push_back(rex);
    out.push_back(opcodeByte);
    for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>(imm >> (i * 8)));
  };
  auto emitCall = [&](uintptr_t fn) {
    emitMovImm64(0x48, 0xB8, fn);                      // mov rax, fn
    out.insert(out.end(), {0x48, 0x83, 0xEC, 0x28});   // sub rsp, 0x28
    out.insert(out.end(), {0xFF, 0xD0});               // call rax
    out.insert(out.end(), {0x48, 0x83, 0xC4, 0x28});   // add rsp, 0x28
  };

  emitCall(getRootDomainFn);
  out.insert(out.end(), {0x49, 0x89, 0xC7});           // mov r15, rax  -- domain, survives the next call
  out.insert(out.end(), {0x4C, 0x89, 0xF9});           // mov rcx, r15
  emitCall(threadAttachFn);
  out.insert(out.end(), {0x49, 0x89, 0xC6});           // mov r14, rax  -- attached MonoThread*, survives too

  out.insert(out.end(), {0x4C, 0x89, 0xF9});           // mov rcx, r15  -- domain
  emitMovImm64(0x48, 0xBA, classHandle);               // mov rdx, classHandle
  emitCall(classVtableFn);
  out.insert(out.end(), {0x48, 0x89, 0xC1});           // mov rcx, rax  -- vtable
  emitCall(staticDataFn);
  out.insert(out.end(), {0x49, 0x89, 0xC7});           // mov r15, rax  -- static data base, survives detach

  out.insert(out.end(), {0x4C, 0x89, 0xF1});           // mov rcx, r14  -- attached MonoThread*
  emitCall(threadDetachFn);
  emitMovImm64(0x48, 0xB9, resultAddress);             // mov rcx, resultAddress
  out.insert(out.end(), {0x4C, 0x89, 0x39});           // mov [rcx], r15
  out.insert(out.end(), {0x31, 0xC0});                 // xor eax, eax
  out.push_back(0xC3);                                 // ret

  return out;
}

uintptr_t StaticDataBaseSingleThread(platform::ProcessHandle handle, uintptr_t monoDllBase,
                                      uintptr_t classHandle) {
  uintptr_t getRootDomain = platform::ResolveExport(handle, monoDllBase, "mono_get_root_domain");
  uintptr_t threadAttach = platform::ResolveExport(handle, monoDllBase, "mono_thread_attach");
  uintptr_t threadDetach = platform::ResolveExport(handle, monoDllBase, "mono_thread_detach");
  uintptr_t classVtable = platform::ResolveExport(handle, monoDllBase, "mono_class_vtable");
  uintptr_t staticData = platform::ResolveExport(handle, monoDllBase, "mono_vtable_get_static_field_data");
  if (!getRootDomain || !threadAttach || !threadDetach || !classVtable || !staticData) return 0;

  uintptr_t cave = platform::AllocateNear(handle, monoDllBase, 8 + 256);
  if (!cave) return 0;
  uintptr_t resultAddr = cave;
  uintptr_t stubAddr = cave + 8;

  uint64_t zero = 0;
  if (!platform::WriteMemory(handle, resultAddr, &zero, sizeof(zero))) {
    platform::FreeMemory(handle, cave);
    return 0;
  }

  std::vector<uint8_t> stub = BuildStaticDataBaseStub(getRootDomain, threadAttach, threadDetach,
                                                        classVtable, staticData, classHandle, resultAddr);
  if (!platform::WriteMemory(handle, stubAddr, stub.data(), stub.size())) {
    platform::FreeMemory(handle, cave);
    return 0;
  }

  uint8_t ignored[8];
  // Never free on a false return: the thread may still be executing inside
  // `cave` — see the never-free-a-live-cave rule.
  if (!RunRemoteCall(handle, stubAddr, {}, ignored)) return 0;

  uint64_t result = 0;
  platform::ReadMemory(handle, resultAddr, &result, sizeof(result));
  platform::FreeMemory(handle, cave);
  return static_cast<uintptr_t>(result);
}

// mono_get_root_domain, mono_thread_attach, then an UNCONDITIONAL walk of
// every field/method on a class — no search, no early exit — collecting
// each item's name pointer (via mono_field_get_name / mono_method_get_name)
// into a buffer, then mono_thread_detach. One continuous injected thread,
// same motivation as BuildResolveClassStub/BuildMemberSearchStub above.
//
// Deliberately does NOT read the name strings themselves inside the stub:
// a namePtr is just a plain memory address once the stub is done, and
// reading target memory (platform::ReadMemory / ReadProcessMemory) needs
// no Mono thread cooperation at all — unlike calling INTO Mono, which is
// exactly the operation this whole redesign exists to keep on one attached
// thread. So the stub's only job is to collect kMaxMembers pointers as
// fast as possible; ListMemberNamesSingleThread reads the actual strings
// afterward, from the host side, the same way the original (crashing)
// version already safely read each name buffer outside of any RunRemoteCall.
//
// Same near-jump-with-patch technique as BuildMemberSearchStub, though
// this stub's shape is actually fixed (no runtime branch on whether a
// finish call exists) — reused anyway for consistency and because hand-
// verifying short-jump range by eye is exactly the kind of step that has
// produced real bugs elsewhere in this file (see BuildAssemblyCollectorStub
// and BuildResolveClassStub's own history).
//
// Register usage:
//   r15 — attached MonoThread*, needed again at the end for detach
//   r14 — loop counter, doubling as the write index into the name-pointer
//         buffer (every iteration that reaches the store increments it)
//   rbx — &buffer[0] (constant)
//   r12 — the current field/method pointer
//
//   mov rax, getRootDomainFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov rcx, rax
//   mov rax, threadAttachFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov r15, rax
//   mov rbx, bufferAddr
//   xor r14, r14
// loop:
//   cmp r14, guardLimit
//   jae done                              (near)
//   mov rcx, classHandle
//   mov rdx, iterSlotAddr
//   mov rax, getItemsFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   test rax, rax
//   jz done                                (near)               -- exhausted
//   mov r12, rax
//   mov rcx, r12
//   mov rax, getNameFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov [rbx+r14*8], rax                                          -- buffer[i] = namePtr
//   inc r14
//   jmp loop                                (near)
// done:
//   mov rcx, r15
//   mov rax, threadDetachFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov rcx, countAddress
//   mov [rcx], r14                                                 -- *count = items collected
//   xor eax, eax
//   ret
std::vector<uint8_t> BuildMemberListStub(uintptr_t getRootDomainFn, uintptr_t threadAttachFn,
                                          uintptr_t threadDetachFn, uintptr_t getItemsFn,
                                          uintptr_t getNameFn, uintptr_t classHandle,
                                          uintptr_t iterSlotAddr, uintptr_t bufferAddr,
                                          uintptr_t countAddress, uint32_t guardLimit) {
  std::vector<uint8_t> out;
  auto emitMovImm64 = [&](uint8_t rex, uint8_t opcodeByte, uintptr_t imm) {
    out.push_back(rex);
    out.push_back(opcodeByte);
    for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>(imm >> (i * 8)));
  };
  auto emitCall = [&](uintptr_t fn) {
    emitMovImm64(0x48, 0xB8, fn);                      // mov rax, fn
    out.insert(out.end(), {0x48, 0x83, 0xEC, 0x28});   // sub rsp, 0x28
    out.insert(out.end(), {0xFF, 0xD0});               // call rax
    out.insert(out.end(), {0x48, 0x83, 0xC4, 0x28});   // add rsp, 0x28
  };

  enum Label { kLoop, kDone };
  std::unordered_map<int, size_t> labelOffset;
  std::vector<std::pair<size_t, int>> fixups;
  auto mark = [&](int label) { labelOffset[label] = out.size(); };
  auto emitJump = [&](uint8_t shortOpcode, int label) {
    if (shortOpcode == 0xEB) {
      out.push_back(0xE9);
    } else {
      out.push_back(0x0F);
      out.push_back(static_cast<uint8_t>(shortOpcode + 0x10));
    }
    fixups.push_back({out.size(), label});
    out.insert(out.end(), {0x00, 0x00, 0x00, 0x00});
  };

  emitCall(getRootDomainFn);
  out.insert(out.end(), {0x48, 0x89, 0xC1});           // mov rcx, rax
  emitCall(threadAttachFn);
  out.insert(out.end(), {0x49, 0x89, 0xC7});           // mov r15, rax
  emitMovImm64(0x48, 0xBB, bufferAddr);                // mov rbx, bufferAddr
  out.insert(out.end(), {0x4D, 0x31, 0xF6});           // xor r14, r14

  mark(kLoop);
  out.insert(out.end(), {0x49, 0x81, 0xFE,             // cmp r14, guardLimit
                          static_cast<uint8_t>(guardLimit & 0xFF),
                          static_cast<uint8_t>((guardLimit >> 8) & 0xFF),
                          static_cast<uint8_t>((guardLimit >> 16) & 0xFF),
                          static_cast<uint8_t>((guardLimit >> 24) & 0xFF)});
  emitJump(0x73, kDone);                               // jae done
  emitMovImm64(0x48, 0xB9, classHandle);               // mov rcx, classHandle
  emitMovImm64(0x48, 0xBA, iterSlotAddr);              // mov rdx, iterSlotAddr
  emitCall(getItemsFn);
  out.insert(out.end(), {0x48, 0x85, 0xC0});           // test rax, rax
  emitJump(0x74, kDone);                               // jz done (exhausted)
  out.insert(out.end(), {0x49, 0x89, 0xC4});           // mov r12, rax
  out.insert(out.end(), {0x4C, 0x89, 0xE1});           // mov rcx, r12
  emitCall(getNameFn);
  out.insert(out.end(), {0x4A, 0x89, 0x04, 0xF3});     // mov [rbx+r14*8], rax
  out.insert(out.end(), {0x49, 0xFF, 0xC6});           // inc r14
  emitJump(0xEB, kLoop);                               // jmp loop

  mark(kDone);
  out.insert(out.end(), {0x4C, 0x89, 0xF9});           // mov rcx, r15
  emitCall(threadDetachFn);
  emitMovImm64(0x48, 0xB9, countAddress);              // mov rcx, countAddress
  out.insert(out.end(), {0x4C, 0x89, 0x31});           // mov [rcx], r14
  out.insert(out.end(), {0x31, 0xC0});                 // xor eax, eax
  out.push_back(0xC3);                                 // ret

  for (auto& fx : fixups) {
    size_t pos = fx.first;
    int32_t rel = static_cast<int32_t>(labelOffset[fx.second]) - static_cast<int32_t>(pos + 4);
    out[pos + 0] = static_cast<uint8_t>(rel & 0xFF);
    out[pos + 1] = static_cast<uint8_t>((rel >> 8) & 0xFF);
    out[pos + 2] = static_cast<uint8_t>((rel >> 16) & 0xFF);
    out[pos + 3] = static_cast<uint8_t>((rel >> 24) & 0xFF);
  }

  return out;
}

constexpr uint32_t kMaxMembers = 256;

std::vector<std::string> ListMemberNamesSingleThread(platform::ProcessHandle handle, uintptr_t monoDllBase,
                                                     uintptr_t classHandle, const std::string& getItemsExport,
                                                     const std::string& getNameExport) {
  uintptr_t getRootDomain = platform::ResolveExport(handle, monoDllBase, "mono_get_root_domain");
  uintptr_t threadAttach = platform::ResolveExport(handle, monoDllBase, "mono_thread_attach");
  uintptr_t threadDetach = platform::ResolveExport(handle, monoDllBase, "mono_thread_detach");
  uintptr_t getItems = platform::ResolveExport(handle, monoDllBase, getItemsExport);
  uintptr_t getName = platform::ResolveExport(handle, monoDllBase, getNameExport);
  if (!getRootDomain || !threadAttach || !threadDetach || !getItems || !getName) return {};

  uintptr_t cave = platform::AllocateNear(handle, monoDllBase, 8 + 8 + kMaxMembers * 8 + 320);
  if (!cave) return {};
  uintptr_t countAddr = cave;
  uintptr_t iterSlotAddr = cave + 8;
  uintptr_t bufferAddr = cave + 16;
  uintptr_t stubAddr = bufferAddr + kMaxMembers * 8;

  uint64_t zero = 0;
  if (!platform::WriteMemory(handle, countAddr, &zero, sizeof(zero)) ||
      !platform::WriteMemory(handle, iterSlotAddr, &zero, sizeof(zero))) {
    platform::FreeMemory(handle, cave);
    return {};
  }

  std::vector<uint8_t> stub = BuildMemberListStub(getRootDomain, threadAttach, threadDetach, getItems,
                                                   getName, classHandle, iterSlotAddr, bufferAddr,
                                                   countAddr, kMaxMembers);
  if (!platform::WriteMemory(handle, stubAddr, stub.data(), stub.size())) {
    platform::FreeMemory(handle, cave);
    return {};
  }

  uint8_t ignored[8];
  // Never free on a false return: the thread may still be executing inside
  // `cave` — see the never-free-a-live-cave rule.
  if (!RunRemoteCall(handle, stubAddr, {}, ignored)) return {};

  uint64_t count = 0;
  platform::ReadMemory(handle, countAddr, &count, sizeof(count));
  if (count > kMaxMembers) count = kMaxMembers;
  std::vector<uintptr_t> namePtrs(count);
  if (count > 0) platform::ReadMemory(handle, bufferAddr, namePtrs.data(), count * sizeof(uintptr_t));

  std::vector<std::string> names;
  names.reserve(namePtrs.size());
  for (uintptr_t ptr : namePtrs) {
    if (!ptr) continue;
    char buf[256] = {0};
    if (platform::ReadMemory(handle, ptr, buf, sizeof(buf) - 1)) names.push_back(buf);
  }
  platform::FreeMemory(handle, cave);
  return names;
}

// mono_get_root_domain, mono_thread_attach, mono_assembly_foreach (via the
// same collector callback EnumerateAssemblies uses), then for each
// collected assembly handle: mono_assembly_get_image followed by
// mono_image_get_name, storing (image, namePtr) into two parallel output
// arrays — skipping an assembly whose image resolves to null rather than
// aborting the whole walk — then mono_thread_detach. One continuous
// thread, same motivation as every other stub in this file.
//
// Register usage, beyond the callee-preserves-RBX/R12-R15 guarantee the
// other stubs' comments already explain — this one also relies on RDI and
// RBP being preserved across a call, which the Win64 ABI guarantees
// equally (RDI is callee-saved; RBP here is used purely as a plain value
// register across one call, never as a memory-addressing base, so its
// usual "requires an explicit disp8/32 in SIB addressing" special case
// never applies):
//   r15 — attached MonoThread*, needed again at the end for detach
//   r13 — assembly count, from the foreach collector's own buffer
//   r12 — outer loop index (0..assembly count)
//   rbx — &assemblySlots[0] (input, filled by the foreach collector)
//   rdi — &images[0] (output, constant)
//   r14 — &names[0] (output, constant)
//   rsi — output count (only incremented when an assembly's image
//         resolves; may end up less than r13 if some don't)
//   rbp — the current assembly's image handle, held across the
//         mono_image_get_name call so it can be stored alongside the name
//
//   [attach, then foreach exactly like EnumerateAssemblies]
//   mov rax, assemblyBufAddr ; mov r13, [rax]      -- assembly count
//   xor r12, r12
//   mov rbx, assemblySlotsAddr
//   mov rdi, imagesBufAddr
//   mov r14, namesBufAddr
//   xor rsi, rsi
// loop:
//   cmp r12, r13
//   jae done                              (near)
//   mov rcx, [rbx+r12*8]
//   mov rax, getImageFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   test rax, rax
//   jz skip                               (near)              -- no image, skip this assembly
//   mov rbp, rax
//   mov rcx, rbp
//   mov rax, getNameFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov [rdi+rsi*8], rbp                                        -- images[count] = image
//   mov [r14+rsi*8], rax                                        -- names[count] = namePtr
//   inc rsi
// skip:
//   inc r12
//   jmp loop                               (near)
// done:
//   mov rcx, r15
//   mov rax, threadDetachFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov rcx, countAddress
//   mov [rcx], rsi
//   xor eax, eax
//   ret
std::vector<uint8_t> BuildListAssemblyNamesStub(uintptr_t getRootDomainFn, uintptr_t threadAttachFn,
                                                 uintptr_t threadDetachFn, uintptr_t foreachFn,
                                                 uintptr_t getImageFn, uintptr_t getNameFn,
                                                 uintptr_t collectorStubAddr, uintptr_t assemblyBufAddr,
                                                 uintptr_t assemblySlotsAddr, uintptr_t imagesBufAddr,
                                                 uintptr_t namesBufAddr, uintptr_t countAddress) {
  std::vector<uint8_t> out;
  auto emitMovImm64 = [&](uint8_t rex, uint8_t opcodeByte, uintptr_t imm) {
    out.push_back(rex);
    out.push_back(opcodeByte);
    for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>(imm >> (i * 8)));
  };
  auto emitCall = [&](uintptr_t fn) {
    emitMovImm64(0x48, 0xB8, fn);
    out.insert(out.end(), {0x48, 0x83, 0xEC, 0x28});
    out.insert(out.end(), {0xFF, 0xD0});
    out.insert(out.end(), {0x48, 0x83, 0xC4, 0x28});
  };

  enum Label { kLoop, kSkip, kDone };
  std::unordered_map<int, size_t> labelOffset;
  std::vector<std::pair<size_t, int>> fixups;
  auto mark = [&](int label) { labelOffset[label] = out.size(); };
  auto emitJump = [&](uint8_t shortOpcode, int label) {
    if (shortOpcode == 0xEB) {
      out.push_back(0xE9);
    } else {
      out.push_back(0x0F);
      out.push_back(static_cast<uint8_t>(shortOpcode + 0x10));
    }
    fixups.push_back({out.size(), label});
    out.insert(out.end(), {0x00, 0x00, 0x00, 0x00});
  };

  emitCall(getRootDomainFn);
  out.insert(out.end(), {0x48, 0x89, 0xC1});           // mov rcx, rax
  emitCall(threadAttachFn);
  out.insert(out.end(), {0x49, 0x89, 0xC7});           // mov r15, rax

  emitMovImm64(0x48, 0xB9, collectorStubAddr);         // mov rcx, collectorStubAddr
  emitMovImm64(0x48, 0xBA, assemblyBufAddr);           // mov rdx, assemblyBufAddr
  emitCall(foreachFn);

  emitMovImm64(0x48, 0xB8, assemblyBufAddr);           // mov rax, assemblyBufAddr
  out.insert(out.end(), {0x4C, 0x8B, 0x28});           // mov r13, [rax]
  out.insert(out.end(), {0x4D, 0x31, 0xE4});           // xor r12, r12
  emitMovImm64(0x48, 0xBB, assemblySlotsAddr);         // mov rbx, assemblySlotsAddr
  emitMovImm64(0x48, 0xBF, imagesBufAddr);             // mov rdi, imagesBufAddr
  emitMovImm64(0x49, 0xBE, namesBufAddr);              // mov r14, namesBufAddr
  out.insert(out.end(), {0x48, 0x31, 0xF6});           // xor rsi, rsi

  mark(kLoop);
  out.insert(out.end(), {0x4D, 0x39, 0xEC});           // cmp r12, r13
  emitJump(0x73, kDone);                               // jae done
  out.insert(out.end(), {0x4A, 0x8B, 0x0C, 0xE3});     // mov rcx, [rbx+r12*8]
  emitCall(getImageFn);
  out.insert(out.end(), {0x48, 0x85, 0xC0});           // test rax, rax
  emitJump(0x74, kSkip);                               // jz skip
  out.insert(out.end(), {0x48, 0x89, 0xC5});           // mov rbp, rax
  out.insert(out.end(), {0x48, 0x89, 0xE9});           // mov rcx, rbp
  emitCall(getNameFn);
  out.insert(out.end(), {0x48, 0x89, 0x2C, 0xF7});     // mov [rdi+rsi*8], rbp
  out.insert(out.end(), {0x49, 0x89, 0x04, 0xF6});     // mov [r14+rsi*8], rax
  out.insert(out.end(), {0x48, 0xFF, 0xC6});           // inc rsi

  mark(kSkip);
  out.insert(out.end(), {0x49, 0xFF, 0xC4});           // inc r12
  emitJump(0xEB, kLoop);                               // jmp loop

  mark(kDone);
  out.insert(out.end(), {0x4C, 0x89, 0xF9});           // mov rcx, r15
  emitCall(threadDetachFn);
  emitMovImm64(0x48, 0xB9, countAddress);              // mov rcx, countAddress
  out.insert(out.end(), {0x48, 0x89, 0x31});           // mov [rcx], rsi
  out.insert(out.end(), {0x31, 0xC0});                 // xor eax, eax
  out.push_back(0xC3);                                 // ret

  for (auto& fx : fixups) {
    size_t pos = fx.first;
    int32_t rel = static_cast<int32_t>(labelOffset[fx.second]) - static_cast<int32_t>(pos + 4);
    out[pos + 0] = static_cast<uint8_t>(rel & 0xFF);
    out[pos + 1] = static_cast<uint8_t>((rel >> 8) & 0xFF);
    out[pos + 2] = static_cast<uint8_t>((rel >> 16) & 0xFF);
    out[pos + 3] = static_cast<uint8_t>((rel >> 24) & 0xFF);
  }

  return out;
}

// Definition of the function forward-declared near the others. Cave
// layout: [0..8) output count, [8..8+kMax*8) output images array,
// [that..+kMax*8) output names array, [that..+8+kMax*8) the foreach
// collector's own count+slots buffer (same shape EnumerateAssemblies'
// cave uses), then the collector stub's code, then this stub's code.
std::vector<std::pair<uintptr_t, std::string>> ListAssemblyNamesSingleThread(platform::ProcessHandle handle,
                                                                              uintptr_t monoDllBase) {
  uintptr_t getRootDomain = platform::ResolveExport(handle, monoDllBase, "mono_get_root_domain");
  uintptr_t threadAttach = platform::ResolveExport(handle, monoDllBase, "mono_thread_attach");
  uintptr_t threadDetach = platform::ResolveExport(handle, monoDllBase, "mono_thread_detach");
  uintptr_t foreach_ = platform::ResolveExport(handle, monoDllBase, "mono_assembly_foreach");
  uintptr_t getImage = platform::ResolveExport(handle, monoDllBase, "mono_assembly_get_image");
  uintptr_t getName = platform::ResolveExport(handle, monoDllBase, "mono_image_get_name");
  if (!getRootDomain || !threadAttach || !threadDetach || !foreach_ || !getImage || !getName) return {};

  std::vector<uint8_t> collectorStub = BuildAssemblyCollectorStub();

  uintptr_t cave = platform::AllocateNear(
      handle, monoDllBase, 8 + kMaxAssemblies * 8 * 3 + 8 + collectorStub.size() + 512);
  if (!cave) return {};
  uintptr_t countAddr = cave;
  uintptr_t imagesBufAddr = cave + 8;
  uintptr_t namesBufAddr = imagesBufAddr + kMaxAssemblies * 8;
  uintptr_t assemblyBufAddr = namesBufAddr + kMaxAssemblies * 8;
  uintptr_t assemblySlotsAddr = assemblyBufAddr + 8;
  uintptr_t collectorStubAddr = assemblyBufAddr + 8 + kMaxAssemblies * 8;
  uintptr_t mainStubAddr = collectorStubAddr + collectorStub.size();

  uint64_t zero = 0;
  if (!platform::WriteMemory(handle, countAddr, &zero, sizeof(zero)) ||
      !platform::WriteMemory(handle, assemblyBufAddr, &zero, sizeof(zero)) ||
      !platform::WriteMemory(handle, collectorStubAddr, collectorStub.data(), collectorStub.size())) {
    platform::FreeMemory(handle, cave);
    return {};
  }

  std::vector<uint8_t> mainStub = BuildListAssemblyNamesStub(
      getRootDomain, threadAttach, threadDetach, foreach_, getImage, getName, collectorStubAddr,
      assemblyBufAddr, assemblySlotsAddr, imagesBufAddr, namesBufAddr, countAddr);
  if (!platform::WriteMemory(handle, mainStubAddr, mainStub.data(), mainStub.size())) {
    platform::FreeMemory(handle, cave);
    return {};
  }

  uint8_t ignored[8];
  // Never free on a false return: the thread may still be executing inside
  // `cave` — see the never-free-a-live-cave rule.
  if (!RunRemoteCall(handle, mainStubAddr, {}, ignored)) return {};

  uint64_t count = 0;
  platform::ReadMemory(handle, countAddr, &count, sizeof(count));
  if (count > kMaxAssemblies) count = kMaxAssemblies;
  std::vector<uintptr_t> images(count), namePtrs(count);
  if (count > 0) {
    platform::ReadMemory(handle, imagesBufAddr, images.data(), count * sizeof(uintptr_t));
    platform::ReadMemory(handle, namesBufAddr, namePtrs.data(), count * sizeof(uintptr_t));
  }

  std::vector<std::pair<uintptr_t, std::string>> results;
  results.reserve(count);
  for (size_t i = 0; i < count; i++) {
    if (!images[i] || !namePtrs[i]) continue;
    char buf[256] = {0};
    if (platform::ReadMemory(handle, namePtrs[i], buf, sizeof(buf) - 1)) {
      results.push_back({images[i], std::string(buf)});
    }
  }
  platform::FreeMemory(handle, cave);
  return results;
}

// mono_get_root_domain, mono_thread_attach, then a bounded walk of
// `imageHandle`'s TypeDef metadata table: mono_image_get_table_info once,
// mono_table_info_get_rows once, then mono_class_get(imageHandle,
// MONO_TOKEN_TYPE_DEF | (row+1)) per row (Mono's own token-encoding
// convention — see mono_class_get's real embedding-API documentation),
// collecting each resolved class's name and namespace, then
// mono_thread_detach. One continuous thread.
//
// MONO_TABLE_TYPEDEF (2) and MONO_TOKEN_TYPE_DEF (0x02000000) are Mono's
// own real constants, not this codebase's invention — mono_metadata.h
// defines them, and any embedding caller must use the same values to get
// a meaningful MonoTableInfo*/token.
constexpr uint32_t kMonoTableTypeDef = 2;
constexpr uint32_t kMonoTokenTypeDef = 0x02000000;
// A real game assembly can hold several thousand types (Unity/Mono games
// routinely do); generous like kMaxAssemblies/kMaxMembers rather than
// tuned to any one game.
constexpr uint32_t kMaxClasses = 8192;

// Register usage — same callee-preserved-across-calls guarantees the
// other stubs already rely on:
//   r15 — attached MonoThread*
//   r14 — total row count (from mono_table_info_get_rows), clamped to
//         kMaxClasses before the loop so a huge assembly can't overflow
//         the fixed-size output buffers
//   r12 — loop index / row number (0..r14)
//   rdi — &names[0] (output, constant)
//   r13 — &namespaces[0] (output, constant)
//   rsi — &classHandles[0] (output, constant) — the resolved MonoClass*
//         itself, so a caller can use the class without a second, separate,
//         ambiguous-by-name resolveClass call (see ClassEntry's comment)
//   rbx — the current row's resolved MonoClass*, held across the
//         name/namespace calls
//
//   [attach]
//   mov rcx, imageHandle
//   mov rdx, kMonoTableTypeDef
//   mov rax, getTableInfoFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov rcx, rax                                       -- tableInfo
//   mov rax, getRowsFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov r14, rax                                        -- row count
//   cmp r14, kMaxClasses
//   jbe not_capped                                        (near)
//   mov r14, kMaxClasses
// not_capped:
//   xor r12, r12
//   mov rdi, namesBufAddr
//   mov r13, namespacesBufAddr
//   mov rsi, classHandlesBufAddr
// loop:
//   cmp r12, r14
//   jae done                                                (near)
//   mov rcx, imageHandle
//   mov rdx, r12
//   add rdx, kMonoTokenTypeDef+1        -- token = TYPE_DEF | (row+1); ADD
//                                           instead of OR is safe here
//                                           because row+1 (bounded by
//                                           kMaxClasses, 8192) never
//                                           overlaps TYPE_DEF's own set
//                                           bit (0x02000000), so ADD and
//                                           OR produce the identical result
//   mov rax, classGetFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   test rax, rax
//   jz skip                                                  (near)
//   mov rbx, rax
//   mov [rsi+r12*8], rbx                                       -- classHandles[row] = rbx
//   mov rcx, rbx
//   mov rax, classNameFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov [rdi+r12*8], rax                                       -- names[row] = namePtr
//   mov rcx, rbx
//   mov rax, classNamespaceFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov [r13+r12*8], rax                                       -- namespaces[row] = nsPtr
// skip:
//   inc r12
//   jmp loop                                                    (near)
// done:
//   [detach]
//   mov rcx, countAddress
//   mov [rcx], r14
//   xor eax, eax
//   ret
std::vector<uint8_t> BuildListClassesStub(uintptr_t getRootDomainFn, uintptr_t threadAttachFn,
                                           uintptr_t threadDetachFn, uintptr_t getTableInfoFn,
                                           uintptr_t getRowsFn, uintptr_t classGetFn, uintptr_t classNameFn,
                                           uintptr_t classNamespaceFn, uintptr_t imageHandle,
                                           uintptr_t namesBufAddr, uintptr_t namespacesBufAddr,
                                           uintptr_t classHandlesBufAddr, uintptr_t countAddress) {
  std::vector<uint8_t> out;
  auto emitMovImm64 = [&](uint8_t rex, uint8_t opcodeByte, uintptr_t imm) {
    out.push_back(rex);
    out.push_back(opcodeByte);
    for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>(imm >> (i * 8)));
  };
  auto emitCall = [&](uintptr_t fn) {
    emitMovImm64(0x48, 0xB8, fn);
    out.insert(out.end(), {0x48, 0x83, 0xEC, 0x28});
    out.insert(out.end(), {0xFF, 0xD0});
    out.insert(out.end(), {0x48, 0x83, 0xC4, 0x28});
  };

  enum Label { kNotCapped, kLoop, kSkip, kDone };
  std::unordered_map<int, size_t> labelOffset;
  std::vector<std::pair<size_t, int>> fixups;
  auto mark = [&](int label) { labelOffset[label] = out.size(); };
  auto emitJump = [&](uint8_t shortOpcode, int label) {
    if (shortOpcode == 0xEB) {
      out.push_back(0xE9);
    } else {
      out.push_back(0x0F);
      out.push_back(static_cast<uint8_t>(shortOpcode + 0x10));
    }
    fixups.push_back({out.size(), label});
    out.insert(out.end(), {0x00, 0x00, 0x00, 0x00});
  };

  emitCall(getRootDomainFn);
  out.insert(out.end(), {0x48, 0x89, 0xC1});           // mov rcx, rax
  emitCall(threadAttachFn);
  out.insert(out.end(), {0x49, 0x89, 0xC7});           // mov r15, rax

  emitMovImm64(0x48, 0xB9, imageHandle);               // mov rcx, imageHandle
  emitMovImm64(0x48, 0xBA, kMonoTableTypeDef);         // mov rdx, kMonoTableTypeDef
  emitCall(getTableInfoFn);
  out.insert(out.end(), {0x48, 0x89, 0xC1});           // mov rcx, rax
  emitCall(getRowsFn);
  out.insert(out.end(), {0x49, 0x89, 0xC6});           // mov r14, rax

  out.insert(out.end(), {0x49, 0x81, 0xFE,             // cmp r14, kMaxClasses
                          static_cast<uint8_t>(kMaxClasses & 0xFF),
                          static_cast<uint8_t>((kMaxClasses >> 8) & 0xFF),
                          static_cast<uint8_t>((kMaxClasses >> 16) & 0xFF),
                          static_cast<uint8_t>((kMaxClasses >> 24) & 0xFF)});
  emitJump(0x76, kNotCapped);                          // jbe not_capped
  emitMovImm64(0x49, 0xBE, kMaxClasses);               // mov r14, kMaxClasses

  mark(kNotCapped);
  out.insert(out.end(), {0x4D, 0x31, 0xE4});           // xor r12, r12
  emitMovImm64(0x48, 0xBF, namesBufAddr);              // mov rdi, namesBufAddr
  emitMovImm64(0x49, 0xBD, namespacesBufAddr);         // mov r13, namespacesBufAddr
  emitMovImm64(0x48, 0xBE, classHandlesBufAddr);       // mov rsi, classHandlesBufAddr

  mark(kLoop);
  out.insert(out.end(), {0x4D, 0x39, 0xF4});           // cmp r12, r14
  emitJump(0x73, kDone);                               // jae done
  emitMovImm64(0x48, 0xB9, imageHandle);               // mov rcx, imageHandle
  out.insert(out.end(), {0x4C, 0x89, 0xE2});           // mov rdx, r12
  out.insert(out.end(), {0x48, 0x81, 0xC2,             // add rdx, kMonoTokenTypeDef+1
                          static_cast<uint8_t>((kMonoTokenTypeDef + 1) & 0xFF),
                          static_cast<uint8_t>(((kMonoTokenTypeDef + 1) >> 8) & 0xFF),
                          static_cast<uint8_t>(((kMonoTokenTypeDef + 1) >> 16) & 0xFF),
                          static_cast<uint8_t>(((kMonoTokenTypeDef + 1) >> 24) & 0xFF)});
  emitCall(classGetFn);
  out.insert(out.end(), {0x48, 0x85, 0xC0});           // test rax, rax
  emitJump(0x74, kSkip);                               // jz skip
  out.insert(out.end(), {0x48, 0x89, 0xC3});           // mov rbx, rax
  out.insert(out.end(), {0x4A, 0x89, 0x1C, 0xE6});     // mov [rsi+r12*8], rbx
  out.insert(out.end(), {0x48, 0x89, 0xD9});           // mov rcx, rbx
  emitCall(classNameFn);
  out.insert(out.end(), {0x4A, 0x89, 0x04, 0xE7});     // mov [rdi+r12*8], rax
  out.insert(out.end(), {0x48, 0x89, 0xD9});           // mov rcx, rbx
  emitCall(classNamespaceFn);
  out.insert(out.end(), {0x4B, 0x89, 0x44, 0xE5, 0x00}); // mov [r13+r12*8], rax

  mark(kSkip);
  out.insert(out.end(), {0x49, 0xFF, 0xC4});           // inc r12
  emitJump(0xEB, kLoop);                               // jmp loop

  mark(kDone);
  out.insert(out.end(), {0x4C, 0x89, 0xF9});           // mov rcx, r15
  emitCall(threadDetachFn);
  emitMovImm64(0x48, 0xB9, countAddress);              // mov rcx, countAddress
  out.insert(out.end(), {0x4C, 0x89, 0x31});           // mov [rcx], r14
  out.insert(out.end(), {0x31, 0xC0});                 // xor eax, eax
  out.push_back(0xC3);                                 // ret

  for (auto& fx : fixups) {
    size_t pos = fx.first;
    int32_t rel = static_cast<int32_t>(labelOffset[fx.second]) - static_cast<int32_t>(pos + 4);
    out[pos + 0] = static_cast<uint8_t>(rel & 0xFF);
    out[pos + 1] = static_cast<uint8_t>((rel >> 8) & 0xFF);
    out[pos + 2] = static_cast<uint8_t>((rel >> 16) & 0xFF);
    out[pos + 3] = static_cast<uint8_t>((rel >> 24) & 0xFF);
  }

  return out;
}

// Definition of the function forward-declared near the others. Cave
// layout: [0..8) output count, [8..8+kMax*8) names array,
// [that..+kMax*8) namespaces array, [that..+kMax*8) classHandles array,
// then this stub's code.
std::vector<ClassEntry> ListClassesInImageSingleThread(
    platform::ProcessHandle handle, uintptr_t monoDllBase, uintptr_t imageHandle) {
  uintptr_t getRootDomain = platform::ResolveExport(handle, monoDllBase, "mono_get_root_domain");
  uintptr_t threadAttach = platform::ResolveExport(handle, monoDllBase, "mono_thread_attach");
  uintptr_t threadDetach = platform::ResolveExport(handle, monoDllBase, "mono_thread_detach");
  uintptr_t getTableInfo = platform::ResolveExport(handle, monoDllBase, "mono_image_get_table_info");
  uintptr_t getRows = platform::ResolveExport(handle, monoDllBase, "mono_table_info_get_rows");
  uintptr_t classGet = platform::ResolveExport(handle, monoDllBase, "mono_class_get");
  uintptr_t classGetName = platform::ResolveExport(handle, monoDllBase, "mono_class_get_name");
  uintptr_t classGetNamespace = platform::ResolveExport(handle, monoDllBase, "mono_class_get_namespace");
  if (!getRootDomain || !threadAttach || !threadDetach || !getTableInfo || !getRows || !classGet ||
      !classGetName || !classGetNamespace) {
    return {};
  }

  uintptr_t cave = platform::AllocateNear(handle, monoDllBase, 8 + kMaxClasses * 8 * 3 + 512);
  if (!cave) return {};
  uintptr_t countAddr = cave;
  uintptr_t namesBufAddr = cave + 8;
  uintptr_t namespacesBufAddr = namesBufAddr + kMaxClasses * 8;
  uintptr_t classHandlesBufAddr = namespacesBufAddr + kMaxClasses * 8;
  uintptr_t stubAddr = classHandlesBufAddr + kMaxClasses * 8;

  uint64_t zero = 0;
  if (!platform::WriteMemory(handle, countAddr, &zero, sizeof(zero))) {
    platform::FreeMemory(handle, cave);
    return {};
  }

  std::vector<uint8_t> stub =
      BuildListClassesStub(getRootDomain, threadAttach, threadDetach, getTableInfo, getRows, classGet,
                            classGetName, classGetNamespace, imageHandle, namesBufAddr, namespacesBufAddr,
                            classHandlesBufAddr, countAddr);
  if (!platform::WriteMemory(handle, stubAddr, stub.data(), stub.size())) {
    platform::FreeMemory(handle, cave);
    return {};
  }

  uint8_t ignored[8];
  // Never free on a false return: the thread may still be executing inside
  // `cave` — see the never-free-a-live-cave rule.
  if (!RunRemoteCall(handle, stubAddr, {}, ignored)) return {};

  uint64_t count = 0;
  platform::ReadMemory(handle, countAddr, &count, sizeof(count));
  if (count > kMaxClasses) count = kMaxClasses;
  std::vector<uintptr_t> namePtrs(count), namespacePtrs(count), classHandles(count);
  if (count > 0) {
    platform::ReadMemory(handle, namesBufAddr, namePtrs.data(), count * sizeof(uintptr_t));
    platform::ReadMemory(handle, namespacesBufAddr, namespacePtrs.data(), count * sizeof(uintptr_t));
    platform::ReadMemory(handle, classHandlesBufAddr, classHandles.data(), count * sizeof(uintptr_t));
  }

  std::vector<ClassEntry> results;
  results.reserve(count);
  for (size_t i = 0; i < count; i++) {
    if (!namePtrs[i]) continue; // a skipped row (mono_class_get returned null)
    char nameBuf[256] = {0};
    char nsBuf[256] = {0};
    if (!platform::ReadMemory(handle, namePtrs[i], nameBuf, sizeof(nameBuf) - 1)) continue;
    // A class with no namespace is legitimate (Mono returns a real,
    // non-null empty string for it in practice, but this codebase treats
    // an unreadable pointer defensively rather than assuming that).
    if (namespacePtrs[i]) platform::ReadMemory(handle, namespacePtrs[i], nsBuf, sizeof(nsBuf) - 1);
    results.push_back({std::string(nsBuf), std::string(nameBuf), classHandles[i]});
  }
  platform::FreeMemory(handle, cave);
  return results;
}

} // namespace

class MonoListAssembliesWorker : public Napi::AsyncWorker {
 public:
  MonoListAssembliesWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // binding.gyp defines NAPI_DISABLE_CPP_EXCEPTIONS, so node-addon-api does
  // NOT wrap Execute() in a try/catch — an escaped C++ exception on this
  // libuv worker thread calls std::terminate and kills the whole Electron
  // process. SetError routes to OnError instead. Pure safety net: the
  // success path is unchanged. Same shape as scanner.cc/pointer.cc.
  void Execute() override {
    try {
      Run();
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error");
    }
  }

  void Run() {
    MonoContext ctx = AttachToMono(handle_, monoDllBase_);
    if (!ctx.ok) return;

    assemblies_ = EnumerateAssemblies(handle_, monoDllBase_, ctx);

    DetachFromMono(handle_, monoDllBase_, ctx);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array out = Napi::Array::New(env, assemblies_.size());
    for (size_t i = 0; i < assemblies_.size(); i++) {
      out.Set((uint32_t)i, Napi::String::New(env, ToHex(assemblies_[i])));
    }
    deferred_.Resolve(out);
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Napi::Array::New(Env(), 0)); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_;
  std::vector<uintptr_t> assemblies_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value MonoListAssemblies(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
    Napi::TypeError::New(env, "monoListAssemblies(handle, monoDllBase) expects (number, string)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());

  auto* worker = new MonoListAssembliesWorker(env, handle, monoDllBase);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class MonoListAssemblyNamesWorker : public Napi::AsyncWorker {
 public:
  MonoListAssemblyNamesWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // binding.gyp defines NAPI_DISABLE_CPP_EXCEPTIONS, so node-addon-api does
  // NOT wrap Execute() in a try/catch — an escaped C++ exception on this
  // libuv worker thread calls std::terminate and kills the whole Electron
  // process. SetError routes to OnError instead. Pure safety net: the
  // success path is unchanged. Same shape as scanner.cc/pointer.cc.
  void Execute() override {
    try {
      Run();
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error");
    }
  }

  void Run() { results_ = ListAssemblyNamesSingleThread(handle_, monoDllBase_); }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array out = Napi::Array::New(env, results_.size());
    for (size_t i = 0; i < results_.size(); i++) {
      Napi::Object entry = Napi::Object::New(env);
      entry.Set("image", Napi::String::New(env, ToHex(results_[i].first)));
      entry.Set("name", Napi::String::New(env, results_[i].second));
      out.Set(static_cast<uint32_t>(i), entry);
    }
    deferred_.Resolve(out);
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Napi::Array::New(Env(), 0)); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_;
  std::vector<std::pair<uintptr_t, std::string>> results_;
  Napi::Promise::Deferred deferred_;
};

// Backs the Mono Explorer's assembly picker: every loaded assembly's
// image handle (for a later monoListClassesInImage call) paired with a
// human-readable name (e.g. "assembly_valheim"), instead of the opaque
// handle-only list monoListAssemblies returns.
Napi::Value MonoListAssemblyNames(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
    Napi::TypeError::New(env, "monoListAssemblyNames(handle, monoDllBase) expects (number, string)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());

  auto* worker = new MonoListAssemblyNamesWorker(env, handle, monoDllBase);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class MonoListClassesInImageWorker : public Napi::AsyncWorker {
 public:
  MonoListClassesInImageWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase,
                               uintptr_t imageHandle)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase), imageHandle_(imageHandle),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // binding.gyp defines NAPI_DISABLE_CPP_EXCEPTIONS, so node-addon-api does
  // NOT wrap Execute() in a try/catch — an escaped C++ exception on this
  // libuv worker thread calls std::terminate and kills the whole Electron
  // process. SetError routes to OnError instead. Pure safety net: the
  // success path is unchanged. Same shape as scanner.cc/pointer.cc.
  void Execute() override {
    try {
      Run();
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error");
    }
  }

  void Run() { results_ = ListClassesInImageSingleThread(handle_, monoDllBase_, imageHandle_); }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array out = Napi::Array::New(env, results_.size());
    for (size_t i = 0; i < results_.size(); i++) {
      Napi::Object entry = Napi::Object::New(env);
      entry.Set("namespaceName", Napi::String::New(env, results_[i].namespaceName));
      entry.Set("className", Napi::String::New(env, results_[i].className));
      // The class's own resolved handle — a caller (Explorer's "Use as
      // value target"/"Use as patch anchor", or search-index building) can
      // use this directly instead of a second, separate, ambiguous-by-name
      // monoResolveClass call. See ClassEntry's own comment for the bug
      // this exists to eliminate.
      entry.Set("classHandle", Napi::String::New(env, ToHex(results_[i].classHandle)));
      out.Set(static_cast<uint32_t>(i), entry);
    }
    deferred_.Resolve(out);
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Napi::Array::New(Env(), 0)); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_, imageHandle_;
  std::vector<ClassEntry> results_;
  Napi::Promise::Deferred deferred_;
};

// Backs the Mono Explorer's class picker, once an assembly has been
// chosen from monoListAssemblyNames' result: every (namespace, className)
// pair in that assembly's image, so a class can be clicked instead of
// typed.
Napi::Value MonoListClassesInImage(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(env, "monoListClassesInImage(handle, monoDllBase, imageHandle) expects (number, string, string)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t imageHandle = ParseHex(info[2].As<Napi::String>().Utf8Value());

  auto* worker = new MonoListClassesInImageWorker(env, handle, monoDllBase, imageHandle);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

namespace {

// mono_get_root_domain, mono_thread_attach, ONE call to an arbitrary
// caller-supplied function (up to 4 args), capturing both RAX and XMM0,
// then mono_thread_detach — entirely linear, no branches, unlike every
// other stub in this file. Reuses the exact same proven call-block shape
// (sub rsp,0x28 / call / add rsp,0x28) BuildResolveClassStub's comment
// explains, and the same [rcx]=rax / [rcx+8]=xmm0 result-capture
// RunRemoteCall itself uses (mono_call.cc) — nothing new is invented here,
// just the attach/detach wrapper generalized to wrap ANY function, not
// only this file's own Mono API calls.
//
//   mov rax, getRootDomainFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov rcx, rax
//   mov rax, threadAttachFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov r15, rax                                            -- attached thread
//   mov rcx, arg0                       -- skipped for arg0 if it's the float arg
//   mov rdx, arg1                       -- skipped for arg1 if it's the float arg
//   mov r8,  arg2                       -- skipped for arg2 if it's the float arg
//   mov r9,  arg3                       -- skipped for arg3 if it's the float arg
//   mov eax, floatArgBits ; movd xmmN, eax   -- only when floatArgIndex >= 0;
//                                             N matches the arg's position, per
//                                             the Windows x64 ABI's "float args
//                                             use the XMM register at the SAME
//                                             positional slot a pointer arg
//                                             would use a GP register for" rule
//                                             (position 2 -> XMM1, not XMM0)
//   mov rax, targetFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   mov rcx, resultAddress
//   mov [rcx], rax
//   movq [rcx+8], xmm0
//   mov rcx, r15
//   mov rax, threadDetachFn ; sub rsp,0x28 ; call rax ; add rsp,0x28
//   xor eax, eax
//   ret
std::vector<uint8_t> BuildAttachedCallStub(uintptr_t getRootDomainFn, uintptr_t threadAttachFn,
                                            uintptr_t threadDetachFn, uintptr_t targetFn,
                                            const std::vector<uintptr_t>& args,
                                            uintptr_t resultAddress, int floatArgIndex = -1,
                                            uint32_t floatArgBits = 0) {
  std::vector<uint8_t> out;
  auto emitMovImm64 = [&](uint8_t rex, uint8_t opcodeByte, uintptr_t imm) {
    out.push_back(rex);
    out.push_back(opcodeByte);
    for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>(imm >> (i * 8)));
  };
  auto emitCall = [&](uintptr_t fn) {
    emitMovImm64(0x48, 0xB8, fn);
    out.insert(out.end(), {0x48, 0x83, 0xEC, 0x28});
    out.insert(out.end(), {0xFF, 0xD0});
    out.insert(out.end(), {0x48, 0x83, 0xC4, 0x28});
  };

  emitCall(getRootDomainFn);
  out.insert(out.end(), {0x48, 0x89, 0xC1});           // mov rcx, rax
  emitCall(threadAttachFn);
  out.insert(out.end(), {0x49, 0x89, 0xC7});           // mov r15, rax

  uintptr_t a0 = args.size() > 0 ? args[0] : 0;
  uintptr_t a1 = args.size() > 1 ? args[1] : 0;
  uintptr_t a2 = args.size() > 2 ? args[2] : 0;
  uintptr_t a3 = args.size() > 3 ? args[3] : 0;
  if (floatArgIndex != 0) emitMovImm64(0x48, 0xB9, a0);  // mov rcx, a0
  if (floatArgIndex != 1) emitMovImm64(0x48, 0xBA, a1);  // mov rdx, a1
  if (floatArgIndex != 2) emitMovImm64(0x49, 0xB8, a2);  // mov r8,  a2
  if (floatArgIndex != 3) emitMovImm64(0x49, 0xB9, a3);  // mov r9,  a3
  if (floatArgIndex >= 0 && floatArgIndex <= 3) {
    out.push_back(0xB8);                                  // mov eax, floatArgBits
    for (int i = 0; i < 4; i++) out.push_back(static_cast<uint8_t>(floatArgBits >> (i * 8)));
    // movd xmmN, eax — 66 0F 6E /r, modrm 11 <xmmN reg> 000(eax)
    static const uint8_t kXmmModRm[4] = {0xC0, 0xC8, 0xD0, 0xD8}; // xmm0..xmm3
    out.insert(out.end(), {0x66, 0x0F, 0x6E, kXmmModRm[floatArgIndex]});
  }
  emitCall(targetFn);

  emitMovImm64(0x48, 0xB9, resultAddress);             // mov rcx, resultAddress
  out.insert(out.end(), {0x48, 0x89, 0x01});           // mov [rcx], rax
  out.insert(out.end(), {0x66, 0x0F, 0xD6, 0x41, 0x08}); // movq [rcx+8], xmm0

  out.insert(out.end(), {0x4C, 0x89, 0xF9});           // mov rcx, r15
  emitCall(threadDetachFn);
  out.insert(out.end(), {0x31, 0xC0});                 // xor eax, eax
  out.push_back(0xC3);                                 // ret

  return out;
}

// Runs BuildAttachedCallStub above via one RunRemoteCall (one
// CreateRemoteThread for the whole attach-call-detach sequence). Returns
// false only on resolution/allocation/thread/safety failure; the target
// function's own result (whatever it is) is always considered a success —
// this makes no assumption about what the target does or returns.
bool RunAttachedCall(platform::ProcessHandle handle, uintptr_t monoDllBase, uintptr_t targetFn,
                      const std::vector<uintptr_t>& args, uint8_t intResult[8], uint8_t floatResult[8],
                      int floatArgIndex = -1, uint32_t floatArgBits = 0) {
  // targetFn is caller-supplied (unlike every other stub in this file,
  // which only ever calls addresses THIS bridge itself resolved via
  // ResolveExport/mono_compile_method) — RunRemoteCall's own executable-
  // region guard only covers the outer call to OUR generated stub
  // (always valid, since we just wrote it), never the inner `call rax` to
  // targetFn baked inside it. Without this check here, a bad address
  // reaches an unguarded `call` inside the target process with no
  // exception handler installed for it — the same crash-the-whole-process
  // hazard RunRemoteCall's own guard exists to prevent for BuildCallStub.
  platform::Region region;
  if (!platform::QueryRegion(handle, targetFn, region) || !region.executable) return false;

  uintptr_t getRootDomain = platform::ResolveExport(handle, monoDllBase, "mono_get_root_domain");
  uintptr_t threadAttach = platform::ResolveExport(handle, monoDllBase, "mono_thread_attach");
  uintptr_t threadDetach = platform::ResolveExport(handle, monoDllBase, "mono_thread_detach");
  if (!getRootDomain || !threadAttach || !threadDetach) return false;

  uintptr_t cave = platform::AllocateNear(handle, monoDllBase, 16 + 256);
  if (!cave) return false;
  uintptr_t resultAddr = cave;
  uintptr_t stubAddr = cave + 16;

  uint8_t zero[16] = {0};
  if (!platform::WriteMemory(handle, resultAddr, zero, sizeof(zero))) {
    platform::FreeMemory(handle, cave);
    return false;
  }

  std::vector<uint8_t> stub = BuildAttachedCallStub(getRootDomain, threadAttach, threadDetach, targetFn,
                                                     args, resultAddr, floatArgIndex, floatArgBits);
  if (!platform::WriteMemory(handle, stubAddr, stub.data(), stub.size())) {
    platform::FreeMemory(handle, cave);
    return false;
  }

  uint8_t ignored[8];
  // Never free on a false return: the thread may still be executing inside
  // `cave` — see the never-free-a-live-cave rule.
  if (!RunRemoteCall(handle, stubAddr, {}, ignored)) return false;

  if (!platform::ReadMemory(handle, resultAddr, intResult, 8)) {
    platform::FreeMemory(handle, cave);
    return false;
  }
  bool ok = platform::ReadMemory(handle, resultAddr + 8, floatResult, 8);
  platform::FreeMemory(handle, cave);
  return ok;
}

} // namespace

class MonoCallAttachedWorker : public Napi::AsyncWorker {
 public:
  MonoCallAttachedWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase,
                         uintptr_t targetFn, std::vector<uintptr_t> args, int floatArgIndex,
                         uint32_t floatArgBits)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase), targetFn_(targetFn),
        args_(std::move(args)), floatArgIndex_(floatArgIndex), floatArgBits_(floatArgBits),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // binding.gyp defines NAPI_DISABLE_CPP_EXCEPTIONS, so node-addon-api does
  // NOT wrap Execute() in a try/catch — an escaped C++ exception on this
  // libuv worker thread calls std::terminate and kills the whole Electron
  // process. SetError routes to OnError instead. Pure safety net: the
  // success path is unchanged. Same shape as scanner.cc/pointer.cc.
  void Execute() override {
    try {
      Run();
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error");
    }
  }

  void Run() {
    ok_ = RunAttachedCall(handle_, monoDllBase_, targetFn_, args_, intResult_, floatResult_,
                          floatArgIndex_, floatArgBits_);
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (!ok_) { deferred_.Resolve(env.Null()); return; }
    uintptr_t intValue = 0;
    memcpy(&intValue, intResult_, sizeof(intValue));
    float floatValue = 0;
    memcpy(&floatValue, floatResult_, sizeof(floatValue));
    Napi::Object out = Napi::Object::New(env);
    out.Set("int", Napi::String::New(env, ToHex(intValue)));
    out.Set("float", Napi::Number::New(env, floatValue));
    deferred_.Resolve(out);
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Env().Null()); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_, targetFn_;
  std::vector<uintptr_t> args_;
  int floatArgIndex_;
  uint32_t floatArgBits_;
  bool ok_ = false;
  uint8_t intResult_[8] = {0};
  uint8_t floatResult_[8] = {0};
  Napi::Promise::Deferred deferred_;
};

// args: up to 4 hex-string values, positional — for the one position (if
// any) that's actually a float argument (e.g. Character.SetHealth's
// `health`), pass any placeholder there (e.g. "0x0") and supply the real
// value via floatArgIndex/floatArgValue instead; the stub loads that
// position from XMM, not from args[], when floatArgIndex names it.
Napi::Value MonoCallAttached(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsString() ||
      (info.Length() > 3 && !info[3].IsArray())) {
    Napi::TypeError::New(
        env,
        "monoCallAttached(handle, monoDllBase, functionAddress, args?, floatArgIndex?, floatArgValue?) "
        "expects (number, string, string, string[]?, number?, number?)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t targetFn = ParseHex(info[2].As<Napi::String>().Utf8Value());

  std::vector<uintptr_t> args;
  if (info.Length() > 3 && info[3].IsArray()) {
    Napi::Array arr = info[3].As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length() && i < 4; i++) {
      Napi::Value v = arr.Get(i);
      if (!v.IsString()) {
        Napi::TypeError::New(env, "monoCallAttached: each arg must be a hex string")
            .ThrowAsJavaScriptException();
        return env.Null();
      }
      args.push_back(ParseHex(v.As<Napi::String>().Utf8Value()));
    }
  }

  int floatArgIndex = -1;
  uint32_t floatArgBits = 0;
  if (info.Length() > 4 && info[4].IsNumber() && info.Length() > 5 && info[5].IsNumber()) {
    floatArgIndex = info[4].As<Napi::Number>().Int32Value();
    float floatArgValue = info[5].As<Napi::Number>().FloatValue();
    memcpy(&floatArgBits, &floatArgValue, sizeof(floatArgBits));
  }

  auto* worker =
      new MonoCallAttachedWorker(env, handle, monoDllBase, targetFn, std::move(args), floatArgIndex, floatArgBits);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}
