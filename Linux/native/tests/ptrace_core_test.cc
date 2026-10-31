// Tests the tracer thread, ptrace_core (StopGuard, registers) and the platform glue
// (SuspendAll/ResumeAll/GetThreadRegisters/ListThreads) against forked children of this
// process (a descendant, so Yama's ptrace_scope=1 allows it without root). Build (run-tests.sh does):
//   g++ -std=c++17 -O0 -g -Wall -pthread -I../../../native/src/platform -I.. -o ptrace_core_test
//     ptrace_core_test.cc ../tracer_thread.cc ../ptrace_core.cc ../platform_linux_ptrace.cc
//     ../platform_linux.cc ../platform_linux_process.cc ../platform_linux_memory.cc
//     ../platform_linux_write.cc -ldl
#include "platform.h"
#include "ptrace_core.h"
#include "tracer_thread.h"

#include <dirent.h>
#include <pthread.h>
#include <sys/ptrace.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

static int g_failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);       \
      ++g_failures;                                                \
    }                                                              \
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

// State letter of one thread ('t' = ptrace-stopped), 0 when gone.
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

static int TracedCount(pid_t pid) {
  int n = 0;
  for (pid_t t : Tasks(pid)) {
    std::string s = Slurp("/proc/" + std::to_string(pid) + "/task/" + std::to_string(t) + "/status");
    size_t i = s.find("TracerPid:\t");
    if (i != std::string::npos && atoi(s.c_str() + i + 11) != 0) ++n;
  }
  return n;
}

// Child bodies. `spinners` busy threads; with `storm`, a spawner keeps creating short-lived threads.
static void* Spin(void*) {
  for (;;) usleep(1000);
  return nullptr;
}
static void* ShortLived(void*) {
  usleep(500);
  return nullptr;
}
static void* Storm(void*) {
  for (;;) {
    pthread_t t;
    if (pthread_create(&t, nullptr, ShortLived, nullptr) == 0) pthread_detach(t);
    usleep(200);
  }
  return nullptr;
}

static pid_t SpawnChild(int spinners, bool storm) {
  pid_t pid = fork();
  if (pid == 0) {
    for (int i = 0; i < spinners; ++i) {
      pthread_t t;
      pthread_create(&t, nullptr, Spin, nullptr);
    }
    if (storm) {
      pthread_t t;
      pthread_create(&t, nullptr, Storm, nullptr);
    }
    for (;;) pause();
  }
  // Wait until the spinners exist.
  for (int i = 0; i < 200 && (int)Tasks(pid).size() < 1 + spinners; ++i) usleep(5000);
  return pid;
}

// waitpid with a bound (a test must not hang); true when `pid` was reaped.
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

// ---------------------------------------------------------------------------------------------

static void TestRegsConversion() {
  user_regs_struct r{};
  r.rax = 1; r.rbx = 2; r.rcx = 3; r.rdx = 4; r.rsi = 5; r.rdi = 6; r.rbp = 7; r.rsp = 8;
  r.rip = 9; r.r8 = 10; r.r9 = 11; r.r10 = 12; r.r11 = 13; r.r12 = 14; r.r13 = 15; r.r14 = 16;
  r.r15 = 17; r.eflags = 0x246;
  platform::ThreadRegisters t;
  linuxptrace::ToThreadRegisters(r, t);
  CHECK(t.rax == 1 && t.rbx == 2 && t.rcx == 3 && t.rdx == 4 && t.rsi == 5 && t.rdi == 6);
  CHECK(t.rbp == 7 && t.rsp == 8 && t.rip == 9 && t.r8 == 10 && t.r9 == 11 && t.r10 == 12);
  CHECK(t.r11 == 13 && t.r12 == 14 && t.r13 == 15 && t.r14 == 16 && t.r15 == 17);
  CHECK(t.rflags == 0x246);
}

