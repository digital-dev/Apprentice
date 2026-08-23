#include "cave_ops.h"
#include "platform/platform.h"
#include <string>
#include <vector>
#include <set>
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

// Records every 64-bit general-purpose register this instruction WRITES, by
// its largest enclosing name, into `out`.
//
// This exists because of a crash in a real game. A cave replays
// `displaced + effect + jumpBack` in that order, and the effect addresses
// the field through the base register the capture recorded. But `displaced`
// is not the captured instruction alone — decodeRun rounds up to whole
// instructions to reach the 5 bytes a jmp rel32 needs, so a short captured
// store drags in whatever follows it. If one of those swallowed
// instructions writes the base register, the effect dereferences a register
// the game has already repurposed.
//
// Observed in Valheim: `movss [rax], xmm5` (4 bytes) followed by
// `mov eax, 1`. Writing eax zero-extends across all of rax, so by the time
// the injected `mov dword [rax], imm32` ran, rax held 1 and the store
// faulted on address 0x1. Deterministic crash, every time.
//
// Note the 32-bit-write subtlety this must not miss: `mov eax, 1` names
// EAX, not RAX, yet it clobbers the whole register. GetLargestEnclosing is
// what collapses that back to RAX; comparing operand register names
// directly would let exactly the crashing case through.
void CollectWrittenRegisters(const ZydisDecodedInstruction& insn,
                             const ZydisDecodedOperand* ops,
                             std::set<std::string>& out) {
  for (int i = 0; i < insn.operand_count; i++) {
    const ZydisDecodedOperand& op = ops[i];
    if (op.type != ZYDIS_OPERAND_TYPE_REGISTER) continue;
    if (!(op.actions & ZYDIS_OPERAND_ACTION_MASK_WRITE)) continue;

    ZydisRegister widest =
        ZydisRegisterGetLargestEnclosing(ZYDIS_MACHINE_MODE_LONG_64, op.reg.value);
    if (widest == ZYDIS_REGISTER_NONE) continue;
    const char* name = ZydisRegisterGetString(widest);
    if (name) out.insert(name);
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

// The 16 128-bit XMM registers, for scale mode's floating-point source —
// distinct from RegisterByName because only a GPR can hold an object
// pointer (what every other injection mode's baseRegister needs), but only
// an XMM register can hold a float mid-computation (what scale's
// sourceRegister needs).
ZydisRegister XmmRegisterByName(const std::string& name) {
  static const struct { const char* name; ZydisRegister reg; } kMap[] = {
    {"xmm0", ZYDIS_REGISTER_XMM0},   {"xmm1", ZYDIS_REGISTER_XMM1},
    {"xmm2", ZYDIS_REGISTER_XMM2},   {"xmm3", ZYDIS_REGISTER_XMM3},
    {"xmm4", ZYDIS_REGISTER_XMM4},   {"xmm5", ZYDIS_REGISTER_XMM5},
    {"xmm6", ZYDIS_REGISTER_XMM6},   {"xmm7", ZYDIS_REGISTER_XMM7},
    {"xmm8", ZYDIS_REGISTER_XMM8},   {"xmm9", ZYDIS_REGISTER_XMM9},
    {"xmm10", ZYDIS_REGISTER_XMM10}, {"xmm11", ZYDIS_REGISTER_XMM11},
    {"xmm12", ZYDIS_REGISTER_XMM12}, {"xmm13", ZYDIS_REGISTER_XMM13},
    {"xmm14", ZYDIS_REGISTER_XMM14}, {"xmm15", ZYDIS_REGISTER_XMM15},
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

// Hex-string-taking JS export for platform::FreeMemory, mirroring
// AllocateCave's own handle+hex-string convention (ParseHex on the way in,
// nothing on the way out but the boolean result). Used to release a cave
// installInjection allocated but never redirected the game into — see
// patchEngine.ts's PatchOps.freeCave for the safety argument that makes
// that specific window safe to free in.
Napi::Value FreeCave(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  platform::ProcessHandle h = static_cast<platform::ProcessHandle>(
      info[0].As<Napi::Number>().Int64Value());
  uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());

  bool ok = platform::FreeMemory(h, address);
  return Napi::Boolean::New(env, ok);
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
  std::set<std::string> clobbered;
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
    CollectWrittenRegisters(insn, ops, clobbered);
    offset += insn.length;
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("length", Napi::Number::New(env, (double)offset));
  result.Set("decodable", Napi::Boolean::New(env, decodable));
  result.Set("relocatable", Napi::Boolean::New(env, decodable && relocatable));

  // Every 64-bit GPR the displaced run writes. The engine refuses to install
  // when the effect's base register is in here — see CollectWrittenRegisters.
  Napi::Array clobbers = Napi::Array::New(env, clobbered.size());
  uint32_t idx = 0;
  for (const std::string& reg : clobbered) {
    clobbers.Set(idx++, Napi::String::New(env, reg));
  }
  result.Set("clobbers", clobbers);
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

// mov [destReg+offset], srcReg — a 32-bit register-to-memory store,
// sibling to EncodeStore's register-to-immediate form. `copy` mode's
// entire reason to exist: force mode can only write a literal the
// installer already knew at capture time; this writes whatever the game
// itself is holding in a register at the moment the effect runs — the
// "set this field to what that other field/register currently is" shape
// real Auto Assembler scripts use and force mode structurally cannot
// represent.
Napi::Value EncodeStoreRegister(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string destRegName = info[0].As<Napi::String>().Utf8Value();
  int64_t offset = info[1].As<Napi::Number>().Int64Value();
  std::string srcRegName = info[2].As<Napi::String>().Utf8Value();

  ZydisRegister destReg = RegisterByName(destRegName);
  if (destReg == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown destination register").ThrowAsJavaScriptException();
    return env.Null();
  }
  ZydisRegister srcReg64 = RegisterByName(srcRegName);
  if (srcReg64 == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown source register").ThrowAsJavaScriptException();
    return env.Null();
  }
  // The destination memory operand is always written as a dword (int32 and
  // float alike, matching EncodeStore's own convention) — the source
  // register must be narrowed to its 32-bit form (eax, not rax) to match.
  ZydisRegister srcReg32 = ZydisRegisterGetLargestEnclosing(
      ZYDIS_MACHINE_MODE_LONG_64, srcReg64);
  // Largest-enclosing of a GPR name always yields the 64-bit form; step
  // back down to 32-bit via the encoder's own width table rather than a
  // second name lookup.
  srcReg32 = static_cast<ZydisRegister>(
      srcReg32 - ZYDIS_REGISTER_RAX + ZYDIS_REGISTER_EAX);

  ZydisEncoderRequest req;
  memset(&req, 0, sizeof(req));
  req.mnemonic = ZYDIS_MNEMONIC_MOV;
  req.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
  req.operand_count = 2;
  req.operands[0].type = ZYDIS_OPERAND_TYPE_MEMORY;
  req.operands[0].mem.base = destReg;
  req.operands[0].mem.displacement = offset;
  req.operands[0].mem.size = 4; // dword, matching EncodeStore
  req.operands[1].type = ZYDIS_OPERAND_TYPE_REGISTER;
  req.operands[1].reg.value = srcReg32;

  uint8_t buf[ZYDIS_MAX_INSTRUCTION_LENGTH];
  ZyanUSize len = sizeof(buf);
  if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&req, buf, &len))) {
    Napi::Error::New(env, "failed to encode register store").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::String::New(env, BytesToHex(buf, (size_t)len));
}

// mov eax, factorBits ; movd xmmScratch, eax ; mulss sourceXmmReg, xmmScratch
// — scale mode's whole effect: multiply the XMM register the game is about
// to store (source) by a runtime factor, in place, before the displaced run
// replays the game's own (unmodified) store instruction. xmmScratch is
// xmm0 unless the source itself is xmm0, in which case xmm1 — it only ever
// holds the factor bits, so any register other than the source works.
Napi::Value EncodeScale(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string srcRegName = info[0].As<Napi::String>().Utf8Value();
  uint32_t factorBits = info[1].As<Napi::Number>().Uint32Value();

  ZydisRegister srcReg = XmmRegisterByName(srcRegName);
  if (srcReg == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown source xmm register").ThrowAsJavaScriptException();
    return env.Null();
  }
  ZydisRegister scratchReg =
      (srcReg == ZYDIS_REGISTER_XMM0) ? ZYDIS_REGISTER_XMM1 : ZYDIS_REGISTER_XMM0;

  uint8_t buf[ZYDIS_MAX_INSTRUCTION_LENGTH];
  std::string out;

  {
    ZydisEncoderRequest req;
    memset(&req, 0, sizeof(req));
    req.mnemonic = ZYDIS_MNEMONIC_MOV;
    req.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
    req.operand_count = 2;
    req.operands[0].type = ZYDIS_OPERAND_TYPE_REGISTER;
    req.operands[0].reg.value = ZYDIS_REGISTER_EAX;
    req.operands[1].type = ZYDIS_OPERAND_TYPE_IMMEDIATE;
    req.operands[1].imm.u = factorBits;
    ZyanUSize len = sizeof(buf);
    if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&req, buf, &len))) {
      Napi::Error::New(env, "failed to encode mov eax, imm32").ThrowAsJavaScriptException();
      return env.Null();
    }
    out += BytesToHex(buf, (size_t)len);
  }
  {
    ZydisEncoderRequest req;
    memset(&req, 0, sizeof(req));
    req.mnemonic = ZYDIS_MNEMONIC_MOVD;
    req.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
    req.operand_count = 2;
    req.operands[0].type = ZYDIS_OPERAND_TYPE_REGISTER;
    req.operands[0].reg.value = scratchReg;
    req.operands[1].type = ZYDIS_OPERAND_TYPE_REGISTER;
    req.operands[1].reg.value = ZYDIS_REGISTER_EAX;
    ZyanUSize len = sizeof(buf);
    if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&req, buf, &len))) {
      Napi::Error::New(env, "failed to encode movd").ThrowAsJavaScriptException();
      return env.Null();
    }
    out += BytesToHex(buf, (size_t)len);
  }
  {
    ZydisEncoderRequest req;
    memset(&req, 0, sizeof(req));
    req.mnemonic = ZYDIS_MNEMONIC_MULSS;
    req.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
    req.operand_count = 2;
    req.operands[0].type = ZYDIS_OPERAND_TYPE_REGISTER;
    req.operands[0].reg.value = srcReg;
    req.operands[1].type = ZYDIS_OPERAND_TYPE_REGISTER;
    req.operands[1].reg.value = scratchReg;
    ZyanUSize len = sizeof(buf);
    if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&req, buf, &len))) {
      Napi::Error::New(env, "failed to encode mulss").ThrowAsJavaScriptException();
      return env.Null();
    }
    out += BytesToHex(buf, (size_t)len);
  }
  return Napi::String::New(env, out);
}

