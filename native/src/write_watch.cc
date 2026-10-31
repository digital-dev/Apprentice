#include "write_watch.h"
#include "sigbuild.h"
#include "platform.h"
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
  // Full GPR snapshot and the top of the stack at trap time, best-effort —
  // see the comment at the capture site in DecodeCaught for what this can
  // and can't be trusted to mean (a return address at stackTop[0] only for
  // a leaf function with no prologue push before the watched write).
  bool hasRegisters = false;
  uintptr_t rax = 0, rbx = 0, rcx = 0, rdx = 0, rsi = 0, rdi = 0, rbp = 0, rsp = 0;
  uintptr_t r8 = 0, r9 = 0, r10 = 0, r11 = 0, r12 = 0, r13 = 0, r14 = 0, r15 = 0;
  std::vector<uintptr_t> stackTop;
};

struct Session {
  std::thread loop;
  std::atomic<bool> running{false};
  std::atomic<bool> stopRequested{false};
  uint32_t pid = 0;
  uintptr_t address = 0;
  std::mutex mtx;
  std::vector<Caught> caught; // deduped by trapAddress
};

Session g_session;

// The write watch uses debug-register slot 0 only.
constexpr int kWatchSlot = 0;

// Set or clear the hardware write breakpoint on one thread. `address==0`
// clears it.
void SetHwBreakpointOnThread(platform::DebugSession& dbg, uint32_t tid, uintptr_t address) {
  if (address) {
    // CRITICAL: x86 requires a data breakpoint's address to be aligned to
    // its length — a 4-byte breakpoint on a non-4-aligned address is
    // architecturally UNDEFINED and can make the CPU raise malformed
    // exceptions (crashing the target). The watched address comes from a
    // scan and has arbitrary alignment (e.g. a float in a heap object), so
    // pick the largest length the address is actually aligned to. Any
    // store that writes the value necessarily writes its first byte, so a
    // shorter aligned watch on that byte still catches every write to it.
    size_t len;
    if ((address & 0x3) == 0) len = 4;      // 4-byte watch (4-aligned)
    else if ((address & 0x1) == 0) len = 2; // 2-byte watch (2-aligned)
    else len = 1;                           // 1-byte watch (any address)
    dbg.SetHwBreakpoint(tid, kWatchSlot, address, len, true);
  } else {
    dbg.SetHwBreakpoint(tid, kWatchSlot, 0, 0, false);
  }
}

// Apply/clear the breakpoint on every thread belonging to pid.
void SetHwBreakpointAllThreads(platform::DebugSession& dbg, uint32_t pid, uintptr_t address) {
  std::vector<platform::ThreadInfo> threads;
  platform::ListThreads(pid, threads);
  for (const auto& t : threads) SetHwBreakpointOnThread(dbg, t.tid, address);
}

// Maps a Zydis GPR register enum to the matching value in a register file.
uintptr_t RegValue(const platform::ThreadRegisters& ctx, ZydisRegister reg) {
  switch (reg) {
    case ZYDIS_REGISTER_RAX: return ctx.rax;
    case ZYDIS_REGISTER_RBX: return ctx.rbx;
    case ZYDIS_REGISTER_RCX: return ctx.rcx;
    case ZYDIS_REGISTER_RDX: return ctx.rdx;
    case ZYDIS_REGISTER_RSI: return ctx.rsi;
    case ZYDIS_REGISTER_RDI: return ctx.rdi;
    case ZYDIS_REGISTER_RBP: return ctx.rbp;
    case ZYDIS_REGISTER_RSP: return ctx.rsp;
    case ZYDIS_REGISTER_R8:  return ctx.r8;
    case ZYDIS_REGISTER_R9:  return ctx.r9;
    case ZYDIS_REGISTER_R10: return ctx.r10;
    case ZYDIS_REGISTER_R11: return ctx.r11;
    case ZYDIS_REGISTER_R12: return ctx.r12;
    case ZYDIS_REGISTER_R13: return ctx.r13;
    case ZYDIS_REGISTER_R14: return ctx.r14;
    case ZYDIS_REGISTER_R15: return ctx.r15;
    default: return 0;
  }
}

