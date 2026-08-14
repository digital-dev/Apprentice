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
} // namespace

Napi::Value ResolveExport(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(env, "resolveExport(handle, moduleBase, name) expects (number, string, string)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t moduleBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  std::string name = info[2].As<Napi::String>().Utf8Value();

  uintptr_t addr = platform::ResolveExport(handle, moduleBase, name);
  if (addr == 0) return env.Null();
  return Napi::String::New(env, ToHex(addr));
}

// A simple, synchronous create-wait-close for this task's proof; Task 3's
// callRemoteFunction wraps the same three platform calls in an AsyncWorker
// so the interesting, potentially-slower version doesn't block Electron's
// main thread. This one exists to test CreateRemoteThread/WaitForRemote
// Thread/CloseRemoteThread in isolation, on a trivial one-argument target.
Napi::Value CreateRemoteThread(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(env, "createRemoteThread(handle, startAddress, param) expects (number, string, string)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t startAddress = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t param = ParseHex(info[2].As<Napi::String>().Utf8Value());

  platform::ThreadHandle thread = platform::CreateRemoteThread(handle, startAddress, param);
  if (thread == 0) return Napi::Boolean::New(env, false);

  bool ok = platform::WaitForRemoteThread(thread, 2000);
  platform::CloseRemoteThread(thread);
  return Napi::Boolean::New(env, ok);
}

namespace {

// Builds a small stub, hand-encoded the same way EncodeJump in cave_ops.cc
// is — the byte layout here is exactly what matters, so it is written
// directly rather than through Zydis's encoder. Windows x64 calling
// convention: the first four integer/pointer arguments go in RCX, RDX, R8,
// R9. The stub loads up to 4 args, adjusts the stack for the call, calls
// the target function, writes its 8-byte return value (RAX) to
// resultAddress, and returns 0 as the thread's exit code.
//
// Stack alignment: CreateRemoteThread starts this stub the same way any
// x64 call is made — through a real `call` in ntdll's thread-start
// trampoline — so the ABI's usual invariant holds at entry: RSP is 8 mod 16
// (a `call` always leaves RSP 0 mod 16 at the CALLEE it invokes only after
// accounting for its own pushed return address; concretely, immediately
// inside any function reached via `call`, RSP sits 8 mod 16, one push short
// of the 16-alignment a nested `call` requires). `sub rsp, 0x28` (40, which
// is 8 mod 16) lands exactly on 0 mod 16 for the `call rax` below, while
// also carving out the mandatory 0x20 shadow space in the same
// instruction. `add rsp, 0x28` afterward is `sub`'s exact inverse (unlike
// an `and`, which would be destructive and irreversible), so RSP is back
// to its entry value before the closing `ret` — which must pop the exact
// return address the thread-start trampoline pushed, or the thread (and
// the whole process, once it runs off into whatever garbage a wrong `ret`
// lands on) corrupts on exit.
//
//   mov rcx, args[0]      48 B9 <imm64>   (10 bytes, 0 if unused)
//   mov rdx, args[1]      48 BA <imm64>   (10 bytes)
//   mov r8,  args[2]      49 B8 <imm64>   (10 bytes)
//   mov r9,  args[3]      49 B9 <imm64>   (10 bytes)
//   mov rax, function     48 B8 <imm64>   (10 bytes)
//   sub rsp, 0x28         48 83 EC 28     (4 bytes)  -- align + shadow space
//   call rax              FF D0           (2 bytes)
//   add rsp, 0x28         48 83 C4 28     (4 bytes)  -- exact inverse of the sub above
//   mov rcx, resultAddr   48 B9 <imm64>   (10 bytes)
//   mov [rcx], rax        48 89 01        (3 bytes)
//   xor eax, eax          31 C0           (2 bytes)
//   ret                   C3              (1 byte)
std::vector<uint8_t> BuildCallStub(uintptr_t function,
                                   const std::vector<uintptr_t>& args,
                                   uintptr_t resultAddress) {
  std::vector<uint8_t> out;
  auto emitMovImm64 = [&](uint8_t opcodeByte, bool rex49, uintptr_t imm) {
    out.push_back(rex49 ? 0x49 : 0x48);
    out.push_back(opcodeByte);
    for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>(imm >> (i * 8)));
  };

  uintptr_t a0 = args.size() > 0 ? args[0] : 0;
  uintptr_t a1 = args.size() > 1 ? args[1] : 0;
  uintptr_t a2 = args.size() > 2 ? args[2] : 0;
  uintptr_t a3 = args.size() > 3 ? args[3] : 0;

  emitMovImm64(0xB9, false, a0);       // mov rcx, a0
  emitMovImm64(0xBA, false, a1);       // mov rdx, a1
  emitMovImm64(0xB8, true, a2);        // mov r8,  a2
  emitMovImm64(0xB9, true, a3);        // mov r9,  a3
  emitMovImm64(0xB8, false, function); // mov rax, function

  out.insert(out.end(), {0x48, 0x83, 0xEC, 0x28}); // sub rsp, 0x28
  out.insert(out.end(), {0xFF, 0xD0});             // call rax
  out.insert(out.end(), {0x48, 0x83, 0xC4, 0x28}); // add rsp, 0x28

  emitMovImm64(0xB9, false, resultAddress); // mov rcx, resultAddress
  out.insert(out.end(), {0x48, 0x89, 0x01}); // mov [rcx], rax
  // mov [rcx+8], xmm0 — 66 0F D6 /r (MOVQ xmm/m64, xmm), ModRM 01 000 001
  // (mod=01 disp8, reg=000=xmm0, rm=001=rcx) + disp8 0x08. Captures the
  // callee's float/double return value, which the x64 calling convention
  // places in XMM0, never RAX — RAX alone (the only thing this stub used
  // to capture) is meaningless for a function like Character.GetHealth().
  // Unconditional: harmless for callees that return int/pointer (XMM0 is
  // simply whatever it was, and callers that only read result[0..8) never
  // see it), needed for callees that return float/double.
  out.insert(out.end(), {0x66, 0x0F, 0xD6, 0x41, 0x08});
  out.insert(out.end(), {0x31, 0xC0});       // xor eax, eax
  out.push_back(0xC3);                       // ret

  return out;
}

// The stub above, plus its 16-byte result slot (8 for RAX, 8 for XMM0),
// fits comfortably in a single cave. The result slot sits at cave+0 and
// the stub code at cave+16, matching cave_ops.cc's own documented
// slot-then-code layout (just a wider slot than the original 8 bytes).
constexpr uintptr_t kResultOffset = 0;
constexpr uintptr_t kCodeOffset = 16;

} // namespace

bool RunRemoteCall(platform::ProcessHandle handle, uintptr_t function,
                    const std::vector<uintptr_t>& args, uint8_t result[8],
                    uint8_t floatResult[8]) {
  // Refuse before touching the target at all unless `function` is backed by
  // executable memory right now. `call rax` to an address that isn't raises
  // an access violation INSIDE the target process, not just in our
  // throwaway thread — and a real game (like this test's harness) has no
  // exception handler installed for it, so Windows tears down the whole
  // process rather than just failing our call. That is a materially worse
  // outcome than "this remote call failed", and every later task's
  // Mono-resolved function addresses need exactly this protection: they
  // come from calls made elsewhere in the target, with no guarantee they're
  // still valid by the time we get here.
  platform::Region region;
  if (!platform::QueryRegion(handle, function, region) || !region.executable) return false;

  uintptr_t cave = platform::AllocateNear(handle, function, 256);
  if (!cave) return false;

  std::vector<uint8_t> stub = BuildCallStub(function, args, cave + kResultOffset);
  if (!platform::WriteMemory(handle, cave + kCodeOffset, stub.data(), stub.size())) {
    platform::FreeMemory(handle, cave);
    return false;
  }

  platform::ThreadHandle thread =
      platform::CreateRemoteThread(handle, cave + kCodeOffset, 0);
  if (!thread) {
    platform::FreeMemory(handle, cave);
    return false;
  }

  bool finished = platform::WaitForRemoteThread(thread, 2000);
  platform::CloseRemoteThread(thread);

  // Found necessary empirically, not a precaution: a caller that walks
  // Mono metadata one item at a time (searching assemblies for a class,
  // iterating a class's fields) calls this in a tight loop, and a burst of
  // on the order of a hundred CreateRemoteThread/CloseHandle cycles within
  // a couple of seconds against a real game correlated directly with the
  // target process crashing shortly afterward — every time, across
  // multiple separate live sessions. No single call was ever pointed at
  // bad data (the executable-region guard above already rules that out),
  // so the actual stressor is the RATE of native thread churn, not any one
  // call's correctness. This spaces successive threads out; it does
  // nothing for a caller that only ever makes one call.
  platform::SleepMs(10);

  // Never read the result slot, and never treat the cave as free to
  // reuse, unless the thread genuinely finished — see the never-free-a-
  // live-cave rule. A caller only sees `null`; the cave is deliberately
  // leaked in the timeout case rather than freed out from under a thread
  // that might still be running inside it, the same trade-off #7 already
  // made for a failed install.
  if (!finished) return false;

  if (!platform::ReadMemory(handle, cave + kResultOffset, result, 8)) {
    platform::FreeMemory(handle, cave);
    return false;
  }
  if (floatResult != nullptr) {
    if (!platform::ReadMemory(handle, cave + kResultOffset + 8, floatResult, 8)) {
      platform::FreeMemory(handle, cave);
      return false;
    }
  }
  platform::FreeMemory(handle, cave);
  return true;
}

class RemoteCallWorker : public Napi::AsyncWorker {
 public:
  RemoteCallWorker(Napi::Env env, platform::ProcessHandle handle,
                   uintptr_t function, std::vector<uintptr_t> args)
      : Napi::AsyncWorker(env),
        handle_(handle),
        function_(function),
        args_(std::move(args)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    ok_ = RunRemoteCall(handle_, function_, args_, result_);
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (!ok_) {
      deferred_.Resolve(env.Null());
      return;
    }
    char hex[20];
    snprintf(hex, sizeof(hex), "0x%02x%02x%02x%02x%02x%02x%02x%02x",
             result_[7], result_[6], result_[5], result_[4],
             result_[3], result_[2], result_[1], result_[0]);
    deferred_.Resolve(Napi::String::New(env, hex));
  }

  void OnError(const Napi::Error&) override { deferred_.Resolve(Env().Null()); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t function_;
  std::vector<uintptr_t> args_;
  bool ok_ = false;
  uint8_t result_[8] = {0};
  Napi::Promise::Deferred deferred_;
};

Napi::Value CallRemoteFunction(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsArray()) {
    Napi::TypeError::New(env, "callRemoteFunction(handle, functionAddress, args) expects (number, string, string[])")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t function = ParseHex(info[1].As<Napi::String>().Utf8Value());

  Napi::Array arr = info[2].As<Napi::Array>();
  std::vector<uintptr_t> args;
  for (uint32_t i = 0; i < arr.Length() && i < 4; i++) {
    Napi::Value v = arr.Get(i);
    if (!v.IsString()) {
      Napi::TypeError::New(env, "callRemoteFunction: each arg must be a hex string")
          .ThrowAsJavaScriptException();
      return env.Null();
    }
    args.push_back(ParseHex(v.As<Napi::String>().Utf8Value()));
  }

  auto* worker = new RemoteCallWorker(env, handle, function, std::move(args));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

// Same as RemoteCallWorker, but resolves the called function's XMM0
// register — interpreted as a 32-bit float — instead of RAX. For calling
// Mono methods that return float/double (e.g. Character.GetHealth()),
// where RAX holds no meaningful value at all. Not a general "any return
// type" mechanism: this always reads XMM0 as a 4-byte float specifically,
// since that's the one live acceptance-testing need this exists for.
class RemoteCallFloatWorker : public Napi::AsyncWorker {
 public:
  RemoteCallFloatWorker(Napi::Env env, platform::ProcessHandle handle,
                        uintptr_t function, std::vector<uintptr_t> args)
      : Napi::AsyncWorker(env),
        handle_(handle),
        function_(function),
        args_(std::move(args)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    ok_ = RunRemoteCall(handle_, function_, args_, intResult_, floatResult_);
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (!ok_) {
      deferred_.Resolve(env.Null());
      return;
    }
    float v;
    memcpy(&v, floatResult_, sizeof(v));
    deferred_.Resolve(Napi::Number::New(env, v));
  }

  void OnError(const Napi::Error&) override { deferred_.Resolve(Env().Null()); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t function_;
  std::vector<uintptr_t> args_;
  bool ok_ = false;
  uint8_t intResult_[8] = {0};
  uint8_t floatResult_[8] = {0};
  Napi::Promise::Deferred deferred_;
};

Napi::Value CallRemoteFunctionFloat(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsArray()) {
    Napi::TypeError::New(env, "callRemoteFunctionFloat(handle, functionAddress, args) expects (number, string, string[])")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t function = ParseHex(info[1].As<Napi::String>().Utf8Value());

  Napi::Array arr = info[2].As<Napi::Array>();
  std::vector<uintptr_t> args;
  for (uint32_t i = 0; i < arr.Length() && i < 4; i++) {
    Napi::Value v = arr.Get(i);
    if (!v.IsString()) {
      Napi::TypeError::New(env, "callRemoteFunctionFloat: each arg must be a hex string")
          .ThrowAsJavaScriptException();
      return env.Null();
    }
    args.push_back(ParseHex(v.As<Napi::String>().Utf8Value()));
  }

  auto* worker = new RemoteCallFloatWorker(env, handle, function, std::move(args));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}
