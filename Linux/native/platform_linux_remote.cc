#include "platform.h"
#include "proc_parse.h"
#include "remote_exec.h"
#include "remote_state.h"

#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <utility>
#include <vector>

// AllocateNear, FreeMemory, CreateRemoteThread, WaitForRemoteThread,
// CloseRemoteThread and PlatformAbiFor on Linux, built on remote_exec.h's
// thread-hijack primitive. Like the Windows side, no thread is ever
// created or destroyed in the target for any of this.
namespace platform {
namespace {

std::mutex g_mutex;
// AllocateNear's own bookkeeping: FreeMemory is given only an address, so
// the size munmap needs is kept here, keyed by (pid, address). Dropped for
// a whole pid by DropRemoteState on CloseProcess.
std::map<std::pair<uint32_t, uintptr_t>, size_t> g_allocations;
// One trampoline page per process (holding a single 0xCC byte, the return
// address CreateRemoteThread's stack setup points at), made lazily on the
// first call and never freed — the same "a patch cave is for life"
// trade-off cave_ops.cc already documents for its own hook caves, just for
// a trampoline instead of a hook.
std::map<uint32_t, uintptr_t> g_trampolines;

constexpr size_t kMaxCandidates = 64;
constexpr uintptr_t kStep = 0x10000;        // 64 KiB
constexpr uintptr_t kRange = 0x7fff0000ull;  // just under 2 GiB, both directions

// Free gaps within +/-2GB of `nearAddr`, at least `size` bytes, 64 KiB
// aligned, nearest-to-`nearAddr` first: candidates to try MAP_FIXED_
// NOREPLACE at, rather than probing blindly (each candidate costs one
// remote syscall). Walks QueryRegion forward from the low end of the
// range, which is itself cache-friendly for a sequential walk like this.
std::vector<uintptr_t> FindFreeCandidates(ProcessHandle handle, uintptr_t nearAddr, size_t size) {
  uintptr_t low = nearAddr > kRange ? nearAddr - kRange : kStep;
  uintptr_t high = nearAddr + kRange;
  if (high < nearAddr) high = ~(uintptr_t)0;  // saturate instead of wrapping
  std::vector<uintptr_t> candidates;
  uintptr_t addr = low;
  while (addr < high) {
    Region r;
    if (!QueryRegion(handle, addr, r)) break;
    if (r.free) {
      uintptr_t gapStart = (std::max(r.base, low) + kStep - 1) & ~(kStep - 1);
      const uintptr_t gapEnd = r.base + r.size;
      while (gapStart + size <= gapEnd && gapStart < high && candidates.size() < kMaxCandidates * 4) {
        candidates.push_back(gapStart);
        gapStart += kStep;
      }
    }
    if (r.base + r.size <= addr) break;  // no progress: stop rather than loop forever
    addr = r.base + r.size;
  }
  std::sort(candidates.begin(), candidates.end(), [&](uintptr_t a, uintptr_t b) {
    uintptr_t da = a > nearAddr ? a - nearAddr : nearAddr - a;
    uintptr_t db = b > nearAddr ? b - nearAddr : nearAddr - b;
    return da < db;
  });
  if (candidates.size() > kMaxCandidates) candidates.resize(kMaxCandidates);
  return candidates;
}

bool RemoteMmap(ProcessHandle handle, uintptr_t addr, size_t size, uintptr_t& result) {
  uint64_t args[6] = {addr, size, PROT_READ | PROT_WRITE | PROT_EXEC,
                       MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, (uint64_t)(int64_t)-1, 0};
  uint64_t raw = 0;
  if (!linuxremote::RemoteSyscall((uint32_t)handle, SYS_mmap, args, raw)) return false;
  if ((int64_t)raw < 0) return false;  // EEXIST (lost the race for this address) or similar
  result = (uintptr_t)raw;
  return true;
}

bool RemoteMunmap(ProcessHandle handle, uintptr_t addr, size_t size) {
  uint64_t args[6] = {addr, size, 0, 0, 0, 0};
  uint64_t raw = 0;
  if (!linuxremote::RemoteSyscall((uint32_t)handle, SYS_munmap, args, raw)) return false;
  return (int64_t)raw == 0;
}

}  // namespace

Abi PlatformAbiFor(ProcessHandle handle, uintptr_t moduleBase) {
  unsigned char magic[4] = {0, 0, 0, 0};
  if (ReadMemory(handle, moduleBase, magic, sizeof(magic))) {
    if (magic[0] == 'M' && magic[1] == 'Z') return Abi::Ms64;
    if (magic[0] == 0x7f && magic[1] == 'E' && magic[2] == 'L' && magic[3] == 'F') return Abi::SysV;
  }
  // The header could not be read (process gone, or `moduleBase` is not
  // really one): fall back to the same Wine-vs-native signal
  // MainModuleBase already uses for this process as a whole.
  const uint32_t pid = (uint32_t)handle;
  std::string cmdline;
  { std::ifstream f("/proc/" + std::to_string(pid) + "/cmdline", std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    cmdline = ss.str(); }
  std::string exe;
  char buf[4096];
  ssize_t n = readlink(("/proc/" + std::to_string(pid) + "/exe").c_str(), buf, sizeof(buf) - 1);
  if (n > 0) exe.assign(buf, (size_t)n);
  std::string name = linuxproc::ExeNameFromCmdline(cmdline, exe);
  return linuxproc::EndsWithExe(name) ? Abi::Ms64 : Abi::SysV;
}

uintptr_t AllocateNear(ProcessHandle handle, uintptr_t nearAddr, size_t size) {
  if (handle == 0 || size == 0) return 0;
  size = (size + PageSize() - 1) & ~(PageSize() - 1);
  for (uintptr_t addr : FindFreeCandidates(handle, nearAddr, size)) {
    uintptr_t got = 0;
    if (!RemoteMmap(handle, addr, size, got)) continue;
    if (got != addr) {  // should not happen with MAP_FIXED_NOREPLACE; defensive
      RemoteMunmap(handle, got, size);
      continue;
    }
    std::lock_guard<std::mutex> lk(g_mutex);
    g_allocations[{(uint32_t)handle, addr}] = size;
    return addr;
  }
  return 0;
}

bool FreeMemory(ProcessHandle handle, uintptr_t address) {
  size_t size;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    auto it = g_allocations.find({(uint32_t)handle, address});
    if (it == g_allocations.end()) return false;  // not an address we gave out: refuse rather than guess a size
    size = it->second;
  }
  if (!RemoteMunmap(handle, address, size)) return false;
  std::lock_guard<std::mutex> lk(g_mutex);
  g_allocations.erase({(uint32_t)handle, address});
  return true;
}

namespace {
uintptr_t TrampolineFor(ProcessHandle handle, uintptr_t near) {
  const uint32_t pid = (uint32_t)handle;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    auto it = g_trampolines.find(pid);
    if (it != g_trampolines.end()) return it->second;
  }
  uintptr_t page = AllocateNear(handle, near, PageSize());
  if (!page) return 0;
  static const unsigned char kInt3 = 0xCC;
  if (!WriteMemory(handle, page, &kInt3, 1)) {
    FreeMemory(handle, page);
    return 0;
  }
  std::lock_guard<std::mutex> lk(g_mutex);
  g_trampolines[pid] = page;
  return page;
}
}  // namespace

