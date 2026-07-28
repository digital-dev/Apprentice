#include "write_watch.h"
#include <windows.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <thread>
#include <mutex>
#include <atomic>
#include <vector>
#include <string>
#include <cstdint>
#include <cstdio>
#include <future>
#include "Zydis.h"

namespace {

std::string ToHex(uintptr_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}
uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

// A single caught write instruction, decoded via Zydis to expose the
// memory-destination operand's base register, displacement, and the
// runtime base address the game used, plus the owning module (if any).
struct Caught {
  uintptr_t instructionAddress = 0;
  // The raw trap address (ExceptionAddress) used only for in-loop dedup —
  // see the comment above FindWriteInstruction for why this differs from
  // instructionAddress once decode succeeds.
  uintptr_t trapAddress = 0;
  std::vector<uint8_t> bytes;
  uint32_t length = 0;
  std::string signature;
  // How many bytes of the signature sit BEFORE the caught instruction. The
  // pattern covers surrounding method code for uniqueness, so a scan match
  // is the start of that context, not the instruction: the instruction is
  // at match + signatureOffset. Zero when the signature starts at the
  // instruction itself, which is what every pre-existing saved patch
  // assumes.
  uint32_t signatureOffset = 0;
  std::string baseRegister;
  int64_t displacement = 0;
  uintptr_t baseAddress = 0;
  // The actually-decoded destination (base + disp + index*scale) and the
  // operand's access width, as distinct from `displacement` above. Once the
  // matcher accepts a covering write (see FindWriteInstruction), `baseAddress
  // + displacement` is trivially == the watched address BY CONSTRUCTION — it
  // can no longer stand in for "did we identify the right instruction?". This
  // pair carries the native invariant the capture panel actually needs to
  // check: that the watched address falls inside [effectiveAddress,
  // effectiveAddress + accessBytes).
  uintptr_t effectiveAddress = 0;
  uint32_t accessBytes = 0;
  // Whether the matched operand used an index register ([base+index*scale]).
  // `displacement` folds index*scale into a single constant for the
  // pointer-cheat chain, which is only stable if the index is invariant
  // across runs (e.g. a fixed slot) — for a real runtime array index it
  // isn't, so the capture panel surfaces this rather than silently pinning
  // whichever slot was live at capture time.
  bool indexed = false;
  std::string moduleName;
  uintptr_t moduleOffset = 0;
  bool hasModule = false;
};

struct Session {
  std::thread loop;
  std::atomic<bool> running{false};
  std::atomic<bool> stopRequested{false};
  DWORD pid = 0;
  uintptr_t address = 0;
  std::mutex mtx;
  std::vector<Caught> caught; // deduped by trapAddress
};

Session g_session;

// Set or clear a hardware write breakpoint (Dr0, 4-byte, on-write) on one
// thread. `address==0` clears it. Uses suspend/get/set/resume.
void SetHwBreakpointOnThread(DWORD tid, uintptr_t address) {
  HANDLE th = OpenThread(THREAD_GET_CONTEXT | THREAD_SET_CONTEXT | THREAD_SUSPEND_RESUME,
      FALSE, tid);
  if (!th) return;
  SuspendThread(th);
  CONTEXT ctx{};
  ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
  if (GetThreadContext(th, &ctx)) {
    if (address) {
      ctx.Dr0 = address;
      // Dr7: bit0 = L0 (local enable Dr0). Bits 16-17 = condition for Dr0:
      // 01 = break on data write. Bits 18-19 = length for Dr0 (LEN encoding:
      // 00=1 byte, 01=2 bytes, 11=4 bytes).
      //
      // CRITICAL: x86 requires a data breakpoint's address to be aligned to
      // its length — a 4-byte breakpoint on a non-4-aligned address is
      // architecturally UNDEFINED and can make the CPU raise malformed
      // exceptions (crashing the target). The watched address comes from a
      // scan and has arbitrary alignment (e.g. a float in a heap object), so
      // pick the largest length the address is actually aligned to. Any
      // store that writes the value necessarily writes its first byte, so a
      // shorter aligned watch on that byte still catches every write to it.
      DWORD64 lenBits;
      if ((address & 0x3) == 0) lenBits = 0x3;      // 4-byte watch (4-aligned)
      else if ((address & 0x1) == 0) lenBits = 0x1; // 2-byte watch (2-aligned)
      else lenBits = 0x0;                           // 1-byte watch (any address)
      ctx.Dr7 &= ~((DWORD64)0xF << 16); // clear Dr0 condition+len
      ctx.Dr7 |= (DWORD64)0x1;          // L0
      ctx.Dr7 |= ((DWORD64)0x1 << 16);  // write
      ctx.Dr7 |= (lenBits << 18);       // length by alignment
    } else {
      ctx.Dr0 = 0;
      ctx.Dr7 &= ~((DWORD64)0x1);       // clear L0
      ctx.Dr7 &= ~((DWORD64)0xF << 16); // clear Dr0 condition+len
    }
    ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    SetThreadContext(th, &ctx);
  }
  ResumeThread(th);
  CloseHandle(th);
}

// Apply/clear the breakpoint on every thread belonging to pid.
void SetHwBreakpointAllThreads(DWORD pid, uintptr_t address) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snap == INVALID_HANDLE_VALUE) return;
  THREADENTRY32 te{};
  te.dwSize = sizeof(te);
  if (Thread32First(snap, &te)) {
    do {
      if (te.th32OwnerProcessID == pid) SetHwBreakpointOnThread(te.th32ThreadID, address);
    } while (Thread32Next(snap, &te));
  }
  CloseHandle(snap);
}

