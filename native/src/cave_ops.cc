#include "cave_ops.h"
#include "platform/platform.h"
#include <string>
#include <vector>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include "Zydis.h"

namespace {

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

std::string ToHex(uintptr_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}

constexpr size_t kCaveSize = 4096;

// True if this instruction computes anything from where it sits, and would
// therefore mean something different after being moved into a cave.
bool IsPositionDependent(const ZydisDecodedInstruction& insn,
                         const ZydisDecodedOperand* ops) {
  for (int i = 0; i < insn.operand_count; i++) {
    const ZydisDecodedOperand& op = ops[i];
    if (op.type == ZYDIS_OPERAND_TYPE_MEMORY && op.mem.base == ZYDIS_REGISTER_RIP)
      return true;
    // Relative branches encode a displacement from the NEXT instruction, so
    // relocating one silently retargets it. Zydis marks these operands.
    if (op.type == ZYDIS_OPERAND_TYPE_IMMEDIATE && op.imm.is_relative) return true;
  }
  return false;
}

} // namespace

Napi::Value AllocateCave(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  platform::ProcessHandle h = static_cast<platform::ProcessHandle>(
      info[0].As<Napi::Number>().Int64Value());
  uintptr_t near = ParseHex(info[1].As<Napi::String>().Utf8Value());

  uintptr_t cave = platform::AllocateNear(h, near, kCaveSize);
  if (!cave) return env.Null();
  return Napi::String::New(env, ToHex(cave));
}

Napi::Value DecodeRun(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  platform::ProcessHandle h = static_cast<platform::ProcessHandle>(
      info[0].As<Napi::Number>().Int64Value());
  uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());
  size_t minBytes = (size_t)info[2].As<Napi::Number>().Uint32Value();

  // A short read is normal near the end of a mapping — decode whatever came
  // back rather than refusing, and let the decode loop stop when it runs out.
  uint8_t window[64] = {0};
  size_t got = sizeof(window);
  if (!platform::ReadMemory(h, address, window, sizeof(window))) {
    got = 0;
    for (size_t probe = sizeof(window) / 2; probe >= 1; probe /= 2) {
      if (platform::ReadMemory(h, address, window, probe)) { got = probe; break; }
    }
  }

  ZydisDecoder decoder;
  ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);

  size_t offset = 0;
  bool relocatable = true;
  bool decodable = true;
  while (offset < minBytes) {
    ZydisDecodedInstruction insn;
    ZydisDecodedOperand ops[ZYDIS_MAX_OPERAND_COUNT];
    if (offset >= got ||
        !ZYAN_SUCCESS(ZydisDecoderDecodeFull(&decoder, window + offset,
                                             got - offset, &insn, ops))) {
      decodable = false;
      break;
    }
    if (IsPositionDependent(insn, ops)) relocatable = false;
    offset += insn.length;
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("length", Napi::Number::New(env, (double)offset));
  result.Set("decodable", Napi::Boolean::New(env, decodable));
  result.Set("relocatable", Napi::Boolean::New(env, decodable && relocatable));
  return result;
}
