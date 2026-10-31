// Linux (ELF) counterpart of test-harness/harness.c: same stdin/stdout
// protocol, same globals and loop functions, so tests/native/*.test.ts can
// drive either through tests/helpers/spawnHarness.ts.
//
// Differences from the Windows harness (all documented, none silent):
//   * mmap/mprotect replace VirtualAlloc/VirtualProtect; pthreads replace
//     _beginthreadex; usleep replaces Sleep.
//   * loadmono/loaddll/loaddll2 expect probe_mono.so/probe.so/probe2.so,
//     which are not built here yet (the Windows probes are PE DLLs). Without
//     the .so the command answers ERR, the same answer the Windows harness
//     gives when its DLL is missing. unloaddll/unloadmono/probewrite stay
//     valid no-ops.
//   * RemoteThreadProbe/RemoteCallProbe2 are exported (build uses -rdynamic)
//     with the SysV ABI; no __stdcall on Linux.
// Build: gcc -O0 -g -pthread -rdynamic -o harness harness.c -ldl
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#if defined(__x86_64__) || defined(__i386__)
#include <xmmintrin.h>
#endif

#define NOINLINE __attribute__((noinline, optimize("O0")))

int g_health = 100;
int* g_health_ptr = &g_health;
float g_stamina = 100.0f;
short g_int16 = 12345;
unsigned char g_int8 = 42;
long long g_int64 = 123456789012345LL;
double g_double = 123.456;
volatile int g_drain_count = 1000000;

// Same layout as the Windows harness: shield at offset 4, stamina at 16.
typedef struct {
  float shieldPad;
  float shield;
  int padding[2];
  float stamina;
} PlayerComponent;

PlayerComponent g_player = { 0.0f, 55.0f, { 0, 0 }, 77.0f };
PlayerComponent* g_player_ptr = &g_player;

float g_force_value = 10.0f;
float g_tight_value = 20.0f;
float g_probe_value = 30.0f;
float g_negdisp_value = 44.0f;

static volatile int g_force_running = 0;
static volatile int g_tight_running = 0;
static volatile int g_probe_running = 0;
static volatile int g_negdisp_running = 0;
static volatile int g_watch_running = 0;
static volatile int g_drain_running = 0;
static volatile int g_wide_running = 0;
static volatile int g_shield_running = 0;

// Chunk-boundary regression support: one 8 MiB region, markers straddling /
// placed relative to the 4 MiB chunk boundary (see the Windows harness).
#define BIG_REGION_SIZE (8u * 1024u * 1024u)
#define BIG_CHUNK_SIZE  (4u * 1024u * 1024u)
#define BIG_I64_OFFSET  (BIG_CHUNK_SIZE - 4u)
#define BIG_I32_OFFSET  (BIG_CHUNK_SIZE + 0x1000u)
#define BIG_SIG_OFFSET  (BIG_CHUNK_SIZE - 8u)
static const long long BIG_I64_VALUE = 1122334455667788LL;
static const int BIG_I32_VALUE = 24681357;
static const unsigned char BIG_SIG_BYTES[16] = {
  0x48, 0x8b, 0x05, 0x11, 0x22, 0x33, 0x44, 0x0f,
  0x1e, 0xfa, 0x5a, 0xa5, 0x7e, 0xe7, 0x13, 0x31
};
static void* g_big_data = NULL;
static void* g_big_code = NULL;

static void* g_probe_dll = NULL;
static void (*g_probe_write)(float*, float) = NULL;
static float g_probe_target = 5.0f;

static void sleep_ms(unsigned ms) { usleep(ms * 1000u); }

// Non-inlined, runtime-pointer stores so each is a real register-based
// memory write, as in the Windows harness (-O0 instead of #pragma optimize).
static NOINLINE void drain_step(volatile int* counter) { *counter -= 1; }
static NOINLINE void write_stamina(PlayerComponent* p, float v) { p->stamina = v; }
static NOINLINE void wide_write(PlayerComponent* p, PlayerComponent v) { *p = v; }
static NOINLINE void shield_write(PlayerComponent* p, float a, float b, float c, float d) {
  float vals[4] = { a, b, c, d };
#if defined(__x86_64__) || defined(__i386__)
  __m128 v = _mm_loadu_ps(vals);
  _mm_storeu_ps((float*)p, v);
#else
  memcpy(p, vals, sizeof(vals));
#endif
}
static NOINLINE void force_write(float* p, float v) {
  *p = v;
  volatile float sink = v;
  (void)sink;
}
// Deliberately bare: no slack after the store (see the Windows harness).
static NOINLINE void tight_write(float* p, float v) { *p = v; }
static NOINLINE void probe_write(float* p, float v) { *p = v; }
static NOINLINE void write_negdisp(float* end, float v) { *(end - 1) = v; }
static NOINLINE void* resolve_attacker(void* hit) {
  volatile float scratch = 7.0f;
  scratch = scratch * 3.0f - 1.0f;
  (void)scratch;
  return hit;
}

