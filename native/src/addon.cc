#include <napi.h>
#include "Zydis.h"
#include "process_utils.h"
#include "scanner.h"
#include "pointer.h"
#include "memory_ops.h"

#include <string>
#include <vector>

Napi::Value Ping(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "pong");
}

// Temporary: proves Zydis is compiled and linked. Decodes the first
// instruction in a hex-encoded byte string. Removed in Task 5.
static uint8_t HexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return 0;
}

Napi::Value DecodeAt(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string hex = info[0].As<Napi::String>().Utf8Value();
  std::vector<uint8_t> bytes;
  for (size_t i = 0; i + 1 < hex.size(); i += 2) {
    bytes.push_back((HexNibble(hex[i]) << 4) | HexNibble(hex[i + 1]));
  }

  ZydisDecoder decoder;
  ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);
  ZydisDecodedInstruction insn;
  ZydisDecodedOperand operands[ZYDIS_MAX_OPERAND_COUNT];
  ZyanStatus status = ZydisDecoderDecodeFull(&decoder, bytes.data(), bytes.size(),
      &insn, operands);

  Napi::Object result = Napi::Object::New(env);
  if (!ZYAN_SUCCESS(status)) {
    result.Set("mnemonic", Napi::String::New(env, "decode-failed"));
    result.Set("length", Napi::Number::New(env, 0));
    return result;
  }
  result.Set("mnemonic",
      Napi::String::New(env, ZydisMnemonicGetString(insn.mnemonic)));
  result.Set("length", Napi::Number::New(env, insn.length));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Cold-start workaround, confirmed reproducible on a clean tree (no
  // debug instrumentation) via tests/native/scanner.test.ts run in
  // isolation and a standalone ad-hoc probe script calling attach()
  // fresh: without this line,
  // the very first Napi::Number::New(...) created in a fresh addon
  // Environment (one per worker thread/process, since this addon is
  // context-aware) reads back on the JS side as a denormalized double
  // (e.g. attach()'s `handle` field arriving as ~3e-313 instead of a
  // small integer), which then breaks every downstream use of that
  // value (e.g. scanFirst's reinterpret_cast<HANDLE> becomes garbage
  // and VirtualQueryEx fails immediately, yielding zero candidates).
  // Every Number created after this first one is fine.
  //
  // Root cause is NOT understood — this is not V8/N-API's documented
  // behavior and no UB was found in this addon's code paths that would
  // explain it. Do not extend this pattern elsewhere without also
  // reproducing it there; treat it as a confirmed but unexplained
  // toolchain quirk, not a general N-API property.
  //
  // (An earlier version of this comment additionally cited
  // listProcesses()'s first entry showing pid: 0 as corruption
  // evidence. That was a misdiagnosis: pid 0 is the genuine PID of the
  // Windows System Idle Process, not a corrupted value. That evidence
  // has been retracted; only the handle-corruption reproduction above
  // is relied on.)
  Napi::Number::New(env, 0.0);

  exports.Set("ping", Napi::Function::New(env, Ping));
  exports.Set("listProcesses", Napi::Function::New(env, ListProcesses));
  exports.Set("attach", Napi::Function::New(env, Attach));
  exports.Set("scanFirst", Napi::Function::New(env, ScanFirst));
  exports.Set("scanNext", Napi::Function::New(env, ScanNext));
  exports.Set("resolvePointerChain", Napi::Function::New(env, ResolvePointerChain));
  exports.Set("getModuleBase", Napi::Function::New(env, GetModuleBase));
  exports.Set("readValue", Napi::Function::New(env, ReadValue));
  exports.Set("writeValue", Napi::Function::New(env, WriteValue));
  exports.Set("decodeAt", Napi::Function::New(env, DecodeAt));
  return exports;
}

NODE_API_MODULE(memory_addon, Init)
