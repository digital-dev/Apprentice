#include "platform.h"
#include "procmem_fd.h"

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <mutex>
#include <unordered_map>
#include <vector>

// The write side of the Linux backend: pwrite on /proc/<pid>/mem.
//
// Unlike process_vm_writev, a /proc/<pid>/mem write goes through the kernel's
// forced-access path (FOLL_FORCE): it ignores the page's protection for private
// mappings, so read-execute code pages, PROT_NONE pages and read-only data pages
// are written in place, copy-on-write where the page is file-backed, and the
// protection is never touched (nothing to restore, no instruction-cache flush
// needed on x86). Mappings the kernel will not force-write (MAP_SHARED without
// write permission, [vvar], [vsyscall]) fail with EIO/EFAULT and are reported as
// false. Verified empirically on 6.18 for r-x, ---, r-- and shared-ro mappings.
//
// Contract: the whole write succeeds, or false is returned. Failures that can be
// known up front (any page of the range unmapped) are refused BEFORE a byte is
// written. A failure part-way (the mapping vanished, the process died) restores
// what was already written from a backup taken beforehand, best effort.
namespace platform {
namespace {

// One descriptor per ProcessHandle (the handle is the pid), opened lazily on the
// first write. The mutex covers the whole write as well as the table: closing the
// fd while another thread writes through it would let the number be reused.
struct FdTable {
  std::mutex mutex;
  std::unordered_map<ProcessHandle, int> fds;
};
FdTable& Table() {
  static FdTable* t = new FdTable();  // never destroyed: CloseProcess may run at exit
  return *t;
}

int OpenMem(uint32_t pid) {
  return open(("/proc/" + std::to_string(pid) + "/mem").c_str(), O_RDWR | O_CLOEXEC);
}

constexpr size_t kChunk = size_t(1) << 30;           // below pwrite's 2 GiB - 4 KiB cap
constexpr size_t kMaxBackup = size_t(16) << 20;      // larger writes are not backed up

// pwrite all of [data, data+size) at `address`. `written` counts what landed even
// on failure. Caller holds the table mutex.
bool RawWrite(int fd, uintptr_t address, const void* data, size_t size, size_t& written) {
  written = 0;
  // /proc/<pid>/mem offsets are signed; the top half of the address space is never mapped.
  if (address > (uintptr_t)INT64_MAX || address + size < address) return false;
  while (written < size) {
    size_t n = std::min(kChunk, size - written);
    ssize_t got = pwrite(fd, (const char*)data + written, n, (off_t)(address + written));
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) return false;  // EIO/EFAULT: not writable or gone; 0: the process is gone
    written += (size_t)got;
  }
  return true;
}

// True when every page of the range is mapped (PROT_NONE counts: it is writable here).
bool RangeMapped(ProcessHandle handle, uintptr_t address, size_t size) {
  const uintptr_t end = address + size;  // wrap checked by the caller
  uintptr_t cur = address;
  while (cur < end) {
    Region r;
    if (!QueryRegion(handle, cur, r) || r.free || !r.committed) return false;
    const uintptr_t next = r.base + r.size;
    if (next <= cur) return false;  // no progress: refuse rather than loop
    cur = next;
  }
  return true;
}

bool WriteImpl(ProcessHandle handle, uintptr_t address, const void* data, size_t size) {
  if (handle == 0) return false;
  if (size == 0) return true;
  if (data == nullptr || address + size < address) return false;
  if (!RangeMapped(handle, address, size)) return false;

  std::vector<uint8_t> backup;
  if (size <= kMaxBackup) {
    backup.resize(size);
    // An unreadable range (PROT_NONE) is written without a backup.
    if (!ReadMemory(handle, address, backup.data(), size)) backup.clear();
  }

  FdTable& t = Table();
  std::lock_guard<std::mutex> lock(t.mutex);
  auto it = t.fds.find(handle);
  if (it == t.fds.end()) {
    int fd = OpenMem((uint32_t)handle);
    if (fd < 0) return false;
    it = t.fds.emplace(handle, fd).first;
  }
  size_t written = 0;
  if (RawWrite(it->second, address, data, size, written)) return true;
  if (written > 0 && !backup.empty()) {
    size_t undone = 0;
    RawWrite(it->second, address, backup.data(), written, undone);
  }
  return false;
}

} // namespace

void DropProcMemFd(ProcessHandle handle) {
  FdTable& t = Table();
  std::lock_guard<std::mutex> lock(t.mutex);
  auto it = t.fds.find(handle);
  if (it == t.fds.end()) return;
  close(it->second);
  t.fds.erase(it);
}

// No protection to change on Linux, so both entry points are the same write.
bool WriteMemory(ProcessHandle handle, uintptr_t address, const void* data, size_t size) {
  return WriteImpl(handle, address, data, size);
}

bool WriteMemoryUnprotected(ProcessHandle handle, uintptr_t address, const void* data, size_t size) {
  return WriteImpl(handle, address, data, size);
}

} // namespace platform