static void* watch_thread(void* arg) {
  (void)arg;
  float v = 0.0f;
  while (g_watch_running) { write_stamina(g_player_ptr, v); v += 1.0f; sleep_ms(10); }
  return NULL;
}
static void* wide_thread(void* arg) {
  (void)arg;
  float f = 0.0f;
  while (g_wide_running) {
    PlayerComponent v = { 1.0f, 2.0f, { 3, 4 }, f };
    wide_write(g_player_ptr, v);
    f += 1.0f;
    sleep_ms(10);
  }
  return NULL;
}
static void* shield_thread(void* arg) {
  (void)arg;
  float f = 0.0f;
  while (g_shield_running) { shield_write(g_player_ptr, 0.0f, f, 0.0f, 0.0f); f += 1.0f; sleep_ms(10); }
  return NULL;
}
static void* force_thread(void* arg) {
  (void)arg;
  float v = 0.0f;
  while (g_force_running) { force_write(&g_force_value, v); v += 1.0f; sleep_ms(10); }
  return NULL;
}
static void* tight_thread(void* arg) {
  (void)arg;
  float v = 0.0f;
  while (g_tight_running) { tight_write(&g_tight_value, v); v += 1.0f; sleep_ms(10); }
  return NULL;
}
static void* probe_thread(void* arg) {
  (void)arg;
  float v = 0.0f;
  while (g_probe_running) { probe_write(&g_probe_value, v); v += 1.0f; sleep_ms(10); }
  return NULL;
}
static void* negdisp_thread(void* arg) {
  (void)arg;
  float v = 0.0f;
  while (g_negdisp_running) { write_negdisp(&g_negdisp_value + 1, v); v += 1.0f; sleep_ms(10); }
  return NULL;
}
static void* drain_thread(void* arg) {
  (void)arg;
  while (g_drain_running) { drain_step(&g_drain_count); sleep_ms(1); }
  return NULL;
}

static void start_thread(void* (*fn)(void*)) {
  pthread_t t;
  if (pthread_create(&t, NULL, fn, NULL) == 0) pthread_detach(t);
}

// Exported (-rdynamic) remote-call targets; SysV ABI.
__attribute__((visibility("default"))) unsigned long RemoteThreadProbe(void* param) {
  *(int*)param = 0x1337;
  return 0;
}
__attribute__((visibility("default"))) void RemoteCallProbe2(int* target, int value) {
  *target = value;
}