// Finds the module containing `addr`; returns name + offset, or empty.
// A module whose size the OS could not report (size 0) never matches.
bool ModuleOf(platform::ProcessHandle proc, uintptr_t addr, std::string& nameOut,
              uintptr_t& offsetOut) {
  std::vector<platform::ModuleRange> mods;
  if (!platform::ListModuleRanges(proc, mods)) return false;
  for (const auto& m : mods) {
    if (addr >= m.base && addr < m.base + m.size) {
      nameOut = m.name;
      offsetOut = addr - m.base;
      return true;
    }
  }
  return false;
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

bool FindWriteInstruction(platform::ProcessHandle proc, const platform::ThreadRegisters& ctx,
                           bool haveCtx, uintptr_t rip, uintptr_t watchedAddress,
                           ZydisDecoder& decoder, uintptr_t& insnAddrOut,
                           ZydisDecodedInstruction& insnOut,
                           ZydisDecodedOperand* opsOut, uint8_t* bytesOut) {
  constexpr int kMaxLen = 15;
  uintptr_t winStart = (rip >= (uintptr_t)kMaxLen) ? rip - kMaxLen : 0;
  uint8_t window[kMaxLen] = {0};
  // All-or-nothing read, as before: a partial read was already a failure.
  size_t got = (size_t)(rip - winStart);
  if (!platform::ReadMemory(proc, winStart, window, got)) {
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
void DecodeCaught(uint32_t pid, const platform::WatchEvent& ev, Caught& out) {
  std::string openError;
  platform::ProcessHandle proc = platform::OpenProcess(pid, openError);
  if (!proc) {
    return;
  }

  // The trapping thread's registers, read by the session at the trap.
  const platform::ThreadRegisters& ctx = ev.regs;
  const bool haveCtx = ev.hasRegs;
  const uintptr_t rip = (uintptr_t)ev.rip;

  ZydisDecoder decoder;
  ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);

  uintptr_t insnAddr = 0;
  ZydisDecodedInstruction insn{};
  ZydisDecodedOperand operands[ZYDIS_MAX_OPERAND_COUNT];
  uint8_t bytes[16] = {0};

  bool found = FindWriteInstruction(proc, ctx, haveCtx, rip, g_session.address,
                                     decoder, insnAddr, insn, operands, bytes);
  if (!found) {
    platform::CloseProcess(proc);
    return;
  }

  out.instructionAddress = insnAddr;
  out.length = insn.length;
  out.bytes.assign(bytes, bytes + insn.length);

  // Snapshot the full GPR set and the top of the stack at trap time. For a
  // leaf function with no prologue push before the watched write — a small
  // setter being the common case, and exactly the shape that let a captured
  // FixedPoint64::operator= write reveal its caller's return address — the
  // stack's top qword at this point IS the return address, since nothing
  // has pushed since the `call` that entered the function. For anything
  // deeper (a prologue already ran) this is just whatever sits at the
  // current stack top: still often useful a slot or two down, but not a
  // promise that stackTop[0] is a return address in general — best-effort,
  // for the caller to judge against the disassembled context.
  if (haveCtx) {
    out.rax = ctx.rax; out.rbx = ctx.rbx; out.rcx = ctx.rcx; out.rdx = ctx.rdx;
    out.rsi = ctx.rsi; out.rdi = ctx.rdi; out.rbp = ctx.rbp; out.rsp = ctx.rsp;
    out.r8 = ctx.r8; out.r9 = ctx.r9; out.r10 = ctx.r10; out.r11 = ctx.r11;
    out.r12 = ctx.r12; out.r13 = ctx.r13; out.r14 = ctx.r14; out.r15 = ctx.r15;
    out.hasRegisters = true;

    constexpr int kStackQwords = 8;
    uintptr_t stackBuf[kStackQwords] = {0};
    // All-or-nothing, as before: a partial read was already a failure.
    if (platform::ReadMemory(proc, (uintptr_t)ctx.rsp, stackBuf, sizeof(stackBuf))) {
      out.stackTop.assign(stackBuf, stackBuf + kStackQwords);
    }
  }

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

  {
    struct LiveSigMemory : SigMemory {
      platform::ProcessHandle proc;
      explicit LiveSigMemory(platform::ProcessHandle p) : proc(p) {}
      size_t Read(uintptr_t addr, uint8_t* buf, size_t len) const override {
        // A partial read counts as failure, as it did when this code called
        // ReadProcessMemory inline.
        if (!platform::ReadMemory(proc, addr, buf, len)) return 0;
        return len;
      }
      bool RegionBase(uintptr_t addr, uintptr_t& base) const override {
        platform::Region r;
        if (!platform::QueryRegion(proc, addr, r)) return false;
        base = r.base;
        return true;
      }
    } live(proc);
    // The signature covers the METHOD around the instruction; see
    // sigbuild.cc for why and how.
    SigResult sig = BuildSignature(live, insnAddr, out.bytes.data(), out.bytes.size());
    out.signature = sig.signature;
    out.signatureOffset = sig.signatureOffset;
  }

  out.hasModule = ModuleOf(proc, insnAddr, out.moduleName, out.moduleOffset);
  platform::CloseProcess(proc);
}

// Runs on its own thread for the lifetime of a capture. Owns the debugger:
// attach (kill-on-exit off) -> arm breakpoints -> event loop -> disarm ->
// drain and detach. The attach attempt's outcome is signaled back to the
// caller (StartWriteWatch, waiting on the paired future) via `attachResult`,
// since every DebugSession call must run on the thread that attached and
// therefore the attach can't happen synchronously on the JS-calling thread.
void DebugLoop(uint32_t pid, uintptr_t address, std::promise<bool> attachResult) {
  std::string attachError;
  std::unique_ptr<platform::DebugSession> dbg = platform::DebugSession::Attach(pid, attachError);
  if (!dbg) {
    attachResult.set_value(false);
    g_session.running = false;
    return;
  }
  attachResult.set_value(true);

  bool armed = false;
  platform::WatchEvent ev;

  while (!g_session.stopRequested) {
    if (!dbg->Wait(100, ev)) continue; // timeout -> re-check stop flag

    if (ev.detached) break; // target gone

    if (ev.kind == platform::DebugEventKind::Attached) {
      // First stop: safe point to arm all existing threads.
      SetHwBreakpointAllThreads(*dbg, pid, address);
      armed = true;
    } else if (ev.kind == platform::DebugEventKind::ThreadCreated) {
      // A thread born mid-capture must get the breakpoint too.
      if (armed) SetHwBreakpointOnThread(*dbg, ev.tid, address);
    } else if (ev.kind == platform::DebugEventKind::Hit) {
      uintptr_t rip = (uintptr_t)ev.rip;
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
        DecodeCaught(pid, ev, c);   // fills bytes/length/base/disp/baseAddress
        std::lock_guard<std::mutex> lk(g_session.mtx);
        // re-check under lock in case of races (single debug thread, but cheap)
        bool seen2 = false;
        for (const auto& e : g_session.caught)
          if (e.trapAddress == rip) { seen2 = true; break; }
        if (!seen2) g_session.caught.push_back(std::move(c));
      }
    }

    dbg->Continue(ev);
  }

  SetHwBreakpointAllThreads(*dbg, pid, 0); // clear

  // Drains any debug exception already raised before those breakpoints came
  // down, then detaches cleanly. See DebugSession::Detach.
  dbg->Detach();
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

  if (!platform::SupportsHardwareWatch()) {
    Napi::Error::New(env, "hardware write-watch is not supported on this platform yet")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  uint32_t pid = info[0].As<Napi::Number>().Uint32Value();
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

  // Block until the loop thread has attempted the debugger attach so attach
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
    // Signed decimal, not hex-of-the-unsigned-cast: c.displacement is a
    // signed int64_t and can legitimately be negative (the caught
    // instruction's base register pointing past the watched field), and
    // casting through uintptr_t before hex-formatting turned e.g. -16 into
    // "0xfffffffffffffff0" — a huge positive number once the JS side does
    // BigInt("0x..."). BigInt(...) already parses a signed decimal string
    // correctly, so std::to_string is both correct and requires no
    // consumer-side change.
    o.Set("displacement", Napi::String::New(env, std::to_string(c.displacement)));
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
    if (c.hasRegisters) {
      Napi::Object regs = Napi::Object::New(env);
      regs.Set("rax", Napi::String::New(env, ToHex(c.rax)));
      regs.Set("rbx", Napi::String::New(env, ToHex(c.rbx)));
      regs.Set("rcx", Napi::String::New(env, ToHex(c.rcx)));
      regs.Set("rdx", Napi::String::New(env, ToHex(c.rdx)));
      regs.Set("rsi", Napi::String::New(env, ToHex(c.rsi)));
      regs.Set("rdi", Napi::String::New(env, ToHex(c.rdi)));
      regs.Set("rbp", Napi::String::New(env, ToHex(c.rbp)));
      regs.Set("rsp", Napi::String::New(env, ToHex(c.rsp)));
      regs.Set("r8", Napi::String::New(env, ToHex(c.r8)));
      regs.Set("r9", Napi::String::New(env, ToHex(c.r9)));
      regs.Set("r10", Napi::String::New(env, ToHex(c.r10)));
      regs.Set("r11", Napi::String::New(env, ToHex(c.r11)));
      regs.Set("r12", Napi::String::New(env, ToHex(c.r12)));
      regs.Set("r13", Napi::String::New(env, ToHex(c.r13)));
      regs.Set("r14", Napi::String::New(env, ToHex(c.r14)));
      regs.Set("r15", Napi::String::New(env, ToHex(c.r15)));
      o.Set("registers", regs);
      Napi::Array stack = Napi::Array::New(env);
      for (size_t si = 0; si < c.stackTop.size(); si++) {
        stack.Set((uint32_t)si, Napi::String::New(env, ToHex(c.stackTop[si])));
      }
      o.Set("stackTop", stack);
    } else {
      o.Set("registers", env.Null());
      o.Set("stackTop", env.Null());
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
