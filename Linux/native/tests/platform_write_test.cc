// Tests platform::WriteMemory / WriteMemoryUnprotected of the real Linux backend (pwrite on
// /proc/<pid>/mem) against this very process, and against a forked child. Build (run-tests.sh does):
//   g++ -std=c++17 -O0 -g -Wall -pthread -I../../../native/src/platform -I.. -o platform_write_test
//     platform_write_test.cc ../platform_linux.cc ../platform_linux_process.cc
//     ../platform_linux_memory.cc ../platform_linux_write.cc -ldl
#include "platform.h"
#include "platform_linux_write.h"

#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#include <atomic>
#include <string>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>

static int g_failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);       \
      ++g_failures;                                                \
    }                                                              \
  } while (0)

static const size_t kPage = 4096;

static int OpenFdCount() {
  int n = 0;
  DIR* d = opendir("/proc/self/fd");
  while (readdir(d)) ++n;
  closedir(d);
  return n;
}

static uintptr_t A(void* p) { return (uintptr_t)p; }

// Captures what this process writes to fd 2 between construction and Finish().
struct StderrCapture {
  int saved, rd;
  StderrCapture() {
    int pp[2];
    CHECK(pipe(pp) == 0);
    fflush(stderr);
    saved = dup(2);
    dup2(pp[1], 2);
    close(pp[1]);
    rd = pp[0];
  }
  std::string Finish() {
    fflush(stderr);
    dup2(saved, 2);
    close(saved);
    std::string out;
    char buf[4096];
    ssize_t n;
    while ((n = read(rd, buf, sizeof(buf))) > 0) out.append(buf, (size_t)n);
    close(rd);
    return out;
  }
};

static std::string Line(uintptr_t addr, size_t size, size_t after, const char* restore) {
  char b[256];
  snprintf(b, sizeof(b), "apprentice: write at 0x%llx+%zu failed after %zu bytes; restore %s%c",
           (unsigned long long)addr, size, after, restore, 10);
  return b;
}

// Test seam: real pwrite for the first `g_realCalls` calls, then failure (so the restore fails).
static int g_calls = 0, g_realCalls = 0;
static ssize_t HookPwrite(int fd, const void* buf, size_t n, off_t off) {
  if (++g_calls <= g_realCalls) return pwrite(fd, buf, n, off);
  errno = EIO;
  return -1;
}

