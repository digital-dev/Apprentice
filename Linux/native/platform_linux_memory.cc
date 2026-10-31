#include "platform.h"
#include "proc_parse.h"
#include "module_parse.h"

#include <fcntl.h>
#include <sys/uio.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <mutex>

// The read side of the Linux backend: regions from /proc/<pid>/maps, memory
// reads, module listing and export resolution. Parsing lives in proc_parse.h
// (maps) and module_parse.h (PE/ELF); this file only does the IO.
//
// A target can exit at any point. Every failure here (ESRCH, ENOENT, a maps
// read that dies halfway) is reported as false/0; nothing blocks or throws.
namespace platform {
namespace {

// The whole of /proc/<pid>/maps. False if it cannot be opened or a read fails
// (process gone, or another user's process).
bool ReadMapsText(uint32_t pid, std::string& out) {
  out.clear();
  int fd = open(("/proc/" + std::to_string(pid) + "/maps").c_str(), O_RDONLY | O_CLOEXEC);
  if (fd < 0) return false;
  char buf[65536];
  for (;;) {
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n < 0) {
      if (errno == EINTR) continue;
      close(fd);
      return false;
    }
    if (n == 0) break;
    out.append(buf, (size_t)n);
  }
  close(fd);
  return true;
}

// Parsed maps, sorted and non-overlapping. The kernel produces the file one
// read() chunk at a time, so a mapping change mid-read can yield overlaps; that
// is retried once. An empty result (zombie, exiting) is a failure too.
bool ReadMaps(uint32_t pid, std::vector<linuxproc::MapsEntry>& out) {
  for (int attempt = 0; attempt < 2; ++attempt) {
    std::string text;
    if (!ReadMapsText(pid, text)) return false;
    bool consistent = true;
    std::vector<linuxproc::MapsEntry> entries = linuxproc::ParseMaps(text, &consistent);
    if (entries.empty() || !consistent) continue;
    out = std::move(entries);
    return true;
  }
  return false;
}

// Reading maps costs the kernel one pass over every mapping of the target
// (milliseconds for a real game), and the scanners call QueryRegion once per
// region while walking upward. So a walk reuses the maps read by its previous
// step: only a query for exactly the address the previous answer ended at, soon
// after, is served from the cache. Any other query (a random lookup, the first
// step of a walk) reads maps fresh, so it never sees stale data.
//
// No InvalidateRegionCache(pid) hook: closing out a carried TODO, not a gap
// left open. This cache can go stale the instant something changes the
// target's memory map (mmap/munmap/mprotect) between a walk's steps, and an
// explicit InvalidateRegionCache(pid) — clearing g_cache when g_cache.pid ==
// pid — was proposed back in Task 8 for exactly that. It was carried forward
// through Tasks 10, 11, 12 and 15 without ever being added, and without ever
// being needed: every caller that performs mmap/munmap/mprotect on this
// backend's behalf either bypasses this cached path entirely (AllocateNear/
// FreeMemory's remote mmap/munmap calls go straight through remote_exec.cc's
// syscall plumbing, never through QueryRegion) or only ever reads through it
// (AllocateNear's own candidate search calls QueryRegion read-only, to find
// free ranges, and never follows a mapping change it caused with another
// QueryRegion in the same walk). With no caller on either side of that gap,
// there has been nothing to invalidate for. This is deliberately a comment,
// not a speculative function: a FUTURE caller that interleaves a cached
// QueryRegion walk with its own mmap/munmap/mprotect calls — resuming the
// walk afterward, expecting it to see the new map state — would need
// InvalidateRegionCache(pid) added then, wired into that caller's own
// mmap/munmap/mprotect path, not preemptively here.
struct MapsCache {
  std::mutex mutex;
  bool valid = false;
  uint32_t pid = 0;
  uintptr_t nextAddr = 0;
  std::chrono::steady_clock::time_point at;
  std::vector<linuxproc::MapsEntry> entries;
};
MapsCache g_cache;
constexpr std::chrono::milliseconds kWalkCacheMaxAge(2000);

// process_vm_readv in chunks the kernel accepts. True only when every byte was read.
bool ReadViaVm(uint32_t pid, uintptr_t address, void* out, size_t size, int& err) {
  constexpr size_t kChunk = 256u << 20;
  size_t done = 0;
  while (done < size) {
    size_t n = std::min(kChunk, size - done);
    iovec local{(char*)out + done, n};
    iovec remote{(void*)(address + done), n};
    ssize_t got = process_vm_readv((pid_t)pid, &local, 1, &remote, 1, 0);
    if (got < 0) {
      if (errno == EINTR) continue;
      err = errno;
      return false;
    }
    if (got == 0) { err = EFAULT; return false; }
    done += (size_t)got;
    if ((size_t)got < n) { err = EFAULT; return false; }  // partial: unmapped page reached
  }
  return true;
}

// Fallback when process_vm_readv is unavailable or refused (seccomp, ENOSYS,
// EPERM): positional read on /proc/<pid>/mem. All-or-nothing like the above.
bool ReadViaProcMem(uint32_t pid, uintptr_t address, void* out, size_t size) {
  int fd = open(("/proc/" + std::to_string(pid) + "/mem").c_str(), O_RDONLY | O_CLOEXEC);
  if (fd < 0) return false;
  size_t done = 0;
  bool ok = true;
  while (done < size) {
    ssize_t got = pread(fd, (char*)out + done, size - done, (off_t)(address + done));
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) { ok = false; break; }
    done += (size_t)got;
  }
  close(fd);
  return ok;
}

