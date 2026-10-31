#include "platform.h"
#include <windows.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <vector>
#include <string>

namespace platform {
namespace {
std::vector<HANDLE> g_suspended;
constexpr uintptr_t kJumpReach = 0x7FFF0000;

// Reads SizeOfImage and TimeDateStamp out of the image mapped in the target.
// e_lfanew leads from the DOS header to the NT headers; both fields live in
// the NT headers, so this is two small reads and no file I/O.
bool ReadPeFields(platform::ProcessHandle handle, uintptr_t base,
                  uint32_t& size, uint32_t& timestamp) {
  IMAGE_DOS_HEADER dos{};
  if (!platform::ReadMemory(handle, base, &dos, sizeof(dos))) return false;
  if (dos.e_magic != IMAGE_DOS_SIGNATURE) return false;
  IMAGE_NT_HEADERS64 nt{};
  if (!platform::ReadMemory(handle, base + dos.e_lfanew, &nt, sizeof(nt))) return false;
  if (nt.Signature != IMAGE_NT_SIGNATURE) return false;
  // This project is x86-64 only. A 32-bit target's IMAGE_OPTIONAL_HEADER32
  // has a different layout before SizeOfImage (no 8-byte ImageBase, plus a
  // BaseOfData field the 64-bit header doesn't have), so reading it through
  // the 64-bit struct lands on the wrong offset and produces a plausible
  // but wrong size/timestamp instead of an obvious failure. Refuse instead
  // of guessing: a wrong build fingerprint is worse than none, since it
  // would mark a changed build as verified.
  if (nt.OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) return false;
  size = nt.OptionalHeader.SizeOfImage;
  timestamp = nt.FileHeader.TimeDateStamp;
  return true;
}

// Best-effort file version. Absent for most game DLLs and for anything
// without a VERSIONINFO resource; recorded for the user, never compared.
std::string ReadFileVersion(const char* fullPath) {
  DWORD ignored = 0;
  DWORD sz = GetFileVersionInfoSizeA(fullPath, &ignored);
  if (sz == 0) return "";
  std::vector<uint8_t> buf(sz);
  if (!GetFileVersionInfoA(fullPath, 0, sz, buf.data())) return "";
  VS_FIXEDFILEINFO* ffi = nullptr;
  UINT len = 0;
  if (!VerQueryValueA(buf.data(), "\\", (LPVOID*)&ffi, &len) || ffi == nullptr) return "";
  char out[64];
  snprintf(out, sizeof(out), "%u.%u.%u.%u",
           HIWORD(ffi->dwFileVersionMS), LOWORD(ffi->dwFileVersionMS),
           HIWORD(ffi->dwFileVersionLS), LOWORD(ffi->dwFileVersionLS));
  return out;
}

void CopyRegisters(const CONTEXT& ctx, ThreadRegisters& out) {
  out.rax = ctx.Rax; out.rbx = ctx.Rbx; out.rcx = ctx.Rcx; out.rdx = ctx.Rdx;
  out.rsi = ctx.Rsi; out.rdi = ctx.Rdi; out.rbp = ctx.Rbp; out.rsp = ctx.Rsp;
  out.rip = ctx.Rip;
  out.r8 = ctx.R8; out.r9 = ctx.R9; out.r10 = ctx.R10; out.r11 = ctx.R11;
  out.r12 = ctx.R12; out.r13 = ctx.R13; out.r14 = ctx.R14; out.r15 = ctx.R15;
  out.rflags = ctx.EFlags; // 32-bit in CONTEXT; zero-extended into the 64-bit field
}

} // namespace

bool IsSupported() { return true; }
const char* Name() { return "windows"; }

bool ListProcesses(std::vector<ProcessEntry>& out) {
  out.clear();
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return false;
  PROCESSENTRY32 entry;
  entry.dwSize = sizeof(PROCESSENTRY32);
  if (Process32First(snap, &entry)) {
    do {
      ProcessEntry e;
      e.pid = entry.th32ProcessID;
      e.name = entry.szExeFile;
      out.push_back(std::move(e));
    } while (Process32Next(snap, &entry));
  }
  CloseHandle(snap);
  return true;
}

// Same access mask process_utils.cc's Attach has always used.
ProcessHandle OpenProcess(uint32_t pid, std::string& error) {
  HANDLE process = ::OpenProcess(
      PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_VM_OPERATION,
      FALSE, pid);
  if (process == NULL) {
    error = "OpenProcess failed (access denied or process not found)";
    return 0;
  }
  return reinterpret_cast<ProcessHandle>(process);
}

void CloseProcess(ProcessHandle handle) {
  CloseHandle(reinterpret_cast<HANDLE>(handle));
}

bool IsAlive(ProcessHandle handle) {
  DWORD exitCode = 0;
  // The exit code, not GetExitCodeProcess's return value, says whether the
  // process is still running.
  if (!GetExitCodeProcess(reinterpret_cast<HANDLE>(handle), &exitCode)) return false;
  return exitCode == STILL_ACTIVE;
}

uintptr_t MainModuleBase(ProcessHandle handle) {
  HMODULE mod;
  DWORD needed;
  if (!EnumProcessModules(reinterpret_cast<HANDLE>(handle), &mod, sizeof(mod), &needed)) return 0;
  return reinterpret_cast<uintptr_t>(mod);
}

Abi PlatformAbiFor(ProcessHandle, uintptr_t) { return Abi::Ms64; }

bool ReadMemory(ProcessHandle handle, uintptr_t address, void* out, size_t size) {
  SIZE_T read = 0;
  return ReadProcessMemory((HANDLE)handle, (LPCVOID)address, out, size, &read) &&
         read == size;
}

uintptr_t PageSize() {
  static const uintptr_t pageSize = [] {
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    return static_cast<uintptr_t>(si.dwPageSize);
  }();
  return pageSize;
}

// Writing into a live process's CODE, which normally sits on read-execute
// pages: temporarily make the page writable, write, put the original
// protection back, then flush the target's instruction cache so the CPU
// doesn't keep executing a stale cached copy of the bytes we just changed.
// Same contract as patch_ops.cc's WriteBytes.
bool WriteMemory(ProcessHandle handle, uintptr_t address, const void* data, size_t size) {
  HANDLE h = (HANDLE)handle;

  // VirtualProtectEx changes every page touched by [address, address+size),
  // but it reports only the FIRST page's prior protection in oldProtect.
  // If the range straddled a page boundary (an instruction can span one),
  // restoring oldProtect across the whole range would stamp page 1's
  // protection onto page 2 — leaving that page with wrong, unintended
  // protection permanently, which is exactly the residue this feature
  // promises never to leave. This addon only ever patches a single
  // captured instruction, so a straddling range is an anomaly: refuse it
  // rather than add per-page VirtualQueryEx/restore machinery for a case
  // that should not arise in normal use.
  const uintptr_t pageSize = PageSize();
  uintptr_t firstPage = address & ~(pageSize - 1);
  uintptr_t lastPage = (address + size - 1) & ~(pageSize - 1);
  if (firstPage != lastPage) return false;

  DWORD oldProtect = 0;
  if (!VirtualProtectEx(h, (LPVOID)address, size, PAGE_EXECUTE_READWRITE, &oldProtect))
    return false;

  SIZE_T written = 0;
  bool ok = WriteProcessMemory(h, (LPVOID)address, data, size, &written) &&
            written == size;

  // Restore protection regardless of whether the write succeeded — leaving
  // a game's code page permanently writable is exactly the kind of residue
  // this feature promises never to leave behind.
  DWORD ignored = 0;
  VirtualProtectEx(h, (LPVOID)address, size, oldProtect, &ignored);
  FlushInstructionCache(h, (LPCVOID)address, size);

  return ok;
}

bool WriteMemoryUnprotected(ProcessHandle handle, uintptr_t address, const void* data, size_t size) {
  HANDLE h = (HANDLE)handle;
  SIZE_T written = 0;
  bool ok = WriteProcessMemory(h, (LPVOID)address, data, size, &written) && written == size;
  FlushInstructionCache(h, (LPCVOID)address, size);
  return ok;
}

bool QueryRegion(ProcessHandle handle, uintptr_t address, Region& out) {
  MEMORY_BASIC_INFORMATION mbi;
  if (VirtualQueryEx((HANDLE)handle, (LPCVOID)address, &mbi, sizeof(mbi)) != sizeof(mbi))
    return false;
  out.base = (uintptr_t)mbi.BaseAddress;
  out.size = mbi.RegionSize;
  out.free = mbi.State == MEM_FREE;
  out.committed = mbi.State == MEM_COMMIT;
  out.readable = mbi.State == MEM_COMMIT && !(mbi.Protect & PAGE_GUARD) &&
                 (mbi.Protect & (PAGE_READWRITE | PAGE_READONLY | PAGE_WRITECOPY |
                                 PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                                 PAGE_EXECUTE_WRITECOPY));
  out.writable = mbi.State == MEM_COMMIT && !(mbi.Protect & PAGE_GUARD) &&
                 (mbi.Protect & (PAGE_READWRITE | PAGE_WRITECOPY |
                                 PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY));
  out.executable = mbi.State == MEM_COMMIT && !(mbi.Protect & PAGE_GUARD) &&
                   (mbi.Protect & (PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                                   PAGE_EXECUTE_WRITECOPY));
  out.execCopyOnWrite = mbi.State == MEM_COMMIT && !(mbi.Protect & PAGE_GUARD) &&
                        (mbi.Protect & PAGE_EXECUTE_WRITECOPY);
  return true;
}

// Walks free regions outward from `nearAddr` and commits the first page
// within jump reach. Windows allocates on 64KB granularity, so candidates
// align to that rather than to the page size.
uintptr_t AllocateNear(ProcessHandle handle, uintptr_t nearAddr, size_t size) {
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  const uintptr_t granularity = si.dwAllocationGranularity;

  uintptr_t low = (nearAddr > kJumpReach) ? nearAddr - kJumpReach : 0;
  uintptr_t high = nearAddr + kJumpReach;

  // Upward first, then downward: either direction is equally valid, and most
  // processes have free space above their modules.
  for (int direction = 0; direction < 2; direction++) {
    uintptr_t addr = nearAddr;
    while (addr >= low && addr <= high) {
      MEMORY_BASIC_INFORMATION mbi;
      if (VirtualQueryEx((HANDLE)handle, (LPCVOID)addr, &mbi, sizeof(mbi)) != sizeof(mbi))
        break;

      if (mbi.State == MEM_FREE && mbi.RegionSize >= size) {
        uintptr_t candidate =
            ((uintptr_t)mbi.BaseAddress + granularity - 1) & ~(granularity - 1);
        if (candidate >= low && candidate <= high &&
            candidate + size <= (uintptr_t)mbi.BaseAddress + mbi.RegionSize) {
          LPVOID got = VirtualAllocEx((HANDLE)handle, (LPVOID)candidate, size,
                                      MEM_RESERVE | MEM_COMMIT,
                                      PAGE_EXECUTE_READWRITE);
          if (got) return (uintptr_t)got;
        }
      }

      if (direction == 0) {
        uintptr_t next = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
        if (next <= addr) break;
        addr = next;
      } else {
        if ((uintptr_t)mbi.BaseAddress < granularity) break;
        addr = (uintptr_t)mbi.BaseAddress - granularity;
      }
    }
  }
  return 0;
}

bool FreeMemory(ProcessHandle handle, uintptr_t address) {
  if (!address) return false;
  return VirtualFreeEx((HANDLE)handle, (LPVOID)address, 0, MEM_RELEASE) != 0;
}

// Refuses to run while a previous SuspendAll's threads are still held (i.e.
// g_suspended is non-empty), rather than appending to them: g_suspended is
// one flat list shared by all callers, so a second, unrelated SuspendAll
// that later failed partway would have its ResumeAll cleanup resume EVERY
// handle in the list, including threads an earlier, already-succeeded
// caller is still relying on staying frozen. Callers must pair each
// SuspendAll with a ResumeAll before suspending again.
bool SuspendAll(ProcessHandle handle, uint32_t pid) {
  (void)handle;
  if (!g_suspended.empty()) return false;

  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snap == INVALID_HANDLE_VALUE) return false;