// `mov [rip+disp], reg` — the displacement is relative to the END of the
// instruction, whose length depends on the displacement's own encoding, so
// encode once with a placeholder to learn the length, then again with the
// real value. Assembling for a known cave address is what makes a
// RIP-relative instruction safe here: unlike a displaced one, it is built
// for exactly where it will execute and never moves afterwards.
// Emits the whole capture-once blob, hand-encoded so the jump-over
// distance and both RIP displacements are computed in one place against
// one agreed layout — split across separate encoders they drift apart
// silently and the cave jumps into the middle of an instruction.
//
// Why once rather than every execution: the instruction a capture rides on
// is usually shared. Valheim's health setter runs for the player, every
// enemy and every destructible, so a slot rewritten on each execution holds
// whatever was hit last, and a cheat reading it follows that instead of the
// player. Writing only into an empty slot pins the first object seen after
// arming — stand somewhere safe, enable, and it is yours for the session.
// Re-arming is toggling the patch off and on, which builds a fresh cave
// with a zeroed slot.
//
//   pushfq                      the game's flags must survive the compare
//   cmp qword [rip+d1], 0
//   jne skip                    already captured; leave it alone
//   mov [rip+d2], reg           first one wins
//   skip:
//   popfq
Napi::Value EncodeCaptureOnce(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string regName = info[0].As<Napi::String>().Utf8Value();
  uintptr_t at = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t slot = ParseHex(info[2].As<Napi::String>().Utf8Value());

  // Only the 16 GPRs can hold an object pointer; RegisterByName rejects
  // anything else, and the encoding below needs its number and REX bit.
  if (RegisterByName(regName) == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown base register").ThrowAsJavaScriptException();
    return env.Null();
  }
  static const char* kOrder[16] = {"rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi",
                                   "r8",  "r9",  "r10", "r11", "r12", "r13", "r14", "r15"};
  int regNum = 0;
  for (int i = 0; i < 16; i++) {
    if (regName == kOrder[i]) { regNum = i; break; }
  }
  const bool extended = regNum >= 8;      // r8-r15 need REX.R
  const uint8_t rex = extended ? 0x4C : 0x48;
  const uint8_t modrm = (uint8_t)(0x05 | ((regNum & 0x7) << 3)); // mod=00, rm=101 (RIP)

  // Fixed layout, offsets from `at`:
  //   0  pushfq                    1 byte
  //   1  cmp qword [rip+d1], 0     8 bytes  (48 83 3d <d1> 00)
  //   9  jne +7                    2 bytes
  //   11 mov [rip+d2], reg         7 bytes  (REX 89 modrm <d2>)
  //   18 popfq                     1 byte
  // A RIP displacement is relative to the END of its own instruction.
  constexpr size_t kCmpEnd = 9;
  constexpr size_t kMovEnd = 18;
  constexpr size_t kTotal = 19;

  const int64_t d1 = (int64_t)slot - (int64_t)(at + kCmpEnd);
  const int64_t d2 = (int64_t)slot - (int64_t)(at + kMovEnd);
  if (d1 > INT32_MAX || d1 < INT32_MIN || d2 > INT32_MAX || d2 < INT32_MIN) {
    Napi::Error::New(env, "slot out of RIP-relative range").ThrowAsJavaScriptException();
    return env.Null();
  }
  const int32_t d1_32 = (int32_t)d1;
  const int32_t d2_32 = (int32_t)d2;

  uint8_t buf[kTotal];
  size_t i = 0;
  buf[i++] = 0x9C;                       // pushfq
  buf[i++] = 0x48; buf[i++] = 0x83; buf[i++] = 0x3D;
  memcpy(buf + i, &d1_32, 4); i += 4;
  buf[i++] = 0x00;                       // cmp ..., 0
  buf[i++] = 0x75; buf[i++] = 0x07;      // jne over the 7-byte mov
  buf[i++] = rex;  buf[i++] = 0x89; buf[i++] = modrm;
  memcpy(buf + i, &d2_32, 4); i += 4;
  buf[i++] = 0x9D;                       // popfq

  return Napi::String::New(env, BytesToHex(buf, kTotal));
}