ThreadHandle CreateRemoteThread(ProcessHandle handle, uintptr_t startAddress, uintptr_t param) {
  if (handle == 0 || startAddress == 0) return 0;
  uintptr_t trampoline = TrampolineFor(handle, startAddress);
  if (!trampoline) return 0;
  std::unique_ptr<linuxremote::Hijack> hijack =
      linuxremote::Hijack::Start((uint32_t)handle, startAddress, param, trampoline);
  if (!hijack) return 0;
  return reinterpret_cast<ThreadHandle>(hijack.release());
}

bool WaitForRemoteThread(ThreadHandle thread, uint32_t timeoutMs) {
  if (!thread) return false;
  return reinterpret_cast<linuxremote::Hijack*>(thread)->Wait(timeoutMs);
}

void CloseRemoteThread(ThreadHandle thread) {
  if (!thread) return;
  delete reinterpret_cast<linuxremote::Hijack*>(thread);  // ~Hijack() calls Finish()
}

void DropRemoteState(ProcessHandle handle) {
  std::lock_guard<std::mutex> lk(g_mutex);
  const uint32_t pid = (uint32_t)handle;
  for (auto it = g_allocations.begin(); it != g_allocations.end();) {
    if (it->first.first == pid) it = g_allocations.erase(it);
    else ++it;
  }
  g_trampolines.erase(pid);
}

}  // namespace platform
