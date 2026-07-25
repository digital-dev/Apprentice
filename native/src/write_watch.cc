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

namespace {

std::string ToHex(uintptr_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}
uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

// A single caught write instruction. Decode fields are populated in Task 5;
// here only instructionAddress is meaningful.
struct Caught {
  uintptr_t instructionAddress = 0;
  std::vector<uint8_t> bytes;
  uint32_t length = 0;
  std::string baseRegister;
  int64_t displacement = 0;
  uintptr_t baseAddress = 0;
  bool decoded = false;
};

struct Session {
  std::thread loop;
  std::atomic<bool> running{false};
  std::atomic<bool> stopRequested{false};
  DWORD pid = 0;
  uintptr_t address = 0;
  std::mutex mtx;
  std::vector<Caught> caught; // deduped by instructionAddress
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
      // 01 = break on data write. Bits 18-19 = length for Dr0: 11 = 4 bytes.
      ctx.Dr7 &= ~((DWORD64)0xF << 16); // clear Dr0 condition+len
      ctx.Dr7 |= (DWORD64)0x1;          // L0
      ctx.Dr7 |= ((DWORD64)0x1 << 16);  // write
      ctx.Dr7 |= ((DWORD64)0x3 << 18);  // 4 bytes
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
        {
          std::lock_guard<std::mutex> lk(g_session.mtx);
          bool seen = false;
          for (const auto& c : g_session.caught)
            if (c.instructionAddress == rip) { seen = true; break; }
          if (!seen) {
            Caught c;
            c.instructionAddress = rip;
            g_session.caught.push_back(c);
          }
        }
        continueStatus = DBG_CONTINUE; // we handled it
      } else {
        // Not ours (e.g. the game's own exceptions) — pass it back.
        continueStatus = DBG_EXCEPTION_NOT_HANDLED;
      }
    }

    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, continueStatus);
  }

  SetHwBreakpointAllThreads(pid, 0); // clear
  DebugActiveProcessStop(pid);       // detach cleanly
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