static void TestDeniedMessage() {
  CHECK(std::string(linuxptrace::kPtraceDeniedMessage) ==
        "ptrace denied: run with CAP_SYS_PTRACE or set /proc/sys/kernel/yama/ptrace_scope to 0");
  CHECK(linuxptrace::PtraceDenied(linuxptrace::kPtraceDeniedMessage));
  CHECK(!linuxptrace::PtraceDenied("thread 5 exited"));
  CHECK(!linuxptrace::PtraceDenied(""));
}

static void TestTracerThread() {
  using linuxptrace::OnTracer;
  using linuxptrace::OnTracerThread;
  CHECK(!OnTracerThread());
  CHECK(OnTracer([] { return 41 + 1; }) == 42);
  CHECK(OnTracer([] { return OnTracerThread(); }));
  // Same thread every time.
  std::thread::id a = OnTracer([] { return std::this_thread::get_id(); });
  std::thread::id b = OnTracer([] { return std::this_thread::get_id(); });
  CHECK(a == b && a != std::this_thread::get_id());
  // Nested: runs inline instead of deadlocking.
  CHECK(OnTracer([] { return OnTracer([] { return 7; }) + 1; }) == 8);
  // Exceptions stay on the tracer thread; the caller gets a default value.
  CHECK(OnTracer([]() -> int { throw std::runtime_error("x"); }) == 0);
  CHECK(OnTracer([] { return 5; }) == 5);  // still alive afterwards
  // void callables.
  int hit = 0;
  linuxptrace::OnTracer([&] { hit = 1; });
  CHECK(hit == 1);
  // Many callers at once all get their own answer.
  std::vector<std::thread> ths;
  std::atomic<int> good{0};
  for (int i = 0; i < 8; ++i)
    ths.emplace_back([&good, i] {
      for (int k = 0; k < 50; ++k)
        if (OnTracer([i, k] { return i * 1000 + k; }) == i * 1000 + k) ++good;
    });
  for (auto& t : ths) t.join();
  CHECK(good == 400);
  // RunPending from the tracer thread runs work queued meanwhile by another thread.
  std::atomic<bool> queuedDone{false};
  bool ranInside = OnTracer([&] {
    std::thread other([&] { linuxptrace::OnTracer([&] { queuedDone = true; }); });
    for (int i = 0; i < 200 && !queuedDone; ++i) {
      linuxptrace::RunPending();
      usleep(2000);
    }
    bool r = queuedDone;
    other.join();
    return r;
  });
  CHECK(ranInside);
}

static void TestStopGuard() {
  pid_t pid = SpawnChild(2, false);
  std::vector<pid_t> tids = Tasks(pid);
  CHECK(tids.size() == 3);
  bool stoppedInside = linuxptrace::OnTracer([&] {
    std::string err;
    linuxptrace::StopGuard g(tids[1], err);
    if (!g.ok()) return false;
    user_regs_struct r{};
    bool regs = linuxptrace::GetRegs(tids[1], r) && r.rip != 0 && linuxptrace::SetRegs(tids[1], r);
    return regs && TaskState(pid, tids[1]) == 't' && TaskState(pid, tids[0]) != 't';
  });
  CHECK(stoppedInside);
  CHECK(CountState(pid, 't') == 0);
  CHECK(TracedCount(pid) == 0);
  // Off the tracer thread a guard refuses instead of attaching to the wrong thread.
  {
    std::string err;
    linuxptrace::StopGuard g(tids[1], err);
    CHECK(!g.ok() && !err.empty());
    CHECK(TracedCount(pid) == 0);
  }
  // A missing thread: clean failure.
  bool missing = linuxptrace::OnTracer([] {
    std::string err;
    linuxptrace::StopGuard g(999999999, err);
    return !g.ok() && g.gone() && !err.empty();
  });
  CHECK(missing);
  KillChild(pid);
}

