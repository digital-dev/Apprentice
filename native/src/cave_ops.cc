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

// True if control never falls through to whatever follows this instruction
// in the byte stream — a different hazard than IsPositionDependent's: not
// that the instruction computes something from where it sits, but that
// nothing placed after it in a displaced run would ever execute. A cave's
// whole point is `displaced + effect + jumpBack`, replayed in that order so
// the game's own instructions run, then the forced effect runs, then
// control returns; a RET/unconditional-JMP/INT3/INT1/UD0/UD1/UD2/HLT
// anywhere in that run ends execution right there, silently turning the
// effect and jump-back into dead code — an installed cheat that reports
// success and does nothing. Direct (relative) CALL/JMP are not listed here:
// their relative-immediate operand already makes IsPositionDependent refuse
// them. An INDIRECT call IS refused here even though it does return control
// to the very next byte — the hazard for it is different: that return
// address now points inside our allocation, which carries no unwind data,
// so any SEH unwind or stack walk that has to cross this frame (an
// exception thrown by the callee, a crash reporter, an anti-cheat/profiler
// walking the stack) fails there; the callee's own behavior is also
// unverifiable at install time. Fail-closed rather than risk either.
bool IsFlowTerminating(const ZydisDecodedInstruction& insn,
                       const ZydisDecodedOperand* ops) {
  switch (insn.mnemonic) {
    case ZYDIS_MNEMONIC_RET:
    case ZYDIS_MNEMONIC_IRET:
    case ZYDIS_MNEMONIC_IRETD:
    case ZYDIS_MNEMONIC_IRETQ:
    case ZYDIS_MNEMONIC_INT1:
    case ZYDIS_MNEMONIC_INT3:
    case ZYDIS_MNEMONIC_UD0:
    case ZYDIS_MNEMONIC_UD1:
    case ZYDIS_MNEMONIC_UD2:
    case ZYDIS_MNEMONIC_HLT:
    case ZYDIS_MNEMONIC_JMP:
      return true;
    case ZYDIS_MNEMONIC_CALL:
      for (int i = 0; i < insn.operand_count; i++) {
        if (ops[i].type == ZYDIS_OPERAND_TYPE_IMMEDIATE && ops[i].imm.is_relative) {
          return false; // direct call — already refused via IsPositionDependent
        }
      }
      return true; // indirect call
    default:
      return false;
  }
}

std::string BytesToHex(const uint8_t* data, size_t len) {
  std::string out;
  char hb[4];
  for (size_t i = 0; i < len; i++) {
    snprintf(hb, sizeof(hb), "%02x", data[i]);
    out += hb;
  }
  return out;
}

// Only the 16 general-purpose 64-bit registers can hold an object pointer,
// so an unknown name is a caller bug, not something to guess at.
ZydisRegister RegisterByName(const std::string& name) {
  static const struct { const char* name; ZydisRegister reg; } kMap[] = {
    {"rax", ZYDIS_REGISTER_RAX}, {"rbx", ZYDIS_REGISTER_RBX},
    {"rcx", ZYDIS_REGISTER_RCX}, {"rdx", ZYDIS_REGISTER_RDX},
    {"rsi", ZYDIS_REGISTER_RSI}, {"rdi", ZYDIS_REGISTER_RDI},
    {"rbp", ZYDIS_REGISTER_RBP}, {"rsp", ZYDIS_REGISTER_RSP},
    {"r8", ZYDIS_REGISTER_R8},   {"r9", ZYDIS_REGISTER_R9},
    {"r10", ZYDIS_REGISTER_R10}, {"r11", ZYDIS_REGISTER_R11},
    {"r12", ZYDIS_REGISTER_R12}, {"r13", ZYDIS_REGISTER_R13},
    {"r14", ZYDIS_REGISTER_R14}, {"r15", ZYDIS_REGISTER_R15},
  };
  for (const auto& e : kMap) if (name == e.name) return e.reg;
  return ZYDIS_REGISTER_NONE;
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
    if (IsFlowTerminating(insn, ops)) relocatable = false;
    offset += insn.length;
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("length", Napi::Number::New(env, (double)offset));
  result.Set("decodable", Napi::Boolean::New(env, decodable));
  result.Set("relocatable", Napi::Boolean::New(env, decodable && relocatable));
  return result;
}

