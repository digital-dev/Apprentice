#include "sigbuild.h"
#include <cstdio>
#include "Zydis.h"

namespace {

// True if this instruction ends the method it sits in, so a signature must
// not extend across it in either direction. What lies beyond is alignment
// padding, JIT metadata, and then some unrelated method — bytes that move
// between runs even when this method does not, which is what made a short
// Mono setter's signature stop matching after a game restart.
bool EndsMethod(ZydisMnemonic m) {
  switch (m) {
    case ZYDIS_MNEMONIC_RET:
    case ZYDIS_MNEMONIC_JMP:
    case ZYDIS_MNEMONIC_IRET:
    case ZYDIS_MNEMONIC_IRETD:
    case ZYDIS_MNEMONIC_IRETQ:
    case ZYDIS_MNEMONIC_INT3:
    case ZYDIS_MNEMONIC_UD2:
    case ZYDIS_MNEMONIC_HLT:
      return true;
    default:
      return false;
  }
}

} // namespace

  // Build an AOB signature spanning the caught instruction AND the
  // instructions that follow it, wildcarding each one's RIP-relative
  // displacement (the bytes that shift when code loads at a different
  // base) so the pattern survives a restart.
  //
  // The window is the whole point. A single store is 2-8 bytes — the
  // harness's own drain instruction is `mov [rcx], eax`, just `89 01` —
  // and a 2-byte pattern matched 992 places in the harness binary alone,
  // 575 in a real game. Since the engine refuses to patch anything it
  // can't pin to exactly one address, a bare-instruction signature made
  // every JIT-code patch permanently unrelocatable. Decoding forward until
  // there are enough bytes buys uniqueness; going forward rather than
  // backward keeps the caught instruction at offset 0, so a match address
  // IS the instruction address and nothing downstream has to adjust.
