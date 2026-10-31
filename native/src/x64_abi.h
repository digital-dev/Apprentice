#pragma once
#include <cstdint>
#include <vector>
#include "platform/platform.h"

// Small, shared, ABI-aware x86-64 byte-encoding helpers.
//
// Originally written once inside mono_bridge.cc for its eight hand-encoded
// stub builders (BuildAssemblyCollectorStub through BuildAttachedCallStub),
// which each chain several nested `call`s to real mono_* exports inside ONE
// injected thread — each nested `call` needing the same per-ABI
// argument-register convention mono_call.cc's BuildCallStub already uses.
// Moved here (Task: final fix wave) so cave_ops.cc's EncodeConditionalScale
// — which hand-encodes an injected call into GAME code, not Mono, but needs
// the identical register convention for its own single nested `call` — can
// reuse them too, rather than hand-duplicating the same bytes a third way.
//
//   ArgReg(abi, i)     which GPR holds the i'th (0-3) integer/pointer
//                      argument of the NEXT nested call — Ms64: rcx,rdx,
//                      r8,r9; SysV: rdi,rsi,rdx,rcx. Only 0-3 are ever
//                      used (mono_bridge.cc's/mono_call.cc's own 4-arg
//                      cap, same as cave_ops.cc's single-arg use here).
//   ShadowBytes(abi)   the sub/add rsp amount around each nested call —
//                      0x28 for Ms64 (32 bytes of mandatory shadow space
//                      + 8 for 16-alignment); 0x08 for SysV, which has no
//                      shadow space but still needs rsp 16-aligned at the
//                      `call` (entry rsp is 8 mod 16 for BOTH ABIs — the
//                      thread-hijack convention CreateRemoteThread already
//                      guarantees uniformly — so 8 is the minimal correct
//                      adjustment, the same reasoning mono_call.cc's own
//                      SysV stub already uses). NOTE: this assumes the
//                      caller's entry RSP is already known to be 8 mod 16
//                      (true for every mono_bridge.cc/mono_call.cc stub,
//                      which all start life via CreateRemoteThread). A
//                      caller whose entry alignment is NOT known this way
//                      — e.g. a cave spliced into arbitrary game code mid-
//                      function, as cave_ops.cc's EncodeConditionalScale
//                      is — must re-derive 16-alignment itself first (that
//                      stub already does: `and rsp, -16`) and MUST NOT
//                      apply ShadowBytes(abi) on top of that re-derived
//                      alignment, since 0x08 is not itself a multiple of
//                      16 and would re-break the very alignment it just
//                      forced. Such a caller only needs ArgReg from this
//                      header, not ShadowBytes.
//   EmitMovRegImm64/EmitMovRegReg  mov <reg>, imm64 / mov <dst>, <src> for
//                      any of rax..r15 — written once so a stub's choice
//                      of register is just a parameter, never a hand-
//                      picked opcode/REX/ModRM byte. Verified to reproduce
//                      the exact bytes every existing hand-written Ms64
//                      instance already used (see the comment blocks above
//                      each mono_bridge.cc stub), and — since every
//                      register 0-15 needs only a REX bit flip, never an
//                      extra byte, when every operation here is already
//                      64-bit (REX.W=1, so a REX prefix is always present
//                      regardless of which register is named) — substituting
//                      a different register NEVER changes an instruction's
//                      length. That is what lets every hand-counted rel8/
//                      rel32 jump offset elsewhere in a caller's blob stay
//                      valid, unchanged, for the SysV variant too: the SysV
//                      branch only ever swaps WHICH register a value goes
//                      into, never how many bytes that takes.
enum class Gpr : uint8_t {
  Rax = 0, Rcx = 1, Rdx = 2, Rbx = 3, Rsp = 4, Rbp = 5, Rsi = 6, Rdi = 7,
  R8 = 8, R9 = 9, R10 = 10, R11 = 11, R12 = 12, R13 = 13, R14 = 14, R15 = 15,
};

inline Gpr ArgReg(platform::Abi abi, int index) {
  static const Gpr kMs64[4] = {Gpr::Rcx, Gpr::Rdx, Gpr::R8, Gpr::R9};
  static const Gpr kSysV[4] = {Gpr::Rdi, Gpr::Rsi, Gpr::Rdx, Gpr::Rcx};
  return abi == platform::Abi::Ms64 ? kMs64[index] : kSysV[index];
}

inline uint8_t ShadowBytes(platform::Abi abi) { return abi == platform::Abi::Ms64 ? 0x28 : 0x08; }

inline void EmitMovRegImm64(std::vector<uint8_t>& out, Gpr reg, uintptr_t imm) {
  uint8_t r = static_cast<uint8_t>(reg);
  out.push_back(static_cast<uint8_t>(0x48 | ((r >> 3) & 1)));  // REX.W [+ REX.B]
  out.push_back(static_cast<uint8_t>(0xB8 + (r & 7)));          // MOV r64, imm64
  for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>(imm >> (i * 8)));
}

inline void EmitMovRegReg(std::vector<uint8_t>& out, Gpr dst, Gpr src) {
  uint8_t d = static_cast<uint8_t>(dst), s = static_cast<uint8_t>(src);
  uint8_t rex = static_cast<uint8_t>(0x48 | (((s >> 3) & 1) << 2) | ((d >> 3) & 1));  // REX.W, R=src, B=dst
  uint8_t modrm = static_cast<uint8_t>(0xC0 | ((s & 7) << 3) | (d & 7));              // mod=11, reg=src, rm=dst
  out.push_back(rex);
  out.push_back(0x89);  // MOV r/m64, r64
  out.push_back(modrm);
}
