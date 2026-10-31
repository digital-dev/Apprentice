#pragma once
#include <sys/types.h>

#include <cstddef>
#include <string>

// Linux-only side channel of platform::WriteMemory (which can only answer bool): what a failed write
// left behind. Native tests assert on it; the same facts are printed to stderr, one line per event.
namespace linuxwrite {

struct WriteFailure {
  size_t attempted = 0;   // bytes the failed call was asked to write
  size_t written = 0;     // bytes that landed before it failed (0: nothing changed in the target)
  bool restored = true;   // true when written == 0 or every landed byte was put back
  std::string reason;     // "" when written == 0; else "ok", "FAILED", "skipped: unreadable", "skipped: too large"
};

// The outcome of the calling thread's most recent platform::WriteMemory / WriteMemoryUnprotected.
// Cleared at the start of every write, so a successful write or a refusal with nothing written
// leaves it empty.
const WriteFailure& LastWriteFailure();

// Test seam: replaces pwrite() for every write and restore (nullptr: the real one).
using PwriteFn = ssize_t (*)(int fd, const void* buf, size_t count, off_t offset);
void SetPwriteHookForTest(PwriteFn fn);

} // namespace linuxwrite