// Maps a Zydis GPR register enum to the matching value in a CONTEXT.
uintptr_t RegValue(const CONTEXT& ctx, ZydisRegister reg) {
  switch (reg) {
    case ZYDIS_REGISTER_RAX: return ctx.Rax;
    case ZYDIS_REGISTER_RBX: return ctx.Rbx;
    case ZYDIS_REGISTER_RCX: return ctx.Rcx;
    case ZYDIS_REGISTER_RDX: return ctx.Rdx;
    case ZYDIS_REGISTER_RSI: return ctx.Rsi;
    case ZYDIS_REGISTER_RDI: return ctx.Rdi;
    case ZYDIS_REGISTER_RBP: return ctx.Rbp;
    case ZYDIS_REGISTER_RSP: return ctx.Rsp;
    case ZYDIS_REGISTER_R8:  return ctx.R8;
    case ZYDIS_REGISTER_R9:  return ctx.R9;
    case ZYDIS_REGISTER_R10: return ctx.R10;
    case ZYDIS_REGISTER_R11: return ctx.R11;
    case ZYDIS_REGISTER_R12: return ctx.R12;
    case ZYDIS_REGISTER_R13: return ctx.R13;
    case ZYDIS_REGISTER_R14: return ctx.R14;
    case ZYDIS_REGISTER_R15: return ctx.R15;
    default: return 0;
  }
}

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

// Finds the module containing `addr`; returns name + offset, or empty.
bool ModuleOf(DWORD pid, uintptr_t addr, std::string& nameOut, uintptr_t& offsetOut) {
  HANDLE proc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  if (!proc) return false;
  HMODULE mods[1024];
  DWORD needed = 0;
  bool found = false;
  if (EnumProcessModulesEx(proc, mods, sizeof(mods), &needed, LIST_MODULES_ALL)) {
    DWORD count = needed / sizeof(HMODULE);
    if (count > 1024) count = 1024;
    for (DWORD i = 0; i < count && !found; i++) {
      MODULEINFO mi{};
      char name[MAX_PATH];
      if (GetModuleInformation(proc, mods[i], &mi, sizeof(mi)) &&
          GetModuleBaseNameA(proc, mods[i], name, sizeof(name))) {
        uintptr_t base = (uintptr_t)mods[i];
        if (addr >= base && addr < base + mi.SizeOfImage) {
          nameOut = name;
          offsetOut = addr - base;
          found = true;
        }
      }
    }
  }
  CloseHandle(proc);
  return found;
}