  THREADENTRY32 te{};
  te.dwSize = sizeof(te);
  bool failed = false;
  if (Thread32First(snap, &te)) {
    do {
      if (te.th32OwnerProcessID != pid) continue;
      HANDLE th = OpenThread(THREAD_SUSPEND_RESUME, FALSE, te.th32ThreadID);
      if (!th) {
        // The snapshot is a point-in-time copy, not a live view — a real
        // game creates and destroys threads continuously, so a thread ID
        // it listed can legitimately have exited by the time we get here.
        // A dead thread ID makes OpenThread fail with
        // ERROR_INVALID_PARAMETER specifically; that thread simply isn't
        // there to suspend anymore, which is not a reason to refuse
        // installing on every OTHER thread that still is. Any other error
        // (e.g. access denied) is a genuine failure and must still fail
        // the whole call — the all-or-nothing guarantee only needs to hold
        // for threads that actually exist.
        if (GetLastError() == ERROR_INVALID_PARAMETER) continue;
        failed = true;
        break;
      }
      if (SuspendThread(th) == (DWORD)-1) {
        CloseHandle(th);
        failed = true;
        break;
      }
      g_suspended.push_back(th);
    } while (Thread32Next(snap, &te));
  }
  CloseHandle(snap);

  // All or nothing: a half-suspended target must never be written to, so undo
  // a partial suspension before reporting failure.
  if (failed) {
    ResumeAll();
    return false;
  }
  // Every snapshot thread had already exited by the time we got here: we
  // suspended nothing, so this must not report success as if the target
  // were actually frozen.
  if (g_suspended.empty()) return false;
  return true;
}