SigResult BuildSignature(const SigMemory& mem, uintptr_t insnAddr,
                         const uint8_t* insn, size_t insnLen) {
  SigResult result;
  ZydisDecoder decoder;
  ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);
  {
    // The signature covers the METHOD around the instruction, not just the
    // bytes after it.
    //
    // Going only forward failed in both directions against a real game.
    // Stopping at the caught instruction gave a 2-8 byte pattern that
    // matched hundreds of places. Running forward to a fixed 48 bytes
    // matched exactly once inside large methods, but ran clean off the end
    // of a 15-byte Mono setter (`movss [rsi+0x3c]`, epilogue, `ret`) into
    // alignment padding, JIT metadata, and a neighbouring method's
    // prologue — none of which is stable across runs, so that patch
    // located when captured and reported "no signature match" the next
    // session. The same forward-past-the-end trick is what gives the
    // static C harness its uniqueness, which is precisely why the harness
    // could never surface this.
    //
    // A method's own preceding code is both stable and distinctive, so the
    // pattern is extended BACKWARD instead, and never past a RET/JMP in
    // either direction. The cost is that a match is no longer the
    // instruction address — hence signatureOffset, the number of pattern
    // bytes that precede it.
    constexpr size_t kMinSigBytes = 48;
    constexpr size_t kLookBack = 64;  // how far back a method start may be
    constexpr size_t kForward = 128;  // decode room past the instruction

    uint8_t win[kLookBack + kForward] = {0};
    size_t winGot = 0;
    size_t lookBack = kLookBack;

    // Reading from before the instruction can fail outright when it sits
    // near the start of a mapping. That is not fatal — retry with a
    // smaller forward-only window (halving each time, like DecodeRun's own
    // read-shrinking strategy in cave_ops.cc) rather than falling straight
    // to a bare, near-zero-length signature the moment the FIRST fallback
    // attempt also fails or comes up short. The old behaviour ignored
    // ReadProcessMemory's return value entirely on this path, so a failed
    // or short forward read silently produced a near-zero-length signature
    // that could match hundreds of unrelated places (see the windowing
    // comment above) and report "ambiguous" forever.
    winGot = mem.Read(insnAddr - kLookBack, win, sizeof(win));
    if (winGot <= kLookBack) {
      lookBack = 0;
      winGot = 0;
      size_t tryForward = kForward;
      while (tryForward >= kMinSigBytes && winGot == 0) {
        const size_t got = mem.Read(insnAddr, win, tryForward);
        if (got >= kMinSigBytes) {
          winGot = got;
          break;
        }
        tryForward /= 2;
      }
    }

    // x86 cannot be decoded backward, so the lead-in is found by trying
    // each candidate start and keeping the ones whose instruction
    // boundaries land EXACTLY on the caught instruction. A candidate that
    // lands mid-instruction is a misalignment, and one that steps over a
    // RET/JMP on the way has crossed out of this method into whatever
    // preceded it — both are rejected. Longest valid lead-in wins: more of
    // the method means more uniqueness.
    // Two hard limits on how far back the pattern may reach.
    size_t maxLead = lookBack;

    // 1. Never cross a memory region boundary. scanAob searches one region
    //    at a time, so a pattern straddling two can never match anything —
    //    it silently finds zero, which is indistinguishable from a stale
    //    signature. The harness's drain instruction sits 0x13 bytes into
    //    its region, so an unclamped 64-byte lead-in produced exactly that.
    uintptr_t regionBase = 0;
    if (mem.RegionBase(insnAddr, regionBase)) {
      size_t avail = insnAddr > regionBase ? (size_t)(insnAddr - regionBase) : 0;
      if (maxLead > avail) maxLead = avail;
    }

    // 2. Stop at inter-method padding. A run of 0x00 or 0xCC before the
    //    instruction is alignment fill between methods, not this method's
    //    code: it adds no uniqueness and drags the pattern toward whatever
    //    sits on the far side of it. A run is required rather than a single
    //    byte, because real instructions contain zero bytes all the time
    //    (`mov eax, 1` is b8 01 00 00 00) and one of those must not be
    //    mistaken for the end of the method.
    {
      constexpr size_t kPadRun = 4;
      size_t run = 0;
      for (size_t i = lookBack; i-- > lookBack - maxLead;) {
        const uint8_t b = win[i];
        if (b == 0x00 || b == 0xCC) {
          if (++run >= kPadRun) {
            maxLead = lookBack - (i + kPadRun);
            break;
          }
        } else {
          run = 0;
        }
      }
    }

    size_t bestLead = 0;
    for (size_t lead = maxLead; lead >= 1; lead--) {
      size_t cursor = lookBack - lead;
      bool aligned = true;
      while (cursor < lookBack) {
        ZydisDecodedInstruction probe;
        ZydisDecodedOperand probeOps[ZYDIS_MAX_OPERAND_COUNT];
        if (!ZYAN_SUCCESS(ZydisDecoderDecodeFull(&decoder, win + cursor, winGot - cursor,
                                                 &probe, probeOps))) {
          aligned = false;
          break;
        }
        if (EndsMethod(probe.mnemonic)) { // crossed a method boundary
          aligned = false;
          break;
        }
        // A chain can decode cleanly and still be misaligned: x86 is
        // self-synchronizing, so starting mid-instruction often produces
        // valid-looking instructions that happen to land exactly on the
        // captured one. That is not harmless — a misaligned chain hides the
        // real instruction boundaries, so the imm64 wildcarding never sees
        // the `movabs` it is supposed to blank and the pattern bakes in an
        // absolute address that changes every launch.
        //
        // Observed in Valheim: a lead-in beginning `00 90 49 bb ...`
        // swallowed a `movabs r11, imm64` inside a bogus 6-byte decode,
        // producing a signature that matched when captured and never again.
        //
        // Opcode 0x00 is the tell. Compilers effectively never emit it
        // (`add byte ptr [mem], reg8` in this form), while runs of 0x00 are
        // exactly what padding and data are made of — so a chain that
        // decodes one is being read at the wrong offset.
        if (probe.opcode == 0x00) {
          aligned = false;
          break;
        }
        cursor += probe.length;
      }
      if (aligned && cursor == lookBack) {
        bestLead = lead;
        break;
      }
    }

    const size_t sigStart = lookBack - bestLead;
    const size_t insnEnd = lookBack + insnLen; // index just past the caught instruction

    result.signature.clear();
    result.signatureOffset = (uint32_t)bestLead;
    char hb[4];
    size_t offset = sigStart;

    while (offset < winGot) {
      ZydisDecodedInstruction cur;
      ZydisDecodedOperand curOps[ZYDIS_MAX_OPERAND_COUNT];
      bool decoded = ZYAN_SUCCESS(ZydisDecoderDecodeFull(
          &decoder, win + offset, winGot - offset, &cur, curOps));

      // Undecodable bytes end the signature rather than being guessed at:
      // a wrong length here would silently shift every later wildcard.
      if (!decoded) break;

      size_t dispStart = cur.raw.disp.offset;
      size_t dispSize = cur.raw.disp.size / 8; // bits -> bytes
      // Only RIP-relative displacements move with the load address;
      // a [reg+disp] field offset is stable and must stay literal, or the
      // signature loses the very bytes that make it distinctive.
      bool ripRel = false;
      for (int i = 0; i < cur.operand_count; i++) {
        if (curOps[i].type == ZYDIS_OPERAND_TYPE_MEMORY &&
            curOps[i].mem.base == ZYDIS_REGISTER_RIP) {
          ripRel = true;
          break;
        }
      }

      // A 64-bit immediate in JIT code is an absolute address, and the
      // allocation it names moves every launch. Proven against Valheim:
      // the same instruction captured in two sessions produced signatures
      // identical in every byte except a `movabs r11, imm64` operand —
      // 0x000247ca4f8a1000 one run, 0x000001c74de92310 the next. Left
      // literal, those eight bytes guarantee the pattern never matches
      // again after a restart, which looks exactly like "the code was
      // recompiled" and sends the user off to re-capture forever.
      //
      // Only imm64 is wildcarded. A 32-bit immediate cannot hold an
      // address on x86-64 — code that needs one uses RIP-relative
      // addressing, already handled above — so imm32 is a genuine constant
      // and stays literal, where it still contributes uniqueness.
      size_t immStart = cur.raw.imm[0].offset;
      size_t immSize = cur.raw.imm[0].size / 8;
      bool absoluteImm = cur.raw.imm[0].size == 64;

      for (size_t i = 0; i < cur.length && offset + i < winGot; i++) {
        if (!result.signature.empty()) result.signature += " ";
        bool wildDisp = ripRel && dispSize && i >= dispStart && i < dispStart + dispSize;
        bool wildImm = absoluteImm && immSize && i >= immStart && i < immStart + immSize;
        if (wildDisp || wildImm) {
          result.signature += "??";
        } else {
          snprintf(hb, sizeof(hb), "%02x", win[offset + i]);
          result.signature += hb;
        }
      }

      offset += cur.length;

      // Both stop conditions only apply once the caught instruction itself
      // is fully covered — the pattern is worthless without it, however
      // long the lead-in already is.
      if (offset >= insnEnd) {
        if (EndsMethod(cur.mnemonic)) break;               // end of the method
        if (offset - sigStart >= kMinSigBytes) break;       // long enough
      }
    }

    // The widening window can legitimately come back empty: winGot can be 0
    // (the read failed) or smaller than the caught instruction's own length,
    // in which case the decode above breaks before producing a single token.
    // FindWriteInstruction already proved `insn` — the caught
    // instruction alone — decodes and was read successfully, so fall back to
    // signing just those bytes (the pre-widening behaviour) rather than
    // leaving result.signature empty. ParseSignature rejects an empty pattern
    // outright, which otherwise turns into a patch that saves fine and then
    // can never be located — a silently permanent break, not a scan miss.
    if (result.signature.empty() && insnLen != 0) {
      char hb2[4];
      for (size_t bi = 0; bi < insnLen; bi++) {
        const uint8_t b = insn[bi];
        if (!result.signature.empty()) result.signature += " ";
        snprintf(hb2, sizeof(hb2), "%02x", b);
        result.signature += hb2;
      }
    }
  }
  return result;
}