// A hardware data breakpoint (Dr0-3, on-write) is trap-style: the CPU
// finishes retiring the instruction that touched the watched address and
// *then* raises the #DB, so `ExceptionAddress`/`rip` here is already the
// address of the NEXT instruction, not the write itself (confirmed
// empirically: decoding directly at rip in the test harness disassembles
// to a bare `ret`, not the `movss [reg+0x10], xmm` that actually wrote
// stamina). x86 has no reverse-decode, so we brute-force it: scan
// candidate start addresses backward from rip (instructions are at most
// 15 bytes), decode forward from each, and keep the one that (a) decodes
// to exactly rip and (b) has a memory-write operand whose computed
// effective address equals the watched address we know we're hunting for.
// That address match is what makes the candidate unambiguous.
// True if two decoded operands mean the same thing — same kind, same
// register/memory-parts/immediate value — not merely the same C struct
// layout. Used to tell a genuine longer instruction apart from a shorter
// one wearing an inert prefix: a bare `0x40` REX byte is NOT content-free
// in general (it is exactly what selects `sil`/`dil`/`spl`/`bpl` over
// `ah`/`ch`/`dh`/`bh` for an 8-bit register operand), so a byte-value
// heuristic that ignores it can misjudge two genuinely different
// instructions as "the same, just prefixed" and pick the wrong one.
// Comparing the actual decoded operands avoids that: `mov [rax], sil` and
// `mov [rax], dh` have the same memory destination but different operands
// overall, so they are correctly judged NOT the same instruction.
bool SameOperand(const ZydisDecodedOperand& a, const ZydisDecodedOperand& b) {
  if (a.type != b.type || a.size != b.size) return false;
  switch (a.type) {
    case ZYDIS_OPERAND_TYPE_REGISTER:
      return a.reg.value == b.reg.value;
    case ZYDIS_OPERAND_TYPE_MEMORY:
      return a.mem.type == b.mem.type && a.mem.segment == b.mem.segment &&
             a.mem.base == b.mem.base && a.mem.index == b.mem.index &&
             a.mem.scale == b.mem.scale &&
             a.mem.disp.has_displacement == b.mem.disp.has_displacement &&
             (!a.mem.disp.has_displacement || a.mem.disp.value == b.mem.disp.value);
    case ZYDIS_OPERAND_TYPE_IMMEDIATE:
      return a.imm.is_signed == b.imm.is_signed && a.imm.is_relative == b.imm.is_relative &&
             a.imm.value.u == b.imm.value.u;
    case ZYDIS_OPERAND_TYPE_POINTER:
      return a.ptr.segment == b.ptr.segment && a.ptr.offset == b.ptr.offset;
    default:
      return true; // ZYDIS_OPERAND_TYPE_UNUSED and anything else with no payload to compare
  }
}

// True if `longer` is nothing more than `shorter` wearing extra leading
// prefix bytes that changed nothing about what the instruction does — same
// mnemonic, same operand count, every operand identical. This is the only
// condition under which a longer candidate's extra bytes should NOT count
// toward ranking: they are just decoration.
bool IsInertPrefixExtensionOf(const ZydisDecodedInstruction& longer,
                              const ZydisDecodedOperand* longerOps,
                              const ZydisDecodedInstruction& shorter,
                              const ZydisDecodedOperand* shorterOps) {
  if (longer.mnemonic != shorter.mnemonic) return false;
  if (longer.operand_count != shorter.operand_count) return false;
  for (int i = 0; i < longer.operand_count; i++) {
    if (!SameOperand(longerOps[i], shorterOps[i])) return false;
  }
  return true;
}