void ResumeAll() {
  for (HANDLE th : g_suspended) { ResumeThread(th); CloseHandle(th); }
  g_suspended.clear();
}

std::string SuspendAllError() { return std::string(); }

void SleepMs(uint32_t ms) {
  ::Sleep(ms);
}

bool ListModuleRanges(ProcessHandle handle, std::vector<ModuleRange>& out) {
  out.clear();
  HANDLE h = reinterpret_cast<HANDLE>(handle);
  HMODULE mods[1024];
  DWORD needed = 0;
  if (!EnumProcessModulesEx(h, mods, sizeof(mods), &needed, LIST_MODULES_ALL)) return false;
  size_t count = needed / sizeof(HMODULE);
  if (count > 1024) count = 1024;
  for (size_t i = 0; i < count; i++) {
    char name[MAX_PATH] = {0};
    if (GetModuleBaseNameA(h, mods[i], name, MAX_PATH) == 0) continue;
    MODULEINFO mi{};
    ModuleRange r;
    r.name = name;
    r.base = reinterpret_cast<uintptr_t>(mods[i]);
    if (GetModuleInformation(h, mods[i], &mi, sizeof(mi))) r.size = mi.SizeOfImage;
    out.push_back(std::move(r));
  }
  return true;
}

bool ListModules(ProcessHandle handle, std::vector<ModuleInfo>& out) {
  out.clear();
  HANDLE h = reinterpret_cast<HANDLE>(handle);
  HMODULE mods[1024];
  DWORD needed = 0;
  if (!EnumProcessModulesEx(h, mods, sizeof(mods), &needed, LIST_MODULES_ALL)) return false;
  size_t count = needed / sizeof(HMODULE);
  if (count > 1024) count = 1024;
  for (size_t i = 0; i < count; i++) {
    ModuleInfo info;
    info.base = reinterpret_cast<uintptr_t>(mods[i]);
    char name[MAX_PATH] = {0};
    if (GetModuleBaseNameA(h, mods[i], name, MAX_PATH) == 0) continue;
    info.name = name;
    uint32_t size = 0, timestamp = 0;
    // A module whose PE headers can't be read (protected memory, a 32-bit
    // image the Magic check above refuses, a partially-unmapped module
    // mid-unload) must not be reported with a {size: 0, timestamp: 0}
    // fingerprint — profile.ts's verifiedModules compares fingerprints for
    // equality, and 0/0 is not a sentinel it treats specially: two modules
    // that both fail this read would compare EQUAL to each other, and a
    // recorded 0/0 fingerprint (which should never exist, but a corrupt or
    // hand-edited profile could carry one) would spuriously "verify"
    // against either. Skip the module entirely rather than push a
    // zero-fingerprint entry that can participate in that comparison.
    if (!ReadPeFields(handle, info.base, size, timestamp)) continue;
    info.size = size;
    info.timestamp = timestamp;
    char fullPath[MAX_PATH] = {0};
    if (GetModuleFileNameExA(h, mods[i], fullPath, MAX_PATH) != 0) {
      info.version = ReadFileVersion(fullPath);
    }
    out.push_back(info);
  }
  return true;
}

