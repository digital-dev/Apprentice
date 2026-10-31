// Tests mono_call.cc's BuildCallStub and RunRemoteCall for BOTH ABIs
// (Task 13): byte-level golden vectors pinning the exact encoding, plus a
// live proof against a forked child that the generated stub actually
// marshals arguments into the right registers and captures the callee's
// RAX back out. Links the REAL mono_call.cc (not a copy of its logic) —
// compiling it standalone needs node-addon-api's and Node's own headers on
// the include path even though nothing here runs inside Node; the
// functions this file never calls (ResolveExport, CallRemoteFunction, the
// AsyncWorkers, ...) are dropped by the linker via --gc-sections rather
// than needing their napi_* symbols resolved. Build (run-tests.sh does):
//   g++ -std=c++17 -O0 -g -Wall -pthread -ffunction-sections -fdata-sections
//     -I<node-addon-api dir> -I<node headers dir> -Inative/src
//     -Inative/src/platform -ILinux/native
//     -o mono_call_stub_test mono_call_stub_test.cc ../../../native/src/mono_call.cc
//     ../tracer_thread.cc ../ptrace_core.cc ../remote_exec.cc
//     ../platform_linux_ptrace.cc ../platform_linux_remote.cc ../platform_linux.cc
//     ../platform_linux_process.cc ../platform_linux_memory.cc ../platform_linux_write.cc
//     -Wl,--gc-sections -ldl
#include "platform.h"
#include "mono_call.h"

#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static int g_failures = 0;
#define CHECK(cond)                                          \
  do {                                                       \
    if (!(cond)) {                                           \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                          \
    }                                                        \
  } while (0)

// ---------------------------------------------------------------------------
// Part 1: byte-level golden vectors for BuildCallStub, both ABIs.
//
// Independently hand-computed (not derived from reading mono_call.cc's own
// algorithm back out) for function=0x1122334455667788,
// resultAddress=0x99AABBCCDDEEFF11, with 0, 2 and 4 args — pins the exact
// encoding documented in the comment above BuildCallStub's definition.
// ---------------------------------------------------------------------------

static std::string ToHex(const std::vector<uint8_t>& v) {
  std::string out;
  char buf[3];
  for (uint8_t b : v) {
    snprintf(buf, sizeof(buf), "%02x", b);
    out += buf;
  }
  return out;
}

static void TestBuildCallStubBytes() {
  const uintptr_t function = 0x1122334455667788ULL;
  const uintptr_t resultAddr = 0x99AABBCCDDEEFF11ULL;
  const std::vector<uintptr_t> args0 = {};
  const std::vector<uintptr_t> args2 = {0x1111111111111111ULL, 0x2222222222222222ULL};
  const std::vector<uintptr_t> args4 = {0x1111111111111111ULL, 0x2222222222222222ULL,
                                         0x3333333333333333ULL, 0x4444444444444444ULL};

  // Ms64: unchanged from before Task 13 — mov rcx/rdx/r8/r9/rax, sub rsp
  // 0x28 (shadow space + alignment), call, add rsp 0x28, mov rcx
  // resultAddr, mov [rcx] rax, movq [rcx+8] xmm0, xor eax eax, ret.
  CHECK(ToHex(BuildCallStub(platform::Abi::Ms64, function, args0, resultAddr)) ==
        "48b9000000000000000048ba000000000000000049b8000000000000000049b900000000000000"
        "0048b888776655443322114883ec28ffd04883c42848b911ffeeddccbbaa99488901660fd641083"
        "1c0c3");
  CHECK(ToHex(BuildCallStub(platform::Abi::Ms64, function, args2, resultAddr)) ==
        "48b9111111111111111148ba222222222222222249b8000000000000000049b900000000000000"
        "0048b888776655443322114883ec28ffd04883c42848b911ffeeddccbbaa99488901660fd641083"
        "1c0c3");
  CHECK(ToHex(BuildCallStub(platform::Abi::Ms64, function, args4, resultAddr)) ==
        "48b9111111111111111148ba222222222222222249b8333333333333333349b944444444444444"
        "4448b888776655443322114883ec28ffd04883c42848b911ffeeddccbbaa99488901660fd641083"
        "1c0c3");

  // SysV (new in Task 13): mov rdi/rsi/rdx/rcx/rax, sub rsp 0x8 (alignment
  // only, no shadow space), call, add rsp 0x8, mov rdi resultAddr,
  // mov [rdi] rax, movq [rdi+8] xmm0, xor eax eax, ret. No `sub rsp,0x28`
  // appears anywhere.
  std::string sysv0 = ToHex(BuildCallStub(platform::Abi::SysV, function, args0, resultAddr));
  std::string sysv2 = ToHex(BuildCallStub(platform::Abi::SysV, function, args2, resultAddr));
  std::string sysv4 = ToHex(BuildCallStub(platform::Abi::SysV, function, args4, resultAddr));
  CHECK(sysv0 ==
        "48bf000000000000000048be000000000000000048ba000000000000000048b900000000000000"
        "0048b888776655443322114883ec08ffd04883c40848bf11ffeeddccbbaa99488907660fd647083"
        "1c0c3");
  CHECK(sysv2 ==
        "48bf111111111111111148be222222222222222248ba000000000000000048b900000000000000"
        "0048b888776655443322114883ec08ffd04883c40848bf11ffeeddccbbaa99488907660fd647083"
        "1c0c3");
  CHECK(sysv4 ==
        "48bf111111111111111148be222222222222222248ba333333333333333348b944444444444444"
        "4448b888776655443322114883ec08ffd04883c40848bf11ffeeddccbbaa99488907660fd647083"
        "1c0c3");
  CHECK(sysv0.find("4883ec28") == std::string::npos);  // no Ms64 shadow-space sub anywhere
  CHECK(sysv4.find("4883ec28") == std::string::npos);

  // Max 4 args: a 5th is simply never read by either variant (BuildCallStub
  // only ever looks at args[0..3]) — matches RunRemoteCall's own callers,
  // which all cap at 4 before this is ever reached (mono_call.cc's
  // CallRemoteFunction/CallRemoteFunctionFloat truncate the JS array at 4).
  std::vector<uintptr_t> args5 = args4;
  args5.push_back(0x5555555555555555ULL);
  CHECK(ToHex(BuildCallStub(platform::Abi::SysV, function, args5, resultAddr)) == sysv4);
}