static void TestSuspendResume() {
  pid_t pid = SpawnChild(4, false);
  CHECK(platform::SuspendAll((platform::ProcessHandle)pid, (uint32_t)pid));
  CHECK(CountState(pid, 't') == (int)Tasks(pid).size());
  // Not reentrant: refuses and leaves the first suspension alone.
  CHECK(!platform::SuspendAll((platform::ProcessHandle)pid, (uint32_t)pid));
  CHECK(!platform::SuspendAllError().empty());
  CHECK(CountState(pid, 't') == (int)Tasks(pid).size());
  // A held thread's registers are read in place: it stays stopped.
  platform::ThreadRegisters regs;
  for (pid_t t : Tasks(pid)) {
    CHECK(platform::GetThreadRegisters((uint32_t)t, regs));
    CHECK(regs.rip != 0 && regs.rsp != 0);
  }
  CHECK(CountState(pid, 't') == (int)Tasks(pid).size());
  // ResumeAll from a DIFFERENT thread than the one that suspended.
  std::thread([] { platform::ResumeAll(); }).join();
  CHECK(CountState(pid, 't') == 0);
  CHECK(TracedCount(pid) == 0);
  platform::ResumeAll();  // idempotent
  // Registers of a running thread: brief stop, then it runs again.
  CHECK(platform::GetThreadRegisters((uint32_t)Tasks(pid)[1], regs) && regs.rip != 0);
  CHECK(CountState(pid, 't') == 0 && TracedCount(pid) == 0);
  CHECK(!platform::GetThreadRegisters(999999999u, regs));
  // Suspend again after the pair completed.
  CHECK(platform::SuspendAll((platform::ProcessHandle)pid, (uint32_t)pid));
  platform::ResumeAll();
  CHECK(TracedCount(pid) == 0);
  KillChild(pid);
}

static void TestListThreads() {
  pid_t pid = SpawnChild(3, false);
  std::vector<platform::ThreadInfo> out;
  CHECK(platform::ListThreads((uint32_t)pid, out) && out.size() == 4);
  CHECK(out.size() > 0 && out[0].tid == (uint32_t)pid);
  CHECK(platform::ListThreads(999999999u, out) && out.empty());
  KillChild(pid);
}

// Threads born while SuspendAll works are caught: when it returns, every thread is stopped,
// and no thread appears while held.
static void TestThreadStorm() {
  pid_t pid = SpawnChild(2, true);
  for (int round = 0; round < 10; ++round) {
    bool ok = platform::SuspendAll((platform::ProcessHandle)pid, (uint32_t)pid);
    CHECK(ok);
    if (!ok) { printf("  storm err: %s\n", platform::SuspendAllError().c_str()); break; }
    std::vector<pid_t> first = Tasks(pid);
    int stopped = CountState(pid, 't');
    usleep(20000);
    std::vector<pid_t> later = Tasks(pid);
    CHECK(stopped == (int)first.size());
    CHECK(later == first);
    platform::ResumeAll();
    CHECK(TracedCount(pid) == 0);
    usleep(5000);
  }
  KillChild(pid);
}

// The target dies after the first thread has been stopped: SuspendAll fails within its bound,
// holds nothing, and a later suspension works.
static pid_t g_victim = 0;
static void KillVictim(pid_t) {
  if (g_victim) kill(g_victim, SIGKILL);
  g_victim = 0;
}
static void TestTargetDiesMidSuspend() {
  pid_t pid = SpawnChild(8, false);
  g_victim = pid;
  linuxptrace::SetStopObserverForTest(KillVictim);
  auto t0 = Clock::now();
  bool ok = platform::SuspendAll((platform::ProcessHandle)pid, (uint32_t)pid);
  long ms = MsSince(t0);
  linuxptrace::SetStopObserverForTest(nullptr);
  CHECK(!ok);
  CHECK(ms < 3000);
  CHECK(!platform::SuspendAllError().empty());
  CHECK(ReapWithin(pid, 3000));  // fully reaped: no traced zombie threads keep it around
  CHECK(linuxptrace::OnTracer([] {
          linuxptrace::RetryDeferredDetaches();
          return linuxptrace::DeferredDetachCount();
        }) == 0);
  // Nothing is held: the next pair on a fresh process works.
  pid_t next = SpawnChild(1, false);
  CHECK(platform::SuspendAll((platform::ProcessHandle)next, (uint32_t)next));
  platform::ResumeAll();
  KillChild(next);
}