uintptr_t ResolveExport(ProcessHandle handle, uintptr_t moduleBase, const std::string& name) {
  IMAGE_DOS_HEADER dos{};
  if (!platform::ReadMemory(handle, moduleBase, &dos, sizeof(dos))) return 0;
  if (dos.e_magic != IMAGE_DOS_SIGNATURE) return 0;

  IMAGE_NT_HEADERS64 nt{};
  if (!platform::ReadMemory(handle, moduleBase + dos.e_lfanew, &nt, sizeof(nt))) return 0;
  if (nt.Signature != IMAGE_NT_SIGNATURE) return 0;
  if (nt.OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) return 0; // refuse a 32-bit image, same reasoning as ListModules

  const IMAGE_DATA_DIRECTORY& exportDir =
      nt.OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
  if (exportDir.VirtualAddress == 0 || exportDir.Size == 0) return 0;
  uintptr_t exportDirStart = moduleBase + exportDir.VirtualAddress;
  uintptr_t exportDirEnd = exportDirStart + exportDir.Size;

  IMAGE_EXPORT_DIRECTORY ied{};
  if (!platform::ReadMemory(handle, exportDirStart, &ied, sizeof(ied))) return 0;

  // Bounded the same way ListModules bounds its module count: a real
  // module's export table is a few hundred to a few thousand entries, and
  // capping avoids an unbounded read driven by a corrupt NumberOfNames.
  uint32_t count = ied.NumberOfNames;
  if (count > 16384) count = 16384;
  if (count == 0) return 0;

  std::vector<uint32_t> nameRvas(count);
  if (!platform::ReadMemory(handle, moduleBase + ied.AddressOfNames,
                            nameRvas.data(), count * sizeof(uint32_t))) return 0;
  std::vector<uint16_t> ordinals(count);
  if (!platform::ReadMemory(handle, moduleBase + ied.AddressOfNameOrdinals,
                            ordinals.data(), count * sizeof(uint16_t))) return 0;

  for (uint32_t i = 0; i < count; i++) {
    char nameBuf[256] = {0};
    if (!platform::ReadMemory(handle, moduleBase + nameRvas[i], nameBuf, sizeof(nameBuf) - 1)) continue;
    if (name != nameBuf) continue;

    uint16_t ordinal = ordinals[i];
    uint32_t funcRva = 0;
    if (!platform::ReadMemory(handle, moduleBase + ied.AddressOfFunctions + ordinal * sizeof(uint32_t),
                              &funcRva, sizeof(funcRva))) return 0;
    if (funcRva == 0) return 0;

    uintptr_t funcAddr = moduleBase + funcRva;
    // A forwarded export's RVA points back INSIDE the export directory
    // itself (at a "OtherDll.OtherFunc" string) rather than at real code.
    if (funcAddr >= exportDirStart && funcAddr < exportDirEnd) return 0;
    return funcAddr;
  }
  return 0;
}