// ---------------------------------------------------------------------------
// Part 2: live proof against a forked child — RunRemoteCall's real
// CreateRemoteThread thread-hijack entry, for both ABIs, with 0/2/4 args.
//
// Two tiny hand-written probe functions are mapped into the CHILD's own
// memory (PROT_EXEC anonymous pages, the same technique remote_exec_test.cc
// uses for its kStubCode): one reads its args the Ms64 way (rcx, rdx, r8,
// r9), the other the System V way (rdi, rsi, rdx, rcx) — both write
// whatever they received into a small output buffer (also the child's own
// memory) via r10, which neither ABI ever uses for an argument, so writing
// through it never corrupts an arg before it's captured. Each probe
// finishes with `mov eax, <its own sentinel>; ret`, so the test can also
// confirm RunRemoteCall's RAX capture (via `result`) independently of the
// argument-marshalling check.
//
// This proves BuildCallStub's SysV register choice is actually correct —
// not just that it compiles to the documented bytes — and separately that
// the Ms64 path still drives rcx/rdx/r8/r9 as before, using the SAME
// CreateRemoteThread hijack primitive Task 12 built: ptrace doesn't care
// what ABI the TARGET process's own binary follows, only which registers
// get set, so a Linux host process is a perfectly good target for proving
// either stub shape actually works.
// ---------------------------------------------------------------------------

// mov r10, 0 (placeholder, patched with the real output-buffer address
// before mmap) ; mov [r10], rcx ; mov [r10+8], rdx ; mov [r10+16], r8 ;
// mov [r10+24], r9 ; mov eax, 0xABCD1234 ; ret
static unsigned char kMs64Probe[] = {
    0x49, 0xBA, 0, 0, 0, 0, 0, 0, 0, 0,        // mov r10, imm64 (patched)
    0x49, 0x89, 0x0A,                          // mov [r10], rcx
    0x49, 0x89, 0x52, 0x08,                    // mov [r10+8], rdx
    0x4D, 0x89, 0x42, 0x10,                    // mov [r10+16], r8
    0x4D, 0x89, 0x4A, 0x18,                    // mov [r10+24], r9
    0xB8, 0x34, 0x12, 0xCD, 0xAB,              // mov eax, 0xABCD1234
    0xC3,                                      // ret
};
static constexpr int kMs64PatchOffset = 2;
static constexpr uint32_t kMs64Sentinel = 0xABCD1234u;