bool FindWriteInstruction(HANDLE proc, const CONTEXT& ctx, bool haveCtx,
                           uintptr_t rip, uintptr_t watchedAddress,
                           ZydisDecoder& decoder, uintptr_t& insnAddrOut,
                           ZydisDecodedInstruction& insnOut,
                           ZydisDecodedOperand* opsOut, uint8_t* bytesOut) {
  constexpr int kMaxLen = 15;
  uintptr_t winStart = (rip >= (uintptr_t)kMaxLen) ? rip - kMaxLen : 0;
  uint8_t window[kMaxLen] = {0};
  SIZE_T got = 0;
  if (!ReadProcessMemory(proc, (LPCVOID)winStart, window,
                         (SIZE_T)(rip - winStart), &got)) {
    return false;
  }

  // Candidate start addresses are tried nearest-to-rip first, but a nearer
  // candidate is not necessarily the real instruction: the tail bytes of a
  // genuine, longer store can coincidentally also decode as a short, valid
  // instruction landing on the same rip (observed in practice — a 4-byte
  // `movss [rax], xmm0` whose last two bytes `11 00` also parse standalone
  // as a 2-byte `adc [rax], eax`, which happens to share the same write-to-
  // rax operand and so passes the effective-address check too). Naively
  // returning on the first match would silently prefer that shorter,
  // coincidental decode — which then includes the bytes AFTER the real
  // store (here, the function's own `ret`) in what gets displaced into a
  // cave, corrupting the target the moment the site is patched.
  //
  // The reverse mistake is just as real, though: naively preferring the
  // LONGEST match instead is not safe either. Any byte immediately before
  // the genuine instruction that happens to be a legal prefix for it — a
  // CS/SS/DS/ES segment override (architecturally ignored for ordinary
  // memory addressing in 64-bit mode; only FS/GS have any effect), for
  // instance — makes `[that byte] + genuine` decode as one instruction,
  // ending at the same rip, with the identical operands, and it would then
  // outrank — and silently replace — the genuine decode purely because it
  // happens to be one byte longer. A byte-value heuristic ("REX 0x40 is
  // always content-free") is NOT safe here, though: a bare 0x40 REX is
  // exactly what selects `sil`/`dil`/`spl`/`bpl` over `ah`/`ch`/`dh`/`bh`
  // for an 8-bit register operand, so `40 88 30` (`mov [rax], sil`) and
  // `88 30` (`mov [rax], dh`) are genuinely DIFFERENT instructions that
  // happen to share the same memory destination — treating the REX byte as
  // always-inert would silently keep the wrong one.
  //
  // So every candidate in range is tried, and a longer candidate only ties
  // with (rather than outranks) an already-found shorter one when it is
  // proven to be nothing but that shorter instruction wearing extra leading
  // bytes: same mnemonic, same operand count, every decoded operand
  // identical (see IsInertPrefixExtensionOf). A coincidental SHORTER
  // sub-decode is, by construction, a fragment of the real instruction's
  // tail plus whatever follows it — a different mnemonic/operands — so it
  // never ties and the genuine longer decode found later replaces it
  // normally on raw length. This is not a general proof for every
  // conceivable byte pattern — it resolves the directions reasoned about
  // here (coincidental shorter sub-decodes, and longer decodes that are
  // truly just a prefixed version of a shorter match), not more.
  bool haveMatch = false;
  size_t bestRankLength = 0;
  uintptr_t bestAddr = 0;
  ZydisDecodedInstruction bestInsn{};
  ZydisDecodedOperand bestOps[ZYDIS_MAX_OPERAND_COUNT];
  uint8_t bestBytes[kMaxLen] = {0};

  for (int64_t candI = (int64_t)rip - 1; candI >= (int64_t)winStart; candI--) {
    uintptr_t cand = (uintptr_t)candI;
    size_t offset = (size_t)(cand - winStart);
    if (offset >= got) continue;

    ZydisDecodedInstruction tryInsn;
    ZydisDecodedOperand tryOps[ZYDIS_MAX_OPERAND_COUNT];
    if (!ZYAN_SUCCESS(ZydisDecoderDecodeFull(&decoder, window + offset,
                                              got - offset, &tryInsn, tryOps))) {
      continue;
    }
    if (cand + tryInsn.length != rip) continue; // must land exactly on rip

    for (int i = 0; i < tryInsn.operand_count; i++) {
      const ZydisDecodedOperand& op = tryOps[i];
      if (op.type != ZYDIS_OPERAND_TYPE_MEMORY) continue;
      if (!(op.actions & ZYDIS_OPERAND_ACTION_MASK_WRITE)) continue;

      ZydisRegister base = op.mem.base;
      int64_t disp = op.mem.disp.has_displacement ? op.mem.disp.value : 0;
      uintptr_t baseAddr = 0;
      bool haveBase = false;
      if (base == ZYDIS_REGISTER_RIP) {
        baseAddr = cand + tryInsn.length;
        haveBase = true;
      } else if (base != ZYDIS_REGISTER_NONE && haveCtx) {
        baseAddr = RegValue(ctx, base);
        haveBase = true;
      }

      // Indexed addressing — [rbx+rax*4] and friends — is ordinary in
      // compiled code, and ignoring the index term computes an effective
      // address that is simply wrong, so the candidate never matches and
      // the write is reported as undecodable.
      int64_t indexTerm = 0;
      if (op.mem.index != ZYDIS_REGISTER_NONE) {
        if (!haveCtx) continue; // can't evaluate it; don't guess
        indexTerm = (int64_t)RegValue(ctx, op.mem.index) * (int64_t)op.mem.scale;
      }

      if (!haveBase) continue;
      uintptr_t effective = (uintptr_t)((int64_t)baseAddr + disp + indexTerm);

      // The write only has to COVER the watched address, not start at it.
      // A 16-byte SIMD store or a struct copy writes a block containing the
      // field, so its effective address is the start of that block; demanding
      // equality rejected exactly those instructions and dropped them from
      // the results. op.size is the access width in bits.
      uintptr_t accessBytes = op.size ? (uintptr_t)(op.size / 8) : 1;
      if (effective <= watchedAddress && watchedAddress < effective + accessBytes) {
        // A longer candidate only ranks as a tie with the current best (so
        // it does NOT replace it) when it is proven to be that same
        // instruction wearing inert leading bytes — same mnemonic, same
        // operands. Otherwise it ranks on its own raw length, same as any
        // other candidate.
        size_t rankLength = (size_t)tryInsn.length;
        if (haveMatch && (size_t)tryInsn.length > bestRankLength &&
            IsInertPrefixExtensionOf(tryInsn, tryOps, bestInsn, bestOps)) {
          rankLength = bestRankLength;
        }

        if (!haveMatch || rankLength > bestRankLength) {
          haveMatch = true;
          bestRankLength = rankLength;
          bestAddr = cand;
          bestInsn = tryInsn;
          memcpy(bestOps, tryOps, sizeof(ZydisDecodedOperand) * ZYDIS_MAX_OPERAND_COUNT);
          memcpy(bestBytes, window + offset, tryInsn.length);
        }
        break; // this candidate start matched; move to the next start address
      }
    }
  }

  if (haveMatch) {
    insnAddrOut = bestAddr;
    insnOut = bestInsn;
    memcpy(opsOut, bestOps, sizeof(ZydisDecodedOperand) * ZYDIS_MAX_OPERAND_COUNT);
    memcpy(bytesOut, bestBytes, bestInsn.length);
    return true;
  }
  return false;
}