platform::ThreadHandle CreateRemoteThread(ProcessHandle handle, uintptr_t startAddress, uintptr_t param) {
  HANDLE h = reinterpret_cast<HANDLE>(handle);
  HANDLE thread = ::CreateRemoteThread(
      h, nullptr, 0,
      reinterpret_cast<LPTHREAD_START_ROUTINE>(startAddress),
      reinterpret_cast<LPVOID>(param), 0, nullptr);
  return reinterpret_cast<uintptr_t>(thread);
}

bool WaitForRemoteThread(ThreadHandle thread, uint32_t timeoutMs) {
  HANDLE h = reinterpret_cast<HANDLE>(thread);
  return WaitForSingleObject(h, timeoutMs) == WAIT_OBJECT_0;
}

void CloseRemoteThread(ThreadHandle thread) {
  CloseHandle(reinterpret_cast<HANDLE>(thread));
}

bool ListThreads(uint32_t pid, std::vector<ThreadInfo>& out) {
  out.clear();
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snap == INVALID_HANDLE_VALUE) return false;

  THREADENTRY32 te{};
  te.dwSize = sizeof(te);
  if (Thread32First(snap, &te)) {
    do {
      if (te.th32OwnerProcessID == pid) out.push_back(ThreadInfo{te.th32ThreadID});
    } while (Thread32Next(snap, &te));
  }
  CloseHandle(snap);
  return true;
}

