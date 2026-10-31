// Tests RemoteSyscall, AllocateNear/FreeMemory and the CreateRemoteThread
// thread-hijack against forked children of this process (a descendant, so
// Yama's ptrace_scope=1 allows it without root). Build (run-tests.sh does):
//   g++ -std=c++17 -O0 -g -Wall -pthread -Inative/src/platform -ILinux/native
//     -o remote_exec_test remote_exec_test.cc ../tracer_thread.cc
//     ../ptrace_core.cc ../remote_exec.cc ../platform_linux_ptrace.cc
//     ../platform_linux_remote.cc ../platform_linux.cc ../platform_linux_process.cc
//     ../platform_linux_memory.cc ../platform_linux_write.cc -ldl
#include "platform.h"
#include "ptrace_core.h"
#include "remote_exec.h"
#include "tracer_thread.h"

#include <dirent.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

static int g_failures = 0;
#define CHECK(cond)                                          \
  do {                                                       \
    if (!(cond)) {                                           \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                          \
    }                                                         \
  } while (0)

using Clock = std::chrono::steady_clock;
static long MsSince(Clock::time_point t) {
  return (long)std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t).count();
}

static std::string Slurp(const std::string& path) {
  std::ifstream f(path);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

static std::vector<pid_t> Tasks(pid_t pid) {
  std::vector<pid_t> out;
  DIR* d = opendir(("/proc/" + std::to_string(pid) + "/task").c_str());
  if (!d) return out;
  while (dirent* e = readdir(d))
    if (e->d_name[0] != '.') out.push_back(atoi(e->d_name));
  closedir(d);
  return out;
}

static char TaskState(pid_t pid, pid_t tid) {
  std::string s = Slurp("/proc/" + std::to_string(pid) + "/task/" + std::to_string(tid) + "/stat");
  size_t rp = s.rfind(')');
  return rp == std::string::npos || rp + 2 >= s.size() ? 0 : s[rp + 2];
}

static int CountState(pid_t pid, char state) {
  int n = 0;
  for (pid_t t : Tasks(pid)) n += TaskState(pid, t) == state;
  return n;
}

static bool ReapWithin(pid_t pid, int ms) {
  for (int i = 0; i < ms; ++i) {
    int st;
    if (waitpid(pid, &st, WNOHANG) == pid) return true;
    usleep(1000);
  }
  return false;
}

static void KillChild(pid_t pid) {
  kill(pid, SIGKILL);
  if (!ReapWithin(pid, 3000)) {
    printf("FAIL: child %d not reaped\n", (int)pid);
    ++g_failures;
  }
}

// `mov dword ptr [rdi], 0x1337 ; xor eax,eax ; ret` — SysV ABI, one pointer
// argument. Written into RWX anonymous memory the CHILD maps for itself
// (its own mmap, nothing to do with AllocateNear), so CreateRemoteThread
// has a real function to call without depending on any ELF/export lookup.
static const unsigned char kStubCode[] = {0xC7, 0x07, 0x37, 0x13, 0x00, 0x00, 0x31, 0xC0, 0xC3};
// `jmp $` (EB FE): spins forever, for the timeout test.
static const unsigned char kSpinCode[] = {0xEB, 0xFE};

struct ChildInfo {
  pid_t pid;
  uintptr_t funcAddr;
  uintptr_t spinAddr;
  uintptr_t scratchAddr;
  int wakePipe;  // readable end; the sleeper thread writes one byte once nanosleep returns
};

// Child process: maps the stub/spin code and a scratch int, starts one
// thread that sleeps, then both it and the main thread block in an
// interruptible wait forever (`pause`/the sleep). Reports its addresses and
// the wake-pipe's read end back over `infoPipe` before blocking.
static void ChildBody(int infoPipe[2], int wakePipe[2]) {
  close(infoPipe[0]);
  close(wakePipe[0]);

  void* func = mmap(nullptr, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  memcpy(func, kStubCode, sizeof(kStubCode));
  void* spin = mmap(nullptr, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  memcpy(spin, kSpinCode, sizeof(kSpinCode));
  void* scratch = mmap(nullptr, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  *(int*)scratch = 0;

  // wakePipe[1] here is the CHILD's own fd number for the write end, meaningless in the parent;
  // SpawnChild below overwrites this field with the parent's own read-end fd before using it.
  ChildInfo info{getpid(), (uintptr_t)func, (uintptr_t)spin, (uintptr_t)scratch, wakePipe[1]};
  write(infoPipe[1], &info, sizeof(info));
  close(infoPipe[1]);

  auto* sleeper = +[](void* arg) -> void* {
    int fd = *(int*)arg;
    struct timespec ts{1, 500000000};  // 1.5s
    nanosleep(&ts, nullptr);
    char one = 1;
    write(fd, &one, 1);
    close(fd);
    return nullptr;
  };
  static int fd;
  fd = wakePipe[1];
  pthread_t t;
  pthread_create(&t, nullptr, sleeper, &fd);

  for (;;) pause();
}

// Forks exactly ONE extra thread (the sleeper) besides the leader, so
// PickHijackThread's tie-break (equal safety score, prefer non-leader) is
// deterministic. Blocks until both threads exist.
static ChildInfo SpawnChild() {
  int infoPipe[2], wakePipe[2];
  if (pipe(infoPipe) != 0 || pipe(wakePipe) != 0) { perror("pipe"); exit(1); }
  pid_t pid = fork();
  if (pid == 0) ChildBody(infoPipe, wakePipe);
  close(infoPipe[1]);
  close(wakePipe[1]);
  ChildInfo info{};
  read(infoPipe[0], &info, sizeof(info));
  close(infoPipe[0]);
  info.wakePipe = wakePipe[0];  // the PARENT's own read end, not whatever fd number the child sent
  for (int i = 0; i < 200 && Tasks(pid).size() < 2; ++i) usleep(5000);
  return info;
}

// ---------------------------------------------------------------------------------------------

static void TestRemoteSyscallGetpid() {
  ChildInfo c = SpawnChild();
  uint64_t args[6] = {0, 0, 0, 0, 0, 0};
  uint64_t result = 0;
  CHECK(linuxremote::RemoteSyscall((uint32_t)c.pid, SYS_getpid, args, result));
  CHECK((pid_t)result == c.pid);
  CHECK(CountState(c.pid, 't') == 0);  // nothing left stopped
  KillChild(c.pid);
}

static void TestAllocateNearAndFree() {
  ChildInfo c = SpawnChild();
  platform::ProcessHandle h = (platform::ProcessHandle)c.pid;
  uintptr_t cave = platform::AllocateNear(h, c.funcAddr, 4096);
  CHECK(cave != 0);
  uintptr_t diff = cave > c.funcAddr ? cave - c.funcAddr : c.funcAddr - cave;
  CHECK(diff < 0x80000000ull);

  platform::Region r;
  CHECK(platform::QueryRegion(h, cave, r));
  CHECK(r.readable && r.writable && r.executable && !r.free);

  CHECK(platform::FreeMemory(h, cave));
  platform::Region after;
  CHECK(platform::QueryRegion(h, cave, after) && after.free);
  CHECK(!platform::FreeMemory(h, cave));  // already freed: refuses, doesn't double-munmap
  KillChild(c.pid);
}

static void TestRemoteCall() {
  ChildInfo c = SpawnChild();
  platform::ProcessHandle h = (platform::ProcessHandle)c.pid;
  platform::ThreadHandle t = platform::CreateRemoteThread(h, c.funcAddr, c.scratchAddr);
  CHECK(t != 0);
  CHECK(platform::WaitForRemoteThread(t, 2000));
  platform::CloseRemoteThread(t);

  int value = 0;
  CHECK(platform::ReadMemory(h, c.scratchAddr, &value, sizeof(value)));
  CHECK(value == 0x1337);
  CHECK(CountState(c.pid, 't') == 0);
  KillChild(c.pid);
}

static void TestManyCallsStayHealthy() {
  ChildInfo c = SpawnChild();
  platform::ProcessHandle h = (platform::ProcessHandle)c.pid;
  auto start = Clock::now();
  int ok = 0;
  for (int i = 0; i < 500; ++i) {
    platform::ThreadHandle t = platform::CreateRemoteThread(h, c.funcAddr, c.scratchAddr);
    if (!t) continue;
    if (platform::WaitForRemoteThread(t, 2000)) ++ok;
    platform::CloseRemoteThread(t);
  }
  CHECK(ok == 500);
  CHECK(MsSince(start) < 5000);
  int value = 0;
  CHECK(platform::ReadMemory(h, c.scratchAddr, &value, sizeof(value)) && value == 0x1337);
  KillChild(c.pid);
}

// A remote call issued while one thread is mid-nanosleep must not shorten
// that sleep: the kernel's syscall-restart check has to see the thread's
// TRUE original orig_rax/rax once this is over, or nanosleep returns EINTR
// early instead of actually sleeping out its remaining duration.
static void TestSleepRestartSemantics() {
  ChildInfo c = SpawnChild();
  usleep(100000);  // let the sleeper thread actually enter nanosleep first

  auto beforeCall = Clock::now();
  uint64_t args[6] = {0, 0, 0, 0, 0, 0};
  uint64_t result = 0;
  CHECK(linuxremote::RemoteSyscall((uint32_t)c.pid, SYS_getpid, args, result));

  char woke = 0;
  ssize_t n = read(c.wakePipe, &woke, 1);
  long elapsedSinceCall = MsSince(beforeCall);
  CHECK(n == 1);
  // Already ~0.1-1.5s into the sleep by the time of the call; the remainder
  // alone is well over 1 second if the sleep restarted properly, versus
  // returning almost immediately (a few ms) if the remote call cut it short.
  CHECK(elapsedSinceCall > 800);
  close(c.wakePipe);
  KillChild(c.pid);
}

// A stub that never returns: WaitForRemoteThread must not hang (bounded
// false), CloseRemoteThread must not hang either, and the process must not
// end up with anything left ptrace-stopped — SuspendAll on the SAME pid
// afterward either still works or fails fast with an actionable error
// ("still detaching"/already traced by us), never hangs. Only killing the
// whole process actually stops the spinning thread, same as a hung
// CreateRemoteThread would be handled on Windows.
static void TestTimeoutNeverHangs() {
  ChildInfo c = SpawnChild();
  platform::ProcessHandle h = (platform::ProcessHandle)c.pid;
  auto start = Clock::now();
  platform::ThreadHandle t = platform::CreateRemoteThread(h, c.spinAddr, 0);
  CHECK(t != 0);
  CHECK(!platform::WaitForRemoteThread(t, 300));
  CHECK(MsSince(start) < 1000);  // the wait itself was bounded, not accidentally 2s+

  auto closeStart = Clock::now();
  platform::CloseRemoteThread(t);
  CHECK(MsSince(closeStart) < 1000);  // Finish's own extra grace is bounded too

  // Whatever state that one thread is in, SuspendAll must return within a
  // bounded time — success or a clean failure, never a hang.
  auto suspendStart = Clock::now();
  bool suspended = platform::SuspendAll(h, (uint32_t)c.pid);
  CHECK(MsSince(suspendStart) < 3000);
  if (suspended) platform::ResumeAll();
  KillChild(c.pid);  // the only way to actually stop the spinning thread
}

// A bad start address faults the hijacked thread instead of trapping on our
// trampoline: the run must be aborted (registers restored, the fault never
// delivered) rather than corrupting the thread or crashing the target.
static void TestHostileStartAddress() {
  ChildInfo c = SpawnChild();
  platform::ProcessHandle h = (platform::ProcessHandle)c.pid;
  platform::ThreadHandle t = platform::CreateRemoteThread(h, 0x1, c.scratchAddr);
  CHECK(t != 0);
  CHECK(!platform::WaitForRemoteThread(t, 2000));  // faulted, not our trap: reported as failure
  platform::CloseRemoteThread(t);
  CHECK(CountState(c.pid, 't') == 0);  // nothing left stopped by the failed attempt

  // The target must still be alive and usable.
  uint64_t args[6] = {0, 0, 0, 0, 0, 0};
  uint64_t result = 0;
  CHECK(linuxremote::RemoteSyscall((uint32_t)c.pid, SYS_getpid, args, result));
  CHECK((pid_t)result == c.pid);
  KillChild(c.pid);
}

// Ruling 15: a remote call issued while SuspendAll already holds the target
// reuses one of its held threads directly, and leaves the hold intact.
static void TestRemoteCallWhileHeld() {
  ChildInfo c = SpawnChild();
  platform::ProcessHandle h = (platform::ProcessHandle)c.pid;
  CHECK(platform::SuspendAll(h, (uint32_t)c.pid));
  CHECK(CountState(c.pid, 't') == 2);

  platform::ThreadHandle t = platform::CreateRemoteThread(h, c.funcAddr, c.scratchAddr);
  CHECK(t != 0);
  CHECK(platform::WaitForRemoteThread(t, 2000));
  platform::CloseRemoteThread(t);

  CHECK(CountState(c.pid, 't') == 2);  // the hold is still intact afterward
  int value = 0;
  CHECK(platform::ReadMemory(h, c.scratchAddr, &value, sizeof(value)) && value == 0x1337);

  platform::ResumeAll();
  CHECK(CountState(c.pid, 't') == 0);
  KillChild(c.pid);
}

int main() {
  TestRemoteSyscallGetpid();
  TestAllocateNearAndFree();
  TestRemoteCall();
  TestManyCallsStayHealthy();
  TestSleepRestartSemantics();
  TestTimeoutNeverHangs();
  TestHostileStartAddress();
  TestRemoteCallWhileHeld();
  if (g_failures) {
    printf("remote_exec_test: %d failure(s)\n", g_failures);
    return 1;
  }
  puts("remote_exec_test OK");
  return 0;
}