int main() {
  std::string err;
  const platform::ProcessHandle h = platform::OpenProcess((uint32_t)getpid(), err);
  CHECK(h != 0);

  // Five pages: [rw][r-x][---][r--][unmapped].
  char* p = (char*)mmap(nullptr, 5 * kPage, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  CHECK(p != MAP_FAILED);
  memset(p, 0xAB, 4 * kPage);
  CHECK(mprotect(p + 1 * kPage, kPage, PROT_READ | PROT_EXEC) == 0);
  CHECK(mprotect(p + 2 * kPage, kPage, PROT_NONE) == 0);
  CHECK(mprotect(p + 3 * kPage, kPage, PROT_READ) == 0);
  CHECK(munmap(p + 4 * kPage, kPage) == 0);

  const uint32_t v = 0x11223344;
  // Plain page, r-x page, PROT_NONE page, r-- page: all written in place.
  CHECK(platform::WriteMemory(h, A(p + 8), &v, 4));
  CHECK(memcmp(p + 8, &v, 4) == 0);
  CHECK(platform::WriteMemory(h, A(p + kPage + 8), &v, 4));
  CHECK(memcmp(p + kPage + 8, &v, 4) == 0);
  CHECK(platform::WriteMemoryUnprotected(h, A(p + 2 * kPage + 8), &v, 4));
  CHECK(platform::WriteMemory(h, A(p + 3 * kPage + 8), &v, 4));
  CHECK(memcmp(p + 3 * kPage + 8, &v, 4) == 0);
  // Protections are as they were.
  platform::Region r;
  CHECK(platform::QueryRegion(h, A(p + kPage), r) && r.executable && !r.writable && r.readable);
  CHECK(platform::QueryRegion(h, A(p + 2 * kPage), r) && !r.readable && !r.writable && !r.executable);
  CHECK(platform::QueryRegion(h, A(p + 3 * kPage), r) && r.readable && !r.writable);

  // A write across r-x / PROT_NONE / r-- pages lands in all three.
  std::vector<uint8_t> big(kPage + 16, 0x5A);  // 8 bytes of page 1, all of page 2, 8 bytes of page 3
  CHECK(platform::WriteMemory(h, A(p + 2 * kPage - 8), big.data(), big.size()));
  CHECK(mprotect(p, 4 * kPage, PROT_READ) == 0);
  CHECK(memcmp(p + 2 * kPage - 8, big.data(), big.size()) == 0);
  CHECK(mprotect(p, kPage, PROT_READ | PROT_WRITE) == 0);

  // Into the unmapped page, or across its edge: refused, nothing written.
  char before[16];
  memcpy(before, p + 4 * kPage - 8, 8);
  uint8_t ff[16];
  memset(ff, 0xFF, sizeof(ff));
  CHECK(!platform::WriteMemory(h, A(p + 4 * kPage - 8), ff, 16));
  CHECK(memcmp(before, p + 4 * kPage - 8, 8) == 0);
  CHECK(!platform::WriteMemory(h, A(p + 4 * kPage), ff, 4));
  CHECK(!platform::WriteMemory(h, 0x10, ff, 4));
  CHECK(!platform::WriteMemory(h, ~(uintptr_t)0 - 3, ff, 16));  // wraps the address space

  // Degenerate arguments.
  CHECK(platform::WriteMemory(h, A(p), ff, 0));         // empty write on a valid handle
  CHECK(!platform::WriteMemory(0, A(p), ff, 0));        // ... but not on an invalid one
  CHECK(!platform::WriteMemory(0, A(p), ff, 4));
  CHECK(!platform::WriteMemory(h, A(p), nullptr, 4));

  // A mapping the kernel will not force-write (shared, mapped read-only): false, and a write that
  // goes through a writable page first and then hits it is rolled back from the backup.
  char tmpl[] = "/tmp/platform_write_test_XXXXXX";
  int fd = mkstemp(tmpl);
  CHECK(fd >= 0);
  unlink(tmpl);
  CHECK(ftruncate(fd, kPage) == 0);
  char* two = (char*)mmap(nullptr, 2 * kPage, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  CHECK(two != MAP_FAILED);
  memset(two, 0xC3, 2 * kPage);
  int rofd = open("/proc/self/exe", O_RDONLY);  // any read-only descriptor
  CHECK(rofd >= 0);
  // Page 1 becomes a MAP_SHARED, PROT_READ view of a file opened read-only.
  CHECK(mmap(two + kPage, kPage, PROT_READ, MAP_SHARED | MAP_FIXED, rofd, 0) == two + kPage);
  char shared0 = two[kPage];
  CHECK(!platform::WriteMemory(h, A(two + kPage + 8), ff, 4));
  CHECK(two[kPage] == shared0);
  // Refused with nothing written: no event, no stderr line.
  {
    StderrCapture cap;
    CHECK(!platform::WriteMemory(h, A(two + kPage + 8), ff, 4));
    CHECK(cap.Finish().empty());
    const auto& f = linuxwrite::LastWriteFailure();
    CHECK(f.written == 0 && f.restored && f.reason.empty());
    CHECK(!platform::WriteMemory(h, A(p + 4 * kPage), ff, 4));  // unmapped: refused up front
    CHECK(linuxwrite::LastWriteFailure().attempted == 0);
  }

  // (1) Page 0 takes 4 bytes, page 1 refuses: rolled back from the backup, and reported.
  {
    StderrCapture cap;
    CHECK(!platform::WriteMemory(h, A(two + kPage - 4), ff, 8));
    std::string err1 = cap.Finish();
    CHECK(err1 == Line(A(two + kPage - 4), 8, 4, "ok"));
    const auto& f = linuxwrite::LastWriteFailure();
    CHECK(f.attempted == 8 && f.written == 4 && f.restored && f.reason == "ok");
    uint8_t expect[4] = { 0xC3, 0xC3, 0xC3, 0xC3 };
    CHECK(memcmp(two + kPage - 4, expect, 4) == 0);  // rolled back
    // A following successful write clears the report.
    CHECK(platform::WriteMemory(h, A(two + 16), ff, 4));
    CHECK(linuxwrite::LastWriteFailure().written == 0 && linuxwrite::LastWriteFailure().reason.empty());
    memset(two, 0xC3, kPage);
  }

  // (2) The restore itself fails (pwrite hooked: the two write calls are real, every restore fails).
  {
    g_calls = 0;
    g_realCalls = 2;
    linuxwrite::SetPwriteHookForTest(HookPwrite);
    StderrCapture cap;
    CHECK(!platform::WriteMemory(h, A(two + kPage - 4), ff, 8));
    std::string err2 = cap.Finish();
    linuxwrite::SetPwriteHookForTest(nullptr);
    CHECK(err2 == Line(A(two + kPage - 4), 8, 4, "FAILED"));
    const auto& f = linuxwrite::LastWriteFailure();
    CHECK(f.attempted == 8 && f.written == 4 && !f.restored && f.reason == "FAILED");
    CHECK(memcmp(two + kPage - 4, ff, 4) == 0);  // the landed bytes really are still there
    memset(two, 0xC3, kPage);
  }

  // (3) [PROT_NONE][rw][shared ro]: the write lands in the first two pages and fails at the third.
  // The rw page is restored from ITS backup; the unreadable page has none, so it is reported skipped.
  {
    char* three = (char*)mmap(nullptr, 3 * kPage, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(three != MAP_FAILED);
    memset(three, 0xC3, 3 * kPage);
    CHECK(mprotect(three, kPage, PROT_NONE) == 0);
    CHECK(mmap(three + 2 * kPage, kPage, PROT_READ, MAP_SHARED | MAP_FIXED, rofd, 0) == three + 2 * kPage);
    std::vector<uint8_t> src(kPage + 8, 0x66);
    StderrCapture cap;
    CHECK(!platform::WriteMemory(h, A(three + kPage - 4), src.data(), src.size()));
    std::string err3 = cap.Finish();
    CHECK(err3 == Line(A(three + kPage - 4), kPage + 8, kPage + 4, "skipped: unreadable"));
    const auto& f = linuxwrite::LastWriteFailure();
    CHECK(f.written == kPage + 4 && !f.restored && f.reason == "skipped: unreadable");
    bool rwRestored = true;
    for (size_t i = 0; i < kPage; ++i) rwRestored &= (uint8_t)three[kPage + i] == 0xC3;
    CHECK(rwRestored);
    CHECK(mprotect(three, kPage, PROT_READ) == 0);
    CHECK(memcmp(three + kPage - 4, src.data(), 4) == 0);  // the PROT_NONE page keeps its 4 bytes
    munmap(three, 3 * kPage);
  }

  // (4) More than 16 MiB: no backup is taken, a mid-way failure is reported as "too large".
  {
    const size_t total = (size_t)17 << 20;
    char* big17 = (char*)mmap(nullptr, total, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(big17 != MAP_FAILED);
    CHECK(mmap(big17 + total - kPage, kPage, PROT_READ, MAP_SHARED | MAP_FIXED, rofd, 0) == big17 + total - kPage);
    std::vector<uint8_t> src(total - kPage + 4, 0x77);
    StderrCapture cap;
    CHECK(!platform::WriteMemory(h, A(big17), src.data(), src.size()));
    std::string err4 = cap.Finish();
    CHECK(err4 == Line(A(big17), src.size(), total - kPage, "skipped: too large"));
    const auto& f = linuxwrite::LastWriteFailure();
    CHECK(f.written == total - kPage && !f.restored && f.reason == "skipped: too large");
    CHECK((uint8_t)big17[0] == 0x77);  // left in place, as reported
    munmap(big17, total);
  }
  close(fd);
  close(rofd);

  // No descriptor outlives its handle, however many times a process is attached, written and detached.
  platform::CloseProcess(h);  // drops the descriptor cached by the writes above (handle == pid)
  const int fdsBefore = OpenFdCount();
  for (int i = 0; i < 300; ++i) {
    platform::ProcessHandle h2 = platform::OpenProcess((uint32_t)getpid(), err);
    CHECK(platform::WriteMemory(h2, A(p + 16), &v, 4));
    if (i % 3 == 0) CHECK(platform::WriteMemory(h2, A(p + 24), &v, 4));  // reuses the cached fd
    platform::CloseProcess(h2);
  }
  CHECK(OpenFdCount() == fdsBefore);

  const platform::ProcessHandle h3 = platform::OpenProcess((uint32_t)getpid(), err);
  CHECK(h3 == h);

  // Concurrent writers (the addon calls from worker threads) plus attach/detach churn on the same pid.
  std::atomic<bool> stop{false};
  std::atomic<int> bad{0};
  std::vector<std::thread> threads;
  for (int t = 0; t < 4; ++t)
    threads.emplace_back([&, t] {
      for (int i = 0; i < 3000; ++i) {
        uint32_t x = (uint32_t)(t * 100000 + i);
        if (!platform::WriteMemory(h, A(p + 64 + t * 8), &x, 4)) ++bad;
        // The churn thread may drop the cached fd between writes; the next write reopens it.
      }
    });
  std::thread churn([&] {
    std::string e;
    while (!stop) {
      platform::ProcessHandle hc = platform::OpenProcess((uint32_t)getpid(), e);
      platform::CloseProcess(hc);  // same handle value as h: drops h's cached fd too
    }
  });
  for (auto& t : threads) t.join();
  stop = true;
  churn.join();
  CHECK(bad == 0);
  CHECK(platform::WriteMemory(h, A(p + 16), &v, 4));  // reopens if the churn dropped it
  CHECK(OpenFdCount() == fdsBefore + 1);               // exactly one cached descriptor

  // A dead target: the write fails cleanly, and closing its handle leaks nothing.
  pid_t child = fork();
  if (child == 0) {
    pause();
    _exit(0);
  }
  usleep(100000);
  platform::ProcessHandle hc = platform::OpenProcess((uint32_t)child, err);
  CHECK(hc != 0);
  platform::Region cr;
  CHECK(platform::QueryRegion(hc, A(p), cr) && !cr.free);  // forked copy of the layout
  CHECK(platform::WriteMemory(hc, A(p + 8), &v, 4));       // child's copy, not ours
  CHECK(kill(child, SIGKILL) == 0);
  int status = 0;
  waitpid(child, &status, 0);
  CHECK(!platform::WriteMemory(hc, A(p + 8), &v, 4));
  platform::CloseProcess(hc);

  platform::CloseProcess(h);
  CHECK(OpenFdCount() == fdsBefore);

  if (g_failures) {
    printf("platform_write_test: %d failure(s)\n", g_failures);
    return 1;
  }
  printf("platform_write_test OK\n");
  return 0;
}