bool GetThreadRegisters(uint32_t tid, ThreadRegisters& out) {
  HANDLE th = OpenThread(THREAD_GET_CONTEXT | THREAD_SUSPEND_RESUME, FALSE, tid);
  if (!th) return false;

  bool ok = false;
  if (SuspendThread(th) != (DWORD)-1) {
    CONTEXT ctx{};
    ctx.ContextFlags = CONTEXT_INTEGER | CONTEXT_CONTROL;
    if (GetThreadContext(th, &ctx)) {
      CopyRegisters(ctx, out);
      ok = true;
    }
    ResumeThread(th);
  }
  CloseHandle(th);
  return ok;
}

bool SupportsHardwareWatch() { return true; }

struct DebugSession::State {
  DWORD pid = 0;
  bool attached = false;
  bool seenInitialBreakpoint = false;
  // The event Wait last returned that still needs ContinueDebugEvent.
  bool pending = false;
  bool pendingIsExit = false;
  DWORD pendingPid = 0;
  DWORD pendingTid = 0;
  DWORD pendingStatus = DBG_CONTINUE;
};

DebugSession::DebugSession(std::unique_ptr<State> state) : state_(std::move(state)) {}

DebugSession::~DebugSession() { Detach(); }

std::unique_ptr<DebugSession> DebugSession::Attach(uint32_t pid, std::string& error) {
  if (!DebugActiveProcess(pid)) {
    error = "DebugActiveProcess failed";
    return nullptr;
  }
  DebugSetProcessKillOnExit(FALSE); // never take the game down with us
  auto state = std::make_unique<State>();
  state->pid = pid;
  state->attached = true;
  return std::unique_ptr<DebugSession>(new DebugSession(std::move(state)));
}

// Suspend/get/set/resume on one thread's debug registers.
bool DebugSession::SetHwBreakpoint(uint32_t tid, int slot, uintptr_t address, size_t len,
                                   bool enable) {
  if (slot < 0 || slot > 3) return false;
  DWORD64 lenBits = 0;
  if (enable) {
    // Dr7 LEN encoding: 00=1 byte, 01=2 bytes, 11=4 bytes, 10=8 bytes.
    switch (len) {
      case 1: lenBits = 0x0; break;
      case 2: lenBits = 0x1; break;
      case 4: lenBits = 0x3; break;
      case 8: lenBits = 0x2; break;
      default: return false;
    }
    if (address & (len - 1)) return false; // misaligned: architecturally undefined
  }

  HANDLE th = OpenThread(THREAD_GET_CONTEXT | THREAD_SET_CONTEXT | THREAD_SUSPEND_RESUME,
      FALSE, tid);
  if (!th) return false;
  SuspendThread(th);
  CONTEXT ctx{};
  ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
  bool ok = false;
  if (GetThreadContext(th, &ctx)) {
    DWORD64* dr[4] = {&ctx.Dr0, &ctx.Dr1, &ctx.Dr2, &ctx.Dr3};
    const DWORD64 enableBit = (DWORD64)0x1 << (slot * 2);  // Ln (local enable)
    const int rwShift = 16 + slot * 4;                     // R/Wn, then LENn at +2
    if (enable) {
      *dr[slot] = address;
      ctx.Dr7 &= ~((DWORD64)0xF << rwShift); // clear condition+len
      ctx.Dr7 |= enableBit;
      ctx.Dr7 |= ((DWORD64)0x1 << rwShift);  // 01 = break on data write
      ctx.Dr7 |= (lenBits << (rwShift + 2));
    } else {
      *dr[slot] = 0;
      ctx.Dr7 &= ~enableBit;
      ctx.Dr7 &= ~((DWORD64)0xF << rwShift); // clear condition+len
    }
    ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    ok = SetThreadContext(th, &ctx) != 0;
  }
  ResumeThread(th);
  CloseHandle(th);
  return ok;
}