static void* map_big(int prot) {
  void* p = mmap(NULL, BIG_REGION_SIZE, prot, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  return p == MAP_FAILED ? NULL : p;
}

int main(void) {
  printf("PID %d\n", (int)getpid());
  fflush(stdout);

  char line[256];
  while (fgets(line, sizeof(line), stdin)) {
    if (line[0] == 'q') break;
    int val;
    float fval;
    short val16;
    unsigned char val8;
    long long val64;
    double dval;
    if (strncmp(line, "bigallocfree", 12) == 0) {
      if (g_big_data != NULL) { munmap(g_big_data, BIG_REGION_SIZE); g_big_data = NULL; }
      printf("OK\n");
    } else if (strncmp(line, "bigalloc", 8) == 0) {
      if (g_big_data == NULL) {
        g_big_data = map_big(PROT_READ | PROT_WRITE);
        if (g_big_data != NULL) {
          memset(g_big_data, 0, BIG_REGION_SIZE);
          memcpy((char*)g_big_data + BIG_I64_OFFSET, &BIG_I64_VALUE, sizeof(BIG_I64_VALUE));
          memcpy((char*)g_big_data + BIG_I32_OFFSET, &BIG_I32_VALUE, sizeof(BIG_I32_VALUE));
        }
      }
      if (g_big_data == NULL) printf("ERR\n");
      else printf("OK 0x%llx\n", (unsigned long long)(uintptr_t)g_big_data);
    } else if (strncmp(line, "bigcodefree", 11) == 0) {
      if (g_big_code != NULL) { munmap(g_big_code, BIG_REGION_SIZE); g_big_code = NULL; }
      printf("OK\n");
    } else if (strncmp(line, "bigcode", 7) == 0) {
      if (g_big_code == NULL) {
        g_big_code = map_big(PROT_READ | PROT_WRITE | PROT_EXEC);
        if (g_big_code != NULL) {
          memset(g_big_code, 0xCC, BIG_REGION_SIZE);
          memcpy((char*)g_big_code + BIG_SIG_OFFSET, BIG_SIG_BYTES, sizeof(BIG_SIG_BYTES));
          // r-x keeps the whole 8 MiB one uniform mapping, like PAGE_EXECUTE_READ.
          mprotect(g_big_code, BIG_REGION_SIZE, PROT_READ | PROT_EXEC);
        }
      }
      if (g_big_code == NULL) printf("ERR\n");
      else printf("OK 0x%llx\n", (unsigned long long)(uintptr_t)g_big_code);
    } else if (strncmp(line, "loadmono", 8) == 0) {
      void* m = dlopen("Linux/test-harness/probe_mono.so", RTLD_NOW);
      if (m == NULL) printf("ERR\n");
      else printf("OK 0x%llx\n", (unsigned long long)(uintptr_t)m);
    } else if (strncmp(line, "unloadmono", 10) == 0) {
      printf("OK\n");
    } else if (strncmp(line, "loaddll2", 8) == 0) {
      if (g_probe_dll == NULL) g_probe_dll = dlopen("Linux/test-harness/probe2.so", RTLD_NOW);
      if (g_probe_dll == NULL) printf("ERR\n");
      else printf("OK 0x%llx\n", (unsigned long long)(uintptr_t)g_probe_dll);
    } else if (strncmp(line, "loaddll", 7) == 0) {
      if (g_probe_dll == NULL) g_probe_dll = dlopen("Linux/test-harness/probe.so", RTLD_NOW);
      if (g_probe_dll == NULL) {
        printf("ERR\n");
      } else {
        g_probe_write = (void (*)(float*, float))dlsym(g_probe_dll, "probe_write");
        printf("OK 0x%llx\n", (unsigned long long)(uintptr_t)g_probe_dll);
      }
    } else if (strncmp(line, "unloaddll", 9) == 0) {
      if (g_probe_dll != NULL) { dlclose(g_probe_dll); g_probe_dll = NULL; g_probe_write = NULL; }
      printf("OK\n");
    } else if (strncmp(line, "probewrite", 10) == 0) {
      if (g_probe_write != NULL) g_probe_write(&g_probe_target, 42.0f);
      printf("OK\n");
    } else if (strncmp(line, "probeget", 8) == 0) {
      printf("OK %f\n", g_probe_target);
    } else if (sscanf(line, "set %d", &val) == 1) {
      *g_health_ptr = val;
      printf("OK\n");
    } else if (sscanf(line, "setf %f", &fval) == 1) {
      g_stamina = fval;
      printf("OK\n");
    } else if (sscanf(line, "setp %f", &fval) == 1) {
      g_player_ptr->stamina = fval;
      printf("OK\n");
    } else if (sscanf(line, "seti16 %hd", &val16) == 1) {
      g_int16 = val16;
      printf("OK\n");
    } else if (strncmp(line, "geti16", 6) == 0) {
      printf("OK %d\n", g_int16);
    } else if (sscanf(line, "seti8 %hhu", &val8) == 1) {
      g_int8 = val8;
      printf("OK\n");
    } else if (strncmp(line, "geti8", 5) == 0) {
      printf("OK %d\n", g_int8);
    } else if (sscanf(line, "seti64 %lld", &val64) == 1) {
      g_int64 = val64;
      printf("OK\n");
    } else if (strncmp(line, "geti64", 6) == 0) {
      printf("OK %lld\n", g_int64);
    } else if (sscanf(line, "setd %lf", &dval) == 1) {
      g_double = dval;
      printf("OK\n");
    } else if (strncmp(line, "getd", 4) == 0) {
      printf("OK %f\n", g_double);
    } else if (sscanf(line, "setshield %f", &fval) == 1) {
      g_player_ptr->shield = fval;
      printf("OK\n");
    } else if (sscanf(line, "setcount %d", &val) == 1) {
      g_drain_count = val;
      printf("OK\n");
    } else if (strncmp(line, "getcount", 8) == 0) {
      printf("OK %d\n", g_drain_count);
    } else if (strncmp(line, "drainloop", 9) == 0) {
      if (!g_drain_running) { g_drain_running = 1; start_thread(drain_thread); }
      printf("OK\n");
    } else if (strncmp(line, "wideloop", 8) == 0) {
      if (!g_wide_running) { g_wide_running = 1; start_thread(wide_thread); }
      printf("OK\n");
    } else if (strncmp(line, "stopwide", 8) == 0) {
      g_wide_running = 0;
      printf("OK\n");
    } else if (strncmp(line, "shieldloop", 10) == 0) {
      if (!g_shield_running) { g_shield_running = 1; start_thread(shield_thread); }
      printf("OK\n");
    } else if (strncmp(line, "stopshield", 10) == 0) {
      g_shield_running = 0;
      printf("OK\n");
    } else if (strncmp(line, "stopdrain", 9) == 0) {
      g_drain_running = 0;
      printf("OK\n");
    } else if (sscanf(line, "setforce %f", &fval) == 1) {
      g_force_value = fval;
      printf("OK\n");
    } else if (strncmp(line, "getforce", 8) == 0) {
      printf("OK %f\n", g_force_value);
    } else if (strncmp(line, "forceloop", 9) == 0) {
      if (!g_force_running) { g_force_running = 1; start_thread(force_thread); }
      printf("OK\n");
    } else if (strncmp(line, "stopforce", 9) == 0) {
      g_force_running = 0;
      printf("OK\n");
    } else if (sscanf(line, "settight %f", &fval) == 1) {
      g_tight_value = fval;
      printf("OK\n");
    } else if (strncmp(line, "gettight", 8) == 0) {
      printf("OK %f\n", g_tight_value);
    } else if (strncmp(line, "tightloop", 9) == 0) {
      if (!g_tight_running) { g_tight_running = 1; start_thread(tight_thread); }
      printf("OK\n");
    } else if (strncmp(line, "stoptight", 9) == 0) {
      g_tight_running = 0;
      printf("OK\n");
    } else if (sscanf(line, "setprobe %f", &fval) == 1) {
      g_probe_value = fval;
      printf("OK\n");
    } else if (strncmp(line, "getprobe", 8) == 0) {
      printf("OK %f\n", g_probe_value);
    } else if (strncmp(line, "probeloop", 9) == 0) {
      if (!g_probe_running) { g_probe_running = 1; start_thread(probe_thread); }
      printf("OK\n");
    } else if (strncmp(line, "stopprobe", 9) == 0) {
      g_probe_running = 0;
      printf("OK\n");
    } else if (strncmp(line, "getresolveattackeraddr", 22) == 0) {
      printf("OK 0x%llx\n", (unsigned long long)(uintptr_t)&resolve_attacker);
    } else if (sscanf(line, "setnegdisp %f", &fval) == 1) {
      g_negdisp_value = fval;
      printf("OK\n");
    } else if (strncmp(line, "getnegdisp", 10) == 0) {
      printf("OK %f\n", g_negdisp_value);
    } else if (strncmp(line, "negdisploop", 11) == 0) {
      if (!g_negdisp_running) { g_negdisp_running = 1; start_thread(negdisp_thread); }
      printf("OK\n");
    } else if (strncmp(line, "stopnegdisp", 11) == 0) {
      g_negdisp_running = 0;
      printf("OK\n");
    } else if (strncmp(line, "get", 3) == 0) {
      printf("OK %d\n", *g_health_ptr);
    } else if (strncmp(line, "watchloop", 9) == 0) {
      if (!g_watch_running) { g_watch_running = 1; start_thread(watch_thread); }
      printf("OK\n");
    } else if (strncmp(line, "stoploop", 8) == 0) {
      g_watch_running = 0;
      printf("OK\n");
    } else {
      printf("OK\n");
    }
    fflush(stdout);
  }
  return 0;
}
