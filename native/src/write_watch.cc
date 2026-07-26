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
        insnAddrOut = cand;
        insnOut = tryInsn;
        memcpy(opsOut, tryOps, sizeof(ZydisDecodedOperand) * ZYDIS_MAX_OPERAND_COUNT);
        memcpy(bytesOut, window + offset, tryInsn.length);
        return true;
      }
    }
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
    constexpr size_t kMinSigBytes = 24; // enough to be unique in practice
    constexpr size_t kWindowBytes = 64; // decode room beyond the minimum

    uint8_t win[kWindowBytes] = {0};
    SIZE_T winGot = 0;
    ReadProcessMemory(proc, (LPCVOID)insnAddr, win, sizeof(win), &winGot);

    out.signature.clear();
    char hb[4];
    size_t offset = 0;

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

      for (size_t i = 0; i < cur.length && offset + i < winGot; i++) {
        if (!out.signature.empty()) out.signature += " ";
        if (ripRel && dispSize && i >= dispStart && i < dispStart + dispSize) {
          out.signature += "??";
        } else {
          snprintf(hb, sizeof(hb), "%02x", win[offset + i]);
          out.signature += hb;
        }
      }

      offset += cur.length;
      if (offset >= kMinSigBytes) break;
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