bool DebugSession::Wait(uint32_t timeoutMs, WatchEvent& out) {
  State& s = *state_;
  if (!s.attached) return false;
  DEBUG_EVENT ev{};
  if (!WaitForDebugEvent(&ev, timeoutMs)) return false;

  out = WatchEvent{};
  out.tid = ev.dwThreadId;
  DWORD continueStatus = DBG_CONTINUE;

  if (ev.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
    out.kind = DebugEventKind::Attached;
    if (ev.u.CreateProcessInfo.hFile) CloseHandle(ev.u.CreateProcessInfo.hFile);
  } else if (ev.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) {
    // The debug API contract requires the debugger to close this handle;
    // leaving it open both leaks a handle in Apprentice's own process AND
    // keeps the loaded DLL file locked on disk for as long as the
    // write-watch session stays armed. A Mono/Unity game loading
    // assemblies continuously would otherwise leak one handle per DLL
    // load for the duration of the session.
    if (ev.u.LoadDll.hFile) CloseHandle(ev.u.LoadDll.hFile);
  } else if (ev.dwDebugEventCode == CREATE_THREAD_DEBUG_EVENT) {
    out.kind = DebugEventKind::ThreadCreated;
  } else if (ev.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) {
    out.detached = true; // target gone
  } else if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
    const EXCEPTION_RECORD& er = ev.u.Exception.ExceptionRecord;
    if (er.ExceptionCode == EXCEPTION_SINGLE_STEP) {
      out.kind = DebugEventKind::Hit;
      out.rip = (uintptr_t)er.ExceptionAddress;
      // The thread is stopped by the debugger, so no suspend is needed.
      HANDLE th = OpenThread(THREAD_GET_CONTEXT, FALSE, ev.dwThreadId);
      CONTEXT ctx{};
      ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER;
      out.hasRegs = th && GetThreadContext(th, &ctx);
      if (th) CloseHandle(th);
      if (out.hasRegs) CopyRegisters(ctx, out.regs);
      continueStatus = DBG_CONTINUE;
    } else if (er.ExceptionCode == EXCEPTION_BREAKPOINT && !s.seenInitialBreakpoint) {
      // On attach the OS injects a thread that executes an int3
      // (DbgUiRemoteBreakin) — the expected "debugger attached" signal.
      // It MUST be consumed with DBG_CONTINUE; passing it back unhandled
      // can be delivered to the target as a fatal exception. Consume only
      // the first breakpoint; later int3s (if the game uses them) pass
      // through.
      s.seenInitialBreakpoint = true;
      continueStatus = DBG_CONTINUE;
    } else {
      // Not ours (e.g. the game's own exceptions) — pass it back so the
      // game's own handlers still run.
      continueStatus = DBG_EXCEPTION_NOT_HANDLED;
    }
  }

  s.pending = true;
  s.pendingIsExit = out.detached;
  s.pendingPid = ev.dwProcessId;
  s.pendingTid = ev.dwThreadId;
  s.pendingStatus = continueStatus;
  return true;
}

// `ev` is unused on Windows: one event is pending at a time and its
// pid/tid/status are kept in State.
void DebugSession::Continue(const WatchEvent&) {
  State& s = *state_;
  if (!s.pending) return;
  s.pending = false;
  ContinueDebugEvent(s.pendingPid, s.pendingTid, s.pendingStatus);
}

void DebugSession::Detach() {
  State& s = *state_;
  if (!s.attached) return;
  // Never leave the target stopped at an event nobody continued. The exit
  // event is the exception: write-watch has never continued it.
  if (s.pending && !s.pendingIsExit) Continue(WatchEvent{});
  s.pending = false;

  // Drain whatever the CPU already raised before the caller's breakpoints
  // came down. Clearing Dr7 does not un-raise an exception that has already
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
  // joins the session thread and before-quit calls it synchronously, an
  // unbounded loop here hangs the whole app on quit with the debugger still
  // attached — worse than the crash this drain exists to prevent. So bound
  // it by wall clock instead: a few hundred ms is far more than the queue
  // actually needs (it's typically empty on the very first check), and once
  // we're past the deadline we give up and detach regardless of what's
  // still arriving.
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
    } else if (drain.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) {
      // Same handle-close obligation as Wait — DLL loads keep arriving
      // right up to detach (a Mono/Unity game loads assemblies
      // continuously), and this drain loop is exactly the place those
      // trailing loads land.
      if (drain.u.LoadDll.hFile) CloseHandle(drain.u.LoadDll.hFile);
    }
    ContinueDebugEvent(drain.dwProcessId, drain.dwThreadId, status);
    waitMs = 20; // subsequent waits: re-check the deadline often, not block on it
  }

  DebugActiveProcessStop(s.pid); // detach cleanly
  s.attached = false;
}

} // namespace platform