// Reads the faulting thread's registers, locates the true write instruction
// (see FindWriteInstruction), and decodes its memory-destination operand
// into base register, displacement, and the runtime base address the game
// used.
void DecodeCaught(DWORD pid, DWORD tid, uintptr_t rip, Caught& out) {
  HANDLE proc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  if (!proc) {
    return;
  }

  HANDLE th = OpenThread(THREAD_GET_CONTEXT, FALSE, tid);
  CONTEXT ctx{};
  ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER;
  bool haveCtx = th && GetThreadContext(th, &ctx);
  if (th) CloseHandle(th);

  ZydisDecoder decoder;
  ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);

  uintptr_t insnAddr = 0;
  ZydisDecodedInstruction insn{};
  ZydisDecodedOperand operands[ZYDIS_MAX_OPERAND_COUNT];
  uint8_t bytes[16] = {0};

  bool found = FindWriteInstruction(proc, ctx, haveCtx, rip, g_session.address,
                                     decoder, insnAddr, insn, operands, bytes);
  if (!found) {
    CloseHandle(proc);
    return;
  }

  out.instructionAddress = insnAddr;
  out.length = insn.length;
  out.bytes.assign(bytes, bytes + insn.length);

  for (int i = 0; i < insn.operand_count; i++) {
    const ZydisDecodedOperand& op = operands[i];
    if (op.type != ZYDIS_OPERAND_TYPE_MEMORY) continue;
    if (!(op.actions & ZYDIS_OPERAND_ACTION_MASK_WRITE)) continue;

    ZydisRegister base = op.mem.base;

    if (base == ZYDIS_REGISTER_RIP) {
      out.baseRegister = "rip";
      out.baseAddress = insnAddr + insn.length; // RIP-relative base = next insn
    } else if (base != ZYDIS_REGISTER_NONE && haveCtx) {
      out.baseRegister = ZydisRegisterGetString(base);
      out.baseAddress = RegValue(ctx, base);
    } else {
      break; // no usable base — leave this one undecoded rather than guess
    }

    // Report the displacement from the base register to the WATCHED field,
    // not the instruction's own displacement. For a store that covers a
    // block — a SIMD or struct copy — the encoded displacement points at
    // the start of the block, which is not the field the user is chasing;
    // a pointer cheat built from it would read the wrong offset. Deriving it
    // from the watched address keeps base + displacement == watched for
    // every caught instruction, which is what the pointer-cheat path
    // depends on — but that identity is true BY CONSTRUCTION and can't also
    // serve as a safety check, so effectiveAddress/accessBytes below carry
    // the actually-decoded destination separately for the capture panel to
    // check against.
    out.displacement = (int64_t)g_session.address - (int64_t)out.baseAddress;

    int64_t rawDisp = op.mem.disp.has_displacement ? op.mem.disp.value : 0;
    out.indexed = op.mem.index != ZYDIS_REGISTER_NONE;
    int64_t indexTerm = 0;
    if (out.indexed && haveCtx) {
      indexTerm = (int64_t)RegValue(ctx, op.mem.index) * (int64_t)op.mem.scale;
    }
    out.accessBytes = op.size ? (uint32_t)(op.size / 8) : 1;
    out.effectiveAddress = (uintptr_t)((int64_t)out.baseAddress + rawDisp + indexTerm);
    break;
  }

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
    SIZE_T winGot = 0;
    size_t lookBack = kLookBack;

    // Reading from before the instruction can fail outright when it sits
    // near the start of a mapping. That is not fatal — fall back to the
    // instruction itself with no lead-in, which is the old behaviour.
    if (!ReadProcessMemory(proc, (LPCVOID)(insnAddr - kLookBack), win, sizeof(win), &winGot) ||
        winGot <= kLookBack) {
      lookBack = 0;
      winGot = 0;
      ReadProcessMemory(proc, (LPCVOID)insnAddr, win, kForward, &winGot);
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
    MEMORY_BASIC_INFORMATION mbi{};
    if (VirtualQueryEx(proc, (LPCVOID)insnAddr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
      uintptr_t regionBase = (uintptr_t)mbi.BaseAddress;
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
        cursor += probe.length;
      }
      if (aligned && cursor == lookBack) {
        bestLead = lead;
        break;
      }
    }

    const size_t sigStart = lookBack - bestLead;
    const size_t insnEnd = lookBack + out.length; // index just past the caught instruction

    out.signature.clear();
    out.signatureOffset = (uint32_t)bestLead;
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
        if (!out.signature.empty()) out.signature += " ";
        bool wildDisp = ripRel && dispSize && i >= dispStart && i < dispStart + dispSize;
        bool wildImm = absoluteImm && immSize && i >= immStart && i < immStart + immSize;
        if (wildDisp || wildImm) {
          out.signature += "??";
        } else {
          snprintf(hb, sizeof(hb), "%02x", win[offset + i]);
          out.signature += hb;
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
    // FindWriteInstruction already proved `out.bytes` — the caught
    // instruction alone — decodes and was read successfully, so fall back to
    // signing just those bytes (the pre-widening behaviour) rather than
    // leaving out.signature empty. ParseSignature rejects an empty pattern
    // outright, which otherwise turns into a patch that saves fine and then
    // can never be located — a silently permanent break, not a scan miss.
    if (out.signature.empty() && !out.bytes.empty()) {
      char hb2[4];
      for (uint8_t b : out.bytes) {
        if (!out.signature.empty()) out.signature += " ";
        snprintf(hb2, sizeof(hb2), "%02x", b);
        out.signature += hb2;
      }
    }
  }

  out.hasModule = ModuleOf(pid, insnAddr, out.moduleName, out.moduleOffset);
  CloseHandle(proc);
}