// Same shape, System V argument registers: mov r10, 0 (patched) ;
// mov [r10], rdi ; mov [r10+8], rsi ; mov [r10+16], rdx ; mov [r10+24], rcx ;
// mov eax, 0x11223344 ; ret
static unsigned char kSysVProbe[] = {
    0x49, 0xBA, 0, 0, 0, 0, 0, 0, 0, 0,        // mov r10, imm64 (patched)
    0x49, 0x89, 0x3A,                          // mov [r10], rdi
    0x49, 0x89, 0x72, 0x08,                    // mov [r10+8], rsi
    0x49, 0x89, 0x52, 0x10,                    // mov [r10+16], rdx
    0x49, 0x89, 0x4A, 0x18,                    // mov [r10+24], rcx
    0xB8, 0x44, 0x33, 0x22, 0x11,              // mov eax, 0x11223344
    0xC3,                                      // ret
};
static constexpr int kSysVPatchOffset = 2;
static constexpr uint32_t kSysVSentinel = 0x11223344u;

struct ProbeChildInfo {
  pid_t pid;
  uintptr_t ms64ProbeAddr;
  uintptr_t ms64OutAddr;
  uintptr_t sysvProbeAddr;
  uintptr_t sysvOutAddr;
};

static void ProbeChildBody(int infoPipe[2]) {
  close(infoPipe[0]);

  void* ms64Code = mmap(nullptr, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  void* sysvCode = mmap(nullptr, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  void* ms64Out = mmap(nullptr, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  void* sysvOut = mmap(nullptr, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

  memcpy(kMs64Probe + kMs64PatchOffset, &ms64Out, sizeof(ms64Out));
  memcpy(kSysVProbe + kSysVPatchOffset, &sysvOut, sizeof(sysvOut));
  memcpy(ms64Code, kMs64Probe, sizeof(kMs64Probe));
  memcpy(sysvCode, kSysVProbe, sizeof(kSysVProbe));

  ProbeChildInfo info{getpid(), (uintptr_t)ms64Code, (uintptr_t)ms64Out,
                       (uintptr_t)sysvCode, (uintptr_t)sysvOut};
  write(infoPipe[1], &info, sizeof(info));
  close(infoPipe[1]);

  for (;;) pause();
}

static ProbeChildInfo SpawnProbeChild() {
  int infoPipe[2];
  if (pipe(infoPipe) != 0) { perror("pipe"); exit(1); }
  pid_t pid = fork();
  if (pid == 0) ProbeChildBody(infoPipe);
  close(infoPipe[1]);
  ProbeChildInfo info{};
  read(infoPipe[0], &info, sizeof(info));
  close(infoPipe[0]);
  return info;
}

static void KillChild(pid_t pid) {
  kill(pid, SIGKILL);
  int st;
  waitpid(pid, &st, 0);
}

// Calls `probeAddr` through RunRemoteCall with 0, 2 and 4 args, checking
// after each call that `outAddr` holds exactly the args supplied (zero for
// any slot beyond what was passed — BuildCallStub zero-fills unused slots)
// and that RunRemoteCall's own `result` captured the probe's RAX sentinel.
static void CheckMarshalling(platform::ProcessHandle h, platform::Abi abi, uintptr_t probeAddr,
                              uintptr_t outAddr, uint32_t sentinel, uintptr_t argBase) {
  for (int n : {0, 2, 4}) {
    uint64_t zero[4] = {0, 0, 0, 0};
    CHECK(platform::WriteMemory(h, outAddr, zero, sizeof(zero)));

    std::vector<uintptr_t> args;
    for (int i = 0; i < n; i++) args.push_back(argBase + (uintptr_t)(i + 1) * 0x1000);

    uint8_t result[8] = {0};
    CHECK(RunRemoteCall(h, abi, probeAddr, args, result));

    uint64_t slots[4] = {0};
    CHECK(platform::ReadMemory(h, outAddr, slots, sizeof(slots)));
    for (int i = 0; i < 4; i++) {
      uintptr_t expected = (i < n) ? args[i] : 0;
      CHECK(slots[i] == expected);
    }

    uint32_t raxLow = 0;
    memcpy(&raxLow, result, sizeof(raxLow));
    CHECK(raxLow == sentinel);
  }
}

static void TestRunRemoteCallBothAbis() {
  ProbeChildInfo c = SpawnProbeChild();
  platform::ProcessHandle h = (platform::ProcessHandle)c.pid;

  CheckMarshalling(h, platform::Abi::Ms64, c.ms64ProbeAddr, c.ms64OutAddr, kMs64Sentinel,
                    0xA0000000ULL);
  CheckMarshalling(h, platform::Abi::SysV, c.sysvProbeAddr, c.sysvOutAddr, kSysVSentinel,
                    0xB0000000ULL);

  KillChild(c.pid);
}

int main() {
  TestBuildCallStubBytes();
  TestRunRemoteCallBothAbis();
  if (g_failures) {
    printf("mono_call_stub_test: %d failure(s)\n", g_failures);
    return 1;
  }
  puts("mono_call_stub_test OK");
  return 0;
}