// The parsers' view of target memory.
linuxmod::ReadFn Reader(ProcessHandle handle) {
  return [handle](uintptr_t address, void* out, size_t size) {
    return ReadMemory(handle, address, out, size);
  };
}

} // namespace

bool ReadMemory(ProcessHandle handle, uintptr_t address, void* out, size_t size) {
  if (size == 0) return true;
  if (handle == 0 || out == nullptr) return false;
  // An address range that wraps the address space can never be mapped.
  if (address + size < address) return false;
  const uint32_t pid = (uint32_t)handle;
  int err = 0;
  if (ReadViaVm(pid, address, out, size, err)) return true;
  // EFAULT: reached an unmapped or unreadable page, which is the answer.
  // ESRCH: the process is gone. Only a refused call is worth the fallback.
  if (err == EPERM || err == ENOSYS || err == EACCES) return ReadViaProcMem(pid, address, out, size);
  return false;
}

bool QueryRegion(ProcessHandle handle, uintptr_t address, Region& out) {
  if (handle == 0) return false;
  const uint32_t pid = (uint32_t)handle;
  std::lock_guard<std::mutex> lock(g_cache.mutex);
  const auto now = std::chrono::steady_clock::now();
  const bool walking = g_cache.valid && g_cache.pid == pid && g_cache.nextAddr == address &&
                       now - g_cache.at < kWalkCacheMaxAge;
  if (!walking) {
    g_cache.valid = false;
    if (!ReadMaps(pid, g_cache.entries)) return false;
    g_cache.pid = pid;
    g_cache.at = now;
    g_cache.valid = true;
  }
  linuxproc::RegionAnswer a;
  if (!linuxproc::QueryMaps(g_cache.entries, address, a)) {
    g_cache.valid = false;
    return false;
  }
  g_cache.nextAddr = a.end;

  out = Region{};
  out.base = a.base;
  out.size = a.end - a.base;
  out.free = a.free;
  out.committed = !a.free;  // any mapping is committed, PROT_NONE included
  out.readable = !a.free && a.r;
  out.writable = !a.free && a.w;
  out.executable = !a.free && a.x;
  out.execCopyOnWrite = false;
  return true;
}

uintptr_t PageSize() {
  static const uintptr_t size = [] {
    long v = sysconf(_SC_PAGESIZE);
    return v > 0 ? (uintptr_t)v : (uintptr_t)4096;
  }();
  return size;
}

// Name, base and size of every PE/ELF image in the target. `fullInfo` (ListModules)
// also fills the PE fingerprint and skips a PE whose headers cannot be read, as
// Windows does (no 0/0 fingerprint); ListModuleRanges keeps such a PE with its file
// span. Both go through linuxmod::MeasureImage, so they agree on which files are
// modules and how big each is (SizeOfImage / ELF program-header extent, which
// includes .bss). A mapped data file (locale archive, asset bundle, .nls) is not an
// image and is skipped by both.
static bool EnumerateModules(ProcessHandle handle, std::vector<ModuleInfo>& out, bool fullInfo) {
  out.clear();
  std::vector<linuxproc::MapsEntry> maps;
  if (handle == 0 || !ReadMaps((uint32_t)handle, maps)) return false;
  const linuxmod::ReadFn read = Reader(handle);
  for (const linuxproc::ModuleSpan& m : linuxproc::GroupModules(maps)) {
    linuxmod::MeasuredImage img = linuxmod::MeasureImage(read, m.base, m.end - m.base);
    if (img.kind == linuxmod::ImageKind::Unknown) continue;
    if (fullInfo && img.kind == linuxmod::ImageKind::Pe && !img.headersOk) continue;
    ModuleInfo info;
    info.name = linuxproc::BaseName(m.path);
    info.base = m.base;
    info.size = (uint32_t)std::min<uint64_t>(img.size, 0xffffffffu);
    info.timestamp = img.timestamp;
    // version stays empty: there is no file-version resource lookup on Linux.
    out.push_back(std::move(info));
  }
  return true;
}

bool ListModuleRanges(ProcessHandle handle, std::vector<ModuleRange>& out) {
  std::vector<ModuleInfo> mods;
  out.clear();
  if (!EnumerateModules(handle, mods, false)) return false;
  for (const ModuleInfo& m : mods) out.push_back({m.name, m.base, (uintptr_t)m.size});
  return true;
}

bool ListModules(ProcessHandle handle, std::vector<ModuleInfo>& out) {
  return EnumerateModules(handle, out, true);
}

uintptr_t ResolveExport(ProcessHandle handle, uintptr_t moduleBase, const std::string& name) {
  if (handle == 0 || name.empty()) return 0;
  const linuxmod::ReadFn read = Reader(handle);
  std::map<std::string, uintptr_t> exports;
  switch (linuxmod::DetectImage(read, moduleBase)) {
    case linuxmod::ImageKind::Pe:
      if (!linuxmod::ParsePeExports(read, moduleBase, exports)) return 0;
      break;
    case linuxmod::ImageKind::Elf:
      if (!linuxmod::ParseElfDynsym(read, moduleBase, exports)) return 0;
      break;
    case linuxmod::ImageKind::Unknown:
      return 0;
  }
  auto it = exports.find(name);
  return it == exports.end() ? 0 : it->second;
}

} // namespace platform
