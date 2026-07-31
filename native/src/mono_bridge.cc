#include "mono_bridge.h"
#include "mono_call.h"
#include "platform/platform.h"
#include <cstdio>
#include <cstring>
#include <string>
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
  if (!platform::WriteMemory(handle, cave, buf.data(), buf.size())) return 0;
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

} // namespace

class MonoResolveClassWorker : public Napi::AsyncWorker {
 public:
  MonoResolveClassWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase,
                         std::string namespaceName, std::string className)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase),
        namespaceName_(std::move(namespaceName)), className_(std::move(className)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    MonoContext ctx = AttachToMono(handle_, monoDllBase_);
    if (!ctx.ok) return;

    // NOTE: real mono_class_from_name takes a MonoImage*, not a domain —
    // resolving an image from an assembly is Task 7's job (assembly
    // enumeration). For this task, callers pass the image handle directly
    // via SetImageHandle — see monoResolver.ts's resolveClass, which
    // threads a caller-supplied image handle through (0 for this task's
    // test fixture, whose fake mono_class_from_name ignores it entirely).
    uintptr_t classFromName = platform::ResolveExport(handle_, monoDllBase_, "mono_class_from_name");
    if (!classFromName) { DetachFromMono(handle_, monoDllBase_, ctx); return; }

    uintptr_t nsAddr = WriteString(handle_, monoDllBase_, namespaceName_);
    uintptr_t nameAddr = WriteString(handle_, monoDllBase_, className_);
    if (!nsAddr || !nameAddr) { DetachFromMono(handle_, monoDllBase_, ctx); return; }

    uint8_t result[8] = {0};
    if (RunRemoteCall(handle_, classFromName, {imageHandle_, nsAddr, nameAddr}, result)) {
      uintptr_t classHandle = BytesToPtr(result);
      if (classHandle) { classHandle_ = classHandle; ok_ = true; }
    }
    DetachFromMono(handle_, monoDllBase_, ctx);
  }

  void OnOK() override {
    if (!ok_) { deferred_.Resolve(Env().Null()); return; }
    deferred_.Resolve(Napi::String::New(Env(), ToHex(classHandle_)));
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Env().Null()); }

  void SetImageHandle(uintptr_t h) { imageHandle_ = h; }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_;
  uintptr_t imageHandle_ = 0;
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
  // Test fixture only: the fake host's mono_class_from_name ignores its
  // image argument entirely (see probe_mono.c), so 0 is fine here. The
  // real bridge (Task 7) threads a resolved MonoImage* through once
  // assembly/image enumeration exists — tracked there, not here.
  worker->SetImageHandle(0);
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

  void Execute() override {
    MonoContext ctx = AttachToMono(handle_, monoDllBase_);
    if (!ctx.ok) return;

    uintptr_t getFields = platform::ResolveExport(handle_, monoDllBase_, "mono_class_get_fields");
    uintptr_t getName = platform::ResolveExport(handle_, monoDllBase_, "mono_field_get_name");
    uintptr_t getOffset = platform::ResolveExport(handle_, monoDllBase_, "mono_field_get_offset");
    if (!getFields || !getName || !getOffset) { DetachFromMono(handle_, monoDllBase_, ctx); return; }

    uintptr_t iterSlot = platform::AllocateNear(handle_, monoDllBase_, 16);
    if (!iterSlot) { DetachFromMono(handle_, monoDllBase_, ctx); return; }
    uintptr_t zero = 0;
    platform::WriteMemory(handle_, iterSlot, &zero, sizeof(zero));

    for (int guard = 0; guard < 256; guard++) {
      uint8_t result[8] = {0};
      if (!RunRemoteCall(handle_, getFields, {classHandle_, iterSlot}, result)) break;
      uintptr_t field = BytesToPtr(result);
      if (!field) break; // iteration exhausted

      uint8_t nameResult[8] = {0};
      if (!RunRemoteCall(handle_, getName, {field}, nameResult)) break;
      uintptr_t namePtr = BytesToPtr(nameResult);
      char nameBuf[256] = {0};
      if (!platform::ReadMemory(handle_, namePtr, nameBuf, sizeof(nameBuf) - 1)) continue;

      if (fieldName_ == nameBuf) {
        if (wantAddress_) {
          fieldAddress_ = field; // caller wants the field's own storage location
        } else {
          uint8_t offsetResult[8] = {0};
          if (RunRemoteCall(handle_, getOffset, {field}, offsetResult)) {
            offset_ = static_cast<int32_t>(BytesToPtr(offsetResult));
          }
        }
        ok_ = true;
        break;
      }
    }
    DetachFromMono(handle_, monoDllBase_, ctx);
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