// Hand-encoded rather than routed through Zydis: `jmp rel32` is one opcode
// and a signed displacement from the END of the instruction, and encoding it
// directly keeps the arithmetic visible at the one place it matters.
Napi::Value EncodeJump(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uintptr_t from = ParseHex(info[0].As<Napi::String>().Utf8Value());
  uintptr_t to = ParseHex(info[1].As<Napi::String>().Utf8Value());

  int64_t rel = (int64_t)to - (int64_t)(from + 5);
  if (rel > INT32_MAX || rel < INT32_MIN) {
    Napi::Error::New(env, "jump target out of rel32 range")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  int32_t rel32 = (int32_t)rel;
  uint8_t bytes[5];
  bytes[0] = 0xE9;
  memcpy(bytes + 1, &rel32, sizeof(rel32));
  return Napi::String::New(env, BytesToHex(bytes, sizeof(bytes)));
}

Napi::Value EncodeStore(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string regName = info[0].As<Napi::String>().Utf8Value();
  int64_t offset = info[1].As<Napi::Number>().Int64Value();
  uint32_t imm = info[2].As<Napi::Number>().Uint32Value();

  ZydisRegister reg = RegisterByName(regName);
  if (reg == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown base register").ThrowAsJavaScriptException();
    return env.Null();
  }

  ZydisEncoderRequest req;
  memset(&req, 0, sizeof(req));
  req.mnemonic = ZYDIS_MNEMONIC_MOV;
  req.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
  req.operand_count = 2;
  req.operands[0].type = ZYDIS_OPERAND_TYPE_MEMORY;
  req.operands[0].mem.base = reg;
  req.operands[0].mem.displacement = offset;
  req.operands[0].mem.size = 4; // dword: int32 and float alike
  req.operands[1].type = ZYDIS_OPERAND_TYPE_IMMEDIATE;
  req.operands[1].imm.u = imm;

  uint8_t buf[ZYDIS_MAX_INSTRUCTION_LENGTH];
  ZyanUSize len = sizeof(buf);
  if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&req, buf, &len))) {
    Napi::Error::New(env, "failed to encode store").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::String::New(env, BytesToHex(buf, (size_t)len));
}

// `mov [rip+disp], reg` — the displacement is relative to the END of the
// instruction, whose length depends on the displacement's own encoding, so
// encode once with a placeholder to learn the length, then again with the
// real value. Assembling for a known cave address is what makes a
// RIP-relative instruction safe here: unlike a displaced one, it is built
// for exactly where it will execute and never moves afterwards.
Napi::Value EncodeCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string regName = info[0].As<Napi::String>().Utf8Value();
  uintptr_t at = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t slot = ParseHex(info[2].As<Napi::String>().Utf8Value());

  ZydisRegister reg = RegisterByName(regName);
  if (reg == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown base register").ThrowAsJavaScriptException();
    return env.Null();
  }

  uint8_t buf[ZYDIS_MAX_INSTRUCTION_LENGTH];
  ZyanUSize len = 0;
  int64_t disp = 0;

  for (int pass = 0; pass < 2; pass++) {
    ZydisEncoderRequest req;
    memset(&req, 0, sizeof(req));
    req.mnemonic = ZYDIS_MNEMONIC_MOV;
    req.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
    req.operand_count = 2;
    req.operands[0].type = ZYDIS_OPERAND_TYPE_MEMORY;
    req.operands[0].mem.base = ZYDIS_REGISTER_RIP;
    req.operands[0].mem.displacement = disp;
    req.operands[0].mem.size = 8;
    req.operands[1].type = ZYDIS_OPERAND_TYPE_REGISTER;
    req.operands[1].reg.value = reg;

    len = sizeof(buf);
    if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&req, buf, &len))) {
      Napi::Error::New(env, "failed to encode capture").ThrowAsJavaScriptException();
      return env.Null();
    }
    disp = (int64_t)slot - (int64_t)(at + len);
  }

  return Napi::String::New(env, BytesToHex(buf, (size_t)len));
}

// Thin N-API wrapper over platform::SuspendAll/ResumeAll (Task 2). No OS
// calls of their own: everything goes through platform::.
Napi::Value SuspendThreads(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  platform::ProcessHandle h = static_cast<platform::ProcessHandle>(
      info[0].As<Napi::Number>().Int64Value());
  uint32_t pid = info[1].As<Napi::Number>().Uint32Value();

  if (!platform::SuspendAll(h, pid)) {
    Napi::Error::New(env, "failed to suspend every thread")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Boolean::New(env, true);
}

Napi::Value ResumeThreads(const Napi::CallbackInfo& info) {
  platform::ResumeAll();
  return info.Env().Undefined();
}