// Emits the guard that makes a shared write apply to one object only.
//
// The problem it solves: a game's damage write is shared. NOPing it gave
// every enemy and destructible in Valheim god mode along with the player,
// because the instruction runs for all of them. The entity is in a register
// at that instruction, so the cave can compare it against a remembered one
// and skip the write for that entity alone.
//
// Self-arming: the slot starts empty and the first entity through fills it.
// Take one hit while nothing else is being damaged and it locks onto you for
// the session; toggling the patch off and on builds a fresh cave and re-arms.
// That avoids having to prove the object here is the same one some other
// capture site sees — a comparison against the wrong object fails silently,
// which is the worst way for a cheat to be wrong.
//
//   pushfq                    flags must survive test/cmp
//   push r11                  r11 is call-clobbered, but we are mid-function
//   mov  r11, [rip+d1]
//   test r11, r11
//   jnz  compare
//   mov  [rip+d2], reg        first entity through arms it
//   mov  r11, reg
//  compare:
//   cmp  reg, r11
//   jne  runOriginal          someone else: fall through to the replayed write
//   pop  r11 / popfq
//   jmp  return               it is us: skip the write entirely
//  runOriginal:
//   pop  r11 / popfq
//   (caller appends the displaced bytes and the jump back)
//
// The caller appends; this returns exactly the 41-byte prefix so the two
// exits and both RIP displacements are computed against one agreed layout.
Napi::Value EncodeGuardedSkip(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string regName = info[0].As<Napi::String>().Utf8Value();
  uintptr_t at = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t slot = ParseHex(info[2].As<Napi::String>().Utf8Value());
  uintptr_t returnTo = ParseHex(info[3].As<Napi::String>().Utf8Value());

  if (RegisterByName(regName) == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown base register").ThrowAsJavaScriptException();
    return env.Null();
  }
  static const char* kOrder[16] = {"rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi",
                                   "r8",  "r9",  "r10", "r11", "r12", "r13", "r14", "r15"};
  int r = 0;
  for (int i = 0; i < 16; i++) if (regName == kOrder[i]) { r = i; break; }

  // r11 is the scratch. Guarding an instruction whose own object register IS
  // r11 would have the push/pop fight the comparison, so refuse rather than
  // emit something subtly wrong.
  if (r == 11) {
    Napi::Error::New(env, "cannot guard on r11 — it is the scratch register")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  const bool ext = r >= 8;               // needs REX.R / REX.B
  const uint8_t low = (uint8_t)(r & 0x7);

  constexpr size_t kTotal = 41;
  constexpr size_t kMovR11End = 10;      // end of `mov r11,[rip+d1]`
  constexpr size_t kStoreEnd = 22;       // end of `mov [rip+d2],reg`
  constexpr size_t kJmpAt = 33;          // the player-exit `jmp rel32`

  const int64_t d1 = (int64_t)slot - (int64_t)(at + kMovR11End);
  const int64_t d2 = (int64_t)slot - (int64_t)(at + kStoreEnd);
  const int64_t rel = (int64_t)returnTo - (int64_t)(at + kJmpAt + 5);
  if (d1 > INT32_MAX || d1 < INT32_MIN || d2 > INT32_MAX || d2 < INT32_MIN ||
      rel > INT32_MAX || rel < INT32_MIN) {
    Napi::Error::New(env, "guard target out of 32-bit range").ThrowAsJavaScriptException();
    return env.Null();
  }
  const int32_t d1_32 = (int32_t)d1, d2_32 = (int32_t)d2, rel_32 = (int32_t)rel;

  uint8_t b[kTotal];
  size_t i = 0;
  b[i++] = 0x9C;                                   // pushfq
  b[i++] = 0x41; b[i++] = 0x53;                    // push r11
  b[i++] = 0x4C; b[i++] = 0x8B; b[i++] = 0x1D;     // mov r11, [rip+d1]
  memcpy(b + i, &d1_32, 4); i += 4;                // -> i == 10
  b[i++] = 0x4D; b[i++] = 0x85; b[i++] = 0xDB;     // test r11, r11
  b[i++] = 0x75; b[i++] = 0x0A;                    // jnz compare (over 10 bytes)
  b[i++] = (uint8_t)(0x48 | (ext ? 0x04 : 0x00));  // mov [rip+d2], reg
  b[i++] = 0x89;
  b[i++] = (uint8_t)(0x05 | (low << 3));
  memcpy(b + i, &d2_32, 4); i += 4;                // -> i == 22
  b[i++] = (uint8_t)(0x49 | (ext ? 0x04 : 0x00));  // mov r11, reg
  b[i++] = 0x89;
  b[i++] = (uint8_t)(0xC0 | (low << 3) | 0x03);    // -> i == 25 (compare:)
  b[i++] = (uint8_t)(0x4C | (ext ? 0x01 : 0x00));  // cmp reg, r11
  b[i++] = 0x39;
  b[i++] = (uint8_t)(0xD8 | low);
  b[i++] = 0x75; b[i++] = 0x08;                    // jne runOriginal (over 8)
  b[i++] = 0x41; b[i++] = 0x5B;                    // pop r11
  b[i++] = 0x9D;                                   // popfq   -> i == 33
  b[i++] = 0xE9;                                   // jmp return (skip the write)
  memcpy(b + i, &rel_32, 4); i += 4;
  b[i++] = 0x41; b[i++] = 0x5B;                    // runOriginal: pop r11
  b[i++] = 0x9D;                                   // popfq   -> i == 41

  return Napi::String::New(env, BytesToHex(b, kTotal));
}

// Emits the entry-point guard behind `immune` mode: compares a hooked
// method's first argument (its "this" pointer, per the Windows x64 calling
// convention — rcx for a Mono-JIT instance method) against the pointer
// stored AT playerPointerAddress, and on match returns from the WHOLE
// METHOD immediately — the CT table's own damage-immunity pattern
// (`cmp rax,rcx; jne short @f; ret; @@: <original>`), generalized. Unlike
// EncodeGuardedSkip's early exit — which skips one displaced write and
// continues into the rest of the function — this never falls back into the
// function on a match at all: it is the whole method's return, full stop.
// Only on a NON-match does it fall through, to returnAddress, where the
// caller is expected to place the method's replayed original prologue
// followed by a jump back into the method's continuation — the same
// "cave holds displaced + jmpBack" shape every other patch mode uses, minus
// any effect, since immune's guard-and-return IS the whole effect.
//
// What actually returns on a match is chosen by returnKind — matching the
// real CT table's OWN two uses of this shape: `Character:ApplyDamage`
// returns bare 0 (a skip — the method's own effect never happens), but
// `Character:GetHealth` forces a specific VALUE back to the caller instead
// (a lie about what the field holds, not a skip — the caller still gets an
// answer, just always the same one). Both are the identical guard-and-return
// shape; only the last few bytes differ:
//
//   mov rax, [playerPointerAddress]   48 A1 <imm64>   (10 bytes) — moffs
//                                                       form: loads
//                                                       [absolute imm64]
//                                                       into rax directly
//   cmp argRegister, rax               <REX> 39 <ModRM> (3-4 bytes)
//   jne returnAddress                  0F 85 <rel32>   (6 bytes)
//   -- returnKind 'zero' (ApplyDamage's shape) --
//   xor eax, eax                       31 C0            (2 bytes)
//   ret                                C3               (1 byte)
//   -- returnKind 'int32' --
//   mov eax, imm32                     B8 <imm32>       (5 bytes)
//   ret                                C3               (1 byte)
//   -- returnKind 'float' (GetHealth's shape: an SSE return goes in xmm0,
//      not eax — there is no `mov xmm0, imm32`, so load the float's raw
//      IEEE-754 bit pattern into eax first, same as the codebase's own
//      valueBits() already produces for `force` mode, then move it into
//      xmm0) --
//   mov eax, imm32(bits)               B8 <imm32>       (5 bytes)
//   movd xmm0, eax                     66 0F 6E C0      (4 bytes)
//   ret                                C3               (1 byte)
Napi::Value EncodeImmuneGuard(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uintptr_t playerPointerAddress = ParseHex(info[0].As<Napi::String>().Utf8Value());
  std::string argRegName = info[1].As<Napi::String>().Utf8Value();
  uintptr_t caveCodeAddress = ParseHex(info[2].As<Napi::String>().Utf8Value());
  uintptr_t returnAddress = ParseHex(info[3].As<Napi::String>().Utf8Value());
  // Both optional and both-or-neither: absent means the original 'zero'
  // shape, unchanged from before this pair existed — every existing immune
  // patch (no return value of its own) keeps encoding exactly as it did.
  std::string returnKind = info[4].IsUndefined() ? "zero" : info[4].As<Napi::String>().Utf8Value();
  uint32_t returnBits = info[5].IsUndefined() ? 0 : info[5].As<Napi::Number>().Uint32Value();
  if (returnKind != "zero" && returnKind != "int32" && returnKind != "float") {
    Napi::Error::New(env, "unknown returnKind — expected zero, int32, or float")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  ZydisRegister argReg = RegisterByName(argRegName);
  if (argReg == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown arg register").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::vector<uint8_t> out;
  out.push_back(0x48);
  out.push_back(0xA1);
  for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>(playerPointerAddress >> (i * 8)));
  // 10 bytes so far (mov rax, moffs64)

  ZydisEncoderRequest cmpReq;
  memset(&cmpReq, 0, sizeof(cmpReq));
  cmpReq.mnemonic = ZYDIS_MNEMONIC_CMP;
  cmpReq.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
  cmpReq.operand_count = 2;
  cmpReq.operands[0].type = ZYDIS_OPERAND_TYPE_REGISTER;
  cmpReq.operands[0].reg.value = argReg;
  cmpReq.operands[1].type = ZYDIS_OPERAND_TYPE_REGISTER;
  cmpReq.operands[1].reg.value = ZYDIS_REGISTER_RAX;
  uint8_t cmpBuf[16];
  ZyanUSize cmpLen = sizeof(cmpBuf);
  if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&cmpReq, cmpBuf, &cmpLen))) {
    Napi::Error::New(env, "failed to encode cmp").ThrowAsJavaScriptException();
    return env.Null();
  }
  out.insert(out.end(), cmpBuf, cmpBuf + cmpLen);
  // out.size() now = 10 + cmpLen

  // jne rel32: 6 bytes (0F 85 + imm32). Its own address, for the relative
  // calculation, is caveCodeAddress + out.size() (right after mov+cmp).
  uintptr_t jneAddress = caveCodeAddress + out.size();
  int64_t rel = (int64_t)returnAddress - (int64_t)(jneAddress + 6);
  if (rel > INT32_MAX || rel < INT32_MIN) {
    Napi::Error::New(env, "return address out of rel32 range").ThrowAsJavaScriptException();
    return env.Null();
  }
  int32_t rel32 = (int32_t)rel;
  out.push_back(0x0F);
  out.push_back(0x85);
  for (int i = 0; i < 4; i++) out.push_back(static_cast<uint8_t>(rel32 >> (i * 8)));

  if (returnKind == "zero") {
    out.push_back(0x31); out.push_back(0xC0); // xor eax, eax
  } else {
    out.push_back(0xB8);                       // mov eax, imm32
    for (int i = 0; i < 4; i++) out.push_back(static_cast<uint8_t>(returnBits >> (i * 8)));
    if (returnKind == "float") {
      out.push_back(0x66); out.push_back(0x0F); out.push_back(0x6E); out.push_back(0xC0); // movd xmm0, eax
    }
  }
  out.push_back(0xC3); // ret

  return Napi::String::New(env, BytesToHex(out.data(), out.size()));
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