// Runs on its own thread for the lifetime of a capture. Owns the debugger:
// DebugActiveProcess -> kill-on-exit FALSE -> arm breakpoints -> event loop.
// The attach attempt's outcome is signaled back to the caller (StartWriteWatch,
// waiting on the paired future) via `attachResult`, since WaitForDebugEvent
// must run on the same thread that called DebugActiveProcess and therefore
// the attach can't happen synchronously on the JS-calling thread.
void DebugLoop(DWORD pid, uintptr_t address, std::promise<bool> attachResult) {
  if (!DebugActiveProcess(pid)) {
    attachResult.set_value(false);
    g_session.running = false;
    return;
  }
  DebugSetProcessKillOnExit(FALSE); // never take the game down with us
  attachResult.set_value(true);

  bool armed = false;
  bool seenInitialBreakpoint = false;
  DEBUG_EVENT ev{};

  while (!g_session.stopRequested) {
    if (!WaitForDebugEvent(&ev, 100)) continue; // timeout -> re-check stop flag

    DWORD continueStatus = DBG_CONTINUE;

    if (ev.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
      // First stop: safe point to arm all existing threads.
      SetHwBreakpointAllThreads(pid, address);
      armed = true;
      if (ev.u.CreateProcessInfo.hFile) CloseHandle(ev.u.CreateProcessInfo.hFile);
    } else if (ev.dwDebugEventCode == CREATE_THREAD_DEBUG_EVENT) {
      // A thread born mid-capture must get the breakpoint too.
      if (armed) SetHwBreakpointOnThread(ev.dwThreadId, address);
    } else if (ev.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) {
      break; // target gone
    } else if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      const EXCEPTION_RECORD& er = ev.u.Exception.ExceptionRecord;
      if (er.ExceptionCode == EXCEPTION_SINGLE_STEP) {
        uintptr_t rip = (uintptr_t)er.ExceptionAddress;
        bool seen = false;
        {
          std::lock_guard<std::mutex> lk(g_session.mtx);
          for (const auto& c : g_session.caught)
            if (c.trapAddress == rip) { seen = true; break; }
        }
        if (!seen) {
          Caught c;
          c.instructionAddress = rip; // overwritten with the true write-insn address on success
          c.trapAddress = rip;        // dedup key: rip is the post-instruction trap address
          DecodeCaught(pid, ev.dwThreadId, rip, c); // fills bytes/length/base/disp/baseAddress
          std::lock_guard<std::mutex> lk(g_session.mtx);
          // re-check under lock in case of races (single debug thread, but cheap)
          bool seen2 = false;
          for (const auto& e : g_session.caught)
            if (e.trapAddress == rip) { seen2 = true; break; }
          if (!seen2) g_session.caught.push_back(std::move(c));
        }
        continueStatus = DBG_CONTINUE;
      } else if (er.ExceptionCode == EXCEPTION_BREAKPOINT && !seenInitialBreakpoint) {
        // On attach the OS injects a thread that executes an int3
        // (DbgUiRemoteBreakin) — the expected "debugger attached" signal.
        // It MUST be consumed with DBG_CONTINUE; passing it back unhandled
        // can be delivered to the target as a fatal exception. Consume only
        // the first breakpoint; later int3s (if the game uses them) pass
        // through.
        seenInitialBreakpoint = true;
        continueStatus = DBG_CONTINUE;
      } else {
        // Not ours (e.g. the game's own exceptions) — pass it back so the
        // game's own handlers still run.
        continueStatus = DBG_EXCEPTION_NOT_HANDLED;
      }
    }

    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, continueStatus);
  }

  SetHwBreakpointAllThreads(pid, 0); // clear

  // Drain whatever the CPU already raised before those breakpoints came
  // down. Clearing Dr7 does not un-raise an exception that has already
  // fired: any in-flight debug exception sits queued for the debugger, and
  // DebugActiveProcessStop delivers the queue to a process that no longer
  // has one. Unhandled, that is a fatal STATUS_SINGLE_STEP — the target
  // dies moments after we let go, which is exactly what "closing Tamper
  // crashes the game" was. The existing tests never saw it because they
  // stop the target's writes before stopping the watch, so the queue is
  // always empty by then.
  //
  // Pump until WaitForDebugEvent times out, meaning nothing is left
  // pending, and consume debug exceptions rather than passing them back —
  // they are ours, and the game has no handler for them.
  //
  // "No event within the timeout" is NOT the same as "the queue is drained"
  // on a live process: CREATE_THREAD/EXIT_THREAD, LOAD_DLL/UNLOAD_DLL, and
  // the game's own first-chance exceptions are all real debug events that
  // reset a plain per-call timeout. A Unity/Mono game with steady thread
  // churn can keep events arriving indefinitely, and since StopWriteWatch
  // joins this thread and before-quit calls it synchronously, an unbounded
  // loop here hangs the whole app on quit with the debugger still attached
  // — worse than the crash this drain exists to prevent. So bound it by
  // wall clock instead: a few hundred ms is far more than the queue actually
  // needs (it's typically empty on the very first check), and once we're
  // past the deadline we give up and detach regardless of what's still
  // arriving.
  constexpr ULONGLONG kDrainBudgetMs = 300;
  ULONGLONG drainDeadline = GetTickCount64() + kDrainBudgetMs;
  DEBUG_EVENT drain;
  DWORD waitMs = 100; // first wait: same as before, for the common empty-queue case
  while (GetTickCount64() < drainDeadline && WaitForDebugEvent(&drain, waitMs)) {
    DWORD status = DBG_CONTINUE;
    if (drain.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      DWORD code = drain.u.Exception.ExceptionRecord.ExceptionCode;
      // Anything that isn't one of ours still belongs to the game.
      if (code != EXCEPTION_SINGLE_STEP && code != EXCEPTION_BREAKPOINT) {
        status = DBG_EXCEPTION_NOT_HANDLED;
      }
    }
    ContinueDebugEvent(drain.dwProcessId, drain.dwThreadId, status);
    waitMs = 20; // subsequent waits: re-check the deadline often, not block on it
  }

  DebugActiveProcessStop(pid); // detach cleanly
  g_session.running = false;
}

} // namespace

