#include "platform.h"
#include "platform_linux_write.h"
#include "procmem_fd.h"

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstdio>
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
// what already landed from a backup taken beforehand, best effort. platform.h can
// only answer bool, so a failure that left bytes behind is reported two ways: one
// stderr line, and linuxwrite::LastWriteFailure() (see platform_linux_write.h).
namespace linuxwrite {
namespace {
thread_local WriteFailure g_last;
PwriteFn g_pwrite = nullptr;
} // namespace

const WriteFailure& LastWriteFailure() { return g_last; }
void SetPwriteHookForTest(PwriteFn fn) { g_pwrite = fn; }

} // namespace linuxwrite

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

constexpr size_t kChunk = size_t(1) << 30;  // below pwrite's 2 GiB - 4 KiB cap
// Writes larger than this are NOT backed up (the backup is a full copy of the range, so a
// multi-megabyte write would double its memory). A failure part-way through such a write
// leaves the landed bytes in place and is reported as "skipped: too large".
constexpr size_t kMaxBackup = size_t(16) << 20;

// pwrite all of [data, data+size) at `address`. `written` counts what landed even
// on failure. Caller holds the table mutex.
bool RawWrite(int fd, uintptr_t address, const void* data, size_t size, size_t& written) {
  written = 0;
  // /proc/<pid>/mem offsets are signed; the top half of the address space is never mapped.
  if (address > (uintptr_t)INT64_MAX || address + size < address) return false;
  while (written < size) {
    size_t n = std::min(kChunk, size - written);
    off_t off = (off_t)(address + written);
    ssize_t got = linuxwrite::g_pwrite ? linuxwrite::g_pwrite(fd, (const char*)data + written, n, off)
                                       : pwrite(fd, (const char*)data + written, n, off);
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

// The original bytes of the range, taken one page-sized piece at a time so an
// unreadable page (PROT_NONE) loses only its own backup.
struct Backup {
  struct Piece {
    size_t offset;  // into the written range
    size_t size;
    bool have;
  };
  bool tooLarge = false;
  std::vector<uint8_t> bytes;  // size of the range; only `have` pieces are meaningful
  std::vector<Piece> pieces;
};

Backup TakeBackup(ProcessHandle handle, uintptr_t address, size_t size) {
  Backup b;
  if (size > kMaxBackup) {
    b.tooLarge = true;
    return b;
  }
  b.bytes.resize(size);
  const uintptr_t ps = PageSize();
  size_t off = 0;
  while (off < size) {
    const uintptr_t cur = address + off;
    const size_t len = (size_t)std::min<uintptr_t>(((cur & ~(ps - 1)) + ps) - cur, size - off);
    b.pieces.push_back({off, len, ReadMemory(handle, cur, b.bytes.data() + off, len)});
    off += len;
  }
  return b;
}

// Puts back the first `written` bytes from the backup. Sets f.restored / f.reason, then
// prints the one stderr line for the event.
void Restore(int fd, uintptr_t address, size_t size, size_t written, const Backup& b,
             linuxwrite::WriteFailure& f) {
  bool failed = false, unreadable = false;
  if (b.tooLarge) {
    f.reason = "skipped: too large";
  } else {
    for (const Backup::Piece& p : b.pieces) {
      if (p.offset >= written) break;
      const size_t len = std::min(p.size, written - p.offset);
      if (!p.have) {
        unreadable = true;
        continue;
      }
      size_t undone = 0;
      if (!RawWrite(fd, address + p.offset, b.bytes.data() + p.offset, len, undone)) failed = true;
    }
    f.reason = failed ? "FAILED" : unreadable ? "skipped: unreadable" : "ok";
  }
  f.restored = f.reason == "ok";
  fprintf(stderr, "apprentice: write at 0x%llx+%zu failed after %zu bytes; restore %s\n",
          (unsigned long long)address, size, written, f.reason.c_str());
}

bool WriteImpl(ProcessHandle handle, uintptr_t address, const void* data, size_t size) {
  linuxwrite::g_last = linuxwrite::WriteFailure();
  if (handle == 0) return false;
  if (size == 0) return true;
  if (data == nullptr || address + size < address) return false;
  if (!RangeMapped(handle, address, size)) return false;

  const Backup backup = TakeBackup(handle, address, size);

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
  if (written == 0) {  // nothing changed in the target: nothing to restore or report
    linuxwrite::g_last.attempted = size;
    linuxwrite::g_last.restored = true;
    return false;
  }
  linuxwrite::g_last.attempted = size;
  linuxwrite::g_last.written = written;
  Restore(it->second, address, size, written, backup, linuxwrite::g_last);
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