// Killed while held: ResumeAll returns promptly and the process can be reaped.
static void TestTargetDiesWhileHeld() {
  pid_t pid = SpawnChild(3, false);
  CHECK(platform::SuspendAll((platform::ProcessHandle)pid, (uint32_t)pid));
  kill(pid, SIGKILL);
  usleep(50000);
  auto t0 = Clock::now();
  platform::ResumeAll();
  CHECK(MsSince(t0) < 3000);
  CHECK(ReapWithin(pid, 3000));
  t0 = Clock::now();
  CHECK(!platform::SuspendAll((platform::ProcessHandle)pid, (uint32_t)pid));
  CHECK(MsSince(t0) < 3000);
}

// Another tracer holds a thread: SuspendAll fails fast with a reason, leaves nothing stopped.
static void TestAlreadyTraced() {
  pid_t pid = SpawnChild(2, false);
  pid_t tid = Tasks(pid)[1];
  int pp[2];
  CHECK(pipe(pp) == 0);
  pid_t tracer = fork();
  if (tracer == 0) {
    // Our sibling; as root (CAP_SYS_PTRACE) Yama does not object, otherwise skip.
    char ok = ptrace(PTRACE_SEIZE, tid, 0, 0) == 0 ? '1' : '0';
    if (write(pp[1], &ok, 1) != 1) _exit(1);
    pause();
    _exit(0);
  }
  char ok = 0;
  CHECK(read(pp[0], &ok, 1) == 1);
  close(pp[0]);
  close(pp[1]);
  if (ok == '1') {
    auto t0 = Clock::now();
    CHECK(!platform::SuspendAll((platform::ProcessHandle)pid, (uint32_t)pid));
    CHECK(MsSince(t0) < 3000);
    std::string err = platform::SuspendAllError();
    CHECK(err.find("already") != std::string::npos);
    CHECK(!linuxptrace::PtraceDenied(err));
    CHECK(CountState(pid, 't') == 0);
    KillChild(tracer);
    usleep(20000);
    CHECK(platform::SuspendAll((platform::ProcessHandle)pid, (uint32_t)pid));
    platform::ResumeAll();
  } else {
    puts("  (skipped already-traced: sibling ptrace not permitted here)");
    KillChild(tracer);
  }
  KillChild(pid);
}

int main() {
  TestRegsConversion();
  TestDeniedMessage();
  TestTracerThread();
  TestStopGuard();
  TestSuspendResume();
  TestListThreads();
  TestThreadStorm();
  TestTargetDiesMidSuspend();
  TestTargetDiesWhileHeld();
  TestAlreadyTraced();
  CHECK(!platform::SuspendAll((platform::ProcessHandle)getpid(), (uint32_t)getpid()));
  CHECK(platform::SuspendAllError().find("itself") != std::string::npos);

  // Shutting the tracer down (as at process exit) releases what is still held.
  pid_t held = SpawnChild(2, false);
  CHECK(platform::SuspendAll((platform::ProcessHandle)held, (uint32_t)held));
  CHECK(CountState(held, 't') == 3);
  linuxptrace::ShutdownTracer();
  CHECK(CountState(held, 't') == 0 && TracedCount(held) == 0);
  CHECK(!linuxptrace::OnTracer([] { return true; }));  // refuses once shut down
  CHECK(!platform::SuspendAll((platform::ProcessHandle)held, (uint32_t)held));
  KillChild(held);
  if (g_failures) {
    printf("ptrace_core_test: %d failure(s)\n", g_failures);
    return 1;
  }
  puts("ptrace_core_test OK");
  return 0;
}