Napi::Value StartWriteWatch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_session.running) {
    Napi::Error::New(env, "a write-watch session is already active")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  // A prior session may have ended without an intervening stopWriteWatch
  // (attach failure, or the target process exiting on its own) — in either
  // case DebugLoop set running=false but never got joined. Reap it here so
  // the upcoming move-assignment below never lands on a still-joinable
  // std::thread, which would call std::terminate() and abort this process.
  if (g_session.loop.joinable()) g_session.loop.join();

  DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());

  {
    std::lock_guard<std::mutex> lk(g_session.mtx);
    g_session.caught.clear();
  }
  g_session.pid = pid;
  g_session.address = address;
  g_session.stopRequested = false;
  g_session.running = true;

  std::promise<bool> attachPromise;
  std::future<bool> attachFuture = attachPromise.get_future();
  g_session.loop = std::thread(DebugLoop, pid, address, std::move(attachPromise));

  // Block until the loop thread has attempted DebugActiveProcess so attach
  // failures (bad pid, already-debugged, access denied) throw here instead
  // of failing silently.
  bool attached = attachFuture.get();
  if (!attached) {
    g_session.running = false;
    if (g_session.loop.joinable()) g_session.loop.join();
    Napi::Error::New(env, "failed to attach debugger to process")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  return env.Undefined();
}

