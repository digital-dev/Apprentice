// Tests platform::WriteMemory / WriteMemoryUnprotected of the real Linux backend (pwrite on
// /proc/<pid>/mem) against this very process, and against a forked child. Build (run-tests.sh does):
//   g++ -std=c++17 -O0 -g -Wall -pthread -I../../../native/src/platform -o platform_write_test
//     platform_write_test.cc ../platform_linux.cc ../platform_linux_process.cc
//     ../platform_linux_memory.cc ../platform_linux_write.cc -ldl
#include "platform.h"

#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#include <atomic>
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
  CHECK(!platform::WriteMemory(h, A(two + kPage - 4), ff, 8));  // page 0 takes 4 bytes, page 1 refuses
  uint8_t expect[4] = { 0xC3, 0xC3, 0xC3, 0xC3 };
  CHECK(memcmp(two + kPage - 4, expect, 4) == 0);               // rolled back
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