static Napi::Array SnapshotToArray(Napi::Env env) {
  Napi::Array arr = Napi::Array::New(env);
  std::lock_guard<std::mutex> lk(g_session.mtx);
  uint32_t i = 0;
  for (const auto& c : g_session.caught) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("instructionAddress", Napi::String::New(env, ToHex(c.instructionAddress)));
    std::string byteHex;
    char hb[3];
    for (uint8_t b : c.bytes) { snprintf(hb, sizeof(hb), "%02x", b); byteHex += hb; }
    o.Set("bytes", Napi::String::New(env, byteHex));
    o.Set("length", Napi::Number::New(env, c.length));
    o.Set("signature", Napi::String::New(env, c.signature));
    o.Set("signatureOffset", Napi::Number::New(env, c.signatureOffset));
    o.Set("baseRegister", Napi::String::New(env, c.baseRegister));
    o.Set("displacement", Napi::String::New(env, ToHex((uintptr_t)c.displacement)));
    o.Set("baseAddress", Napi::String::New(env, ToHex(c.baseAddress)));
    o.Set("effectiveAddress", Napi::String::New(env, ToHex(c.effectiveAddress)));
    o.Set("accessBytes", Napi::Number::New(env, c.accessBytes));
    o.Set("indexed", Napi::Boolean::New(env, c.indexed));
    if (c.hasModule) {
      o.Set("moduleName", Napi::String::New(env, c.moduleName));
      o.Set("moduleOffset", Napi::String::New(env, ToHex(c.moduleOffset)));
    } else {
      o.Set("moduleName", env.Null());
      o.Set("moduleOffset", env.Null());
    }
    arr.Set(i++, o);
  }
  return arr;
}

Napi::Value PollWriteWatch(const Napi::CallbackInfo& info) {
  return SnapshotToArray(info.Env());
}

Napi::Value StopWriteWatch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_session.running || g_session.loop.joinable()) {
    g_session.stopRequested = true;
    if (g_session.loop.joinable()) g_session.loop.join();
  }
  return SnapshotToArray(env);
}
