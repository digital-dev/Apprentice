#include <stdio.h>
#include <windows.h>
#include <string.h>
#include <stdlib.h>
#include <process.h>

int g_health = 100;
int* g_health_ptr = &g_health; // pointer.test.ts resolves through this
float g_stamina = 100.0f; // scanner.test.ts float-path coverage
volatile int g_drain_count = 1000000; // patch_ops.test.ts drains and NOPs this

// Mimics a real object layout: the field we care about sits at a nonzero
// offset inside a struct, and only the struct's base address is pointed
// to. pointer.test.ts uses this to verify the field-offset-tolerant chain
// search, since exact-value pointer matching would never find this case.
typedef struct {
  int padding[4]; // pushes stamina to a nonzero byte offset
  float stamina;
} PlayerComponent;

PlayerComponent g_player = { { 0, 0, 0, 0 }, 77.0f }; // distinct value, avoids colliding with g_stamina's scan target
PlayerComponent* g_player_ptr = &g_player;

static volatile int g_watch_running = 0;

static volatile int g_drain_running = 0;

// The instruction under test for code patching. Non-inlined and taking the
// counter as a runtime pointer argument, so the compiler emits a real
// memory read-modify-write through a general-purpose register (e.g.
// `sub dword ptr [rcx], 1`) — the same shape as a game's stamina-drain
// store, and something an AOB signature can match. A RIP-relative store to
// a known global would not exercise the register-based path.
#pragma optimize("", off)
static void drain_step(volatile int* counter) {
  *counter -= 1;
}
#pragma optimize("", on)

// Non-inlined, takes the pointer as a runtime argument so the store is
// `mov [reg+disp], xmm` (base register = the object pointer), matching a
// real game object write — not a RIP-relative store to a known global.
#pragma optimize("", off)
static void write_stamina(PlayerComponent* p, float v) {
  p->stamina = v;
}
#pragma optimize("", off)
static unsigned __stdcall watch_thread(void* arg) {
  (void)arg;
  float v = 0.0f;
  while (g_watch_running) {
    write_stamina(g_player_ptr, v);
    v += 1.0f;
    Sleep(10);
  }
  return 0;
}

static unsigned __stdcall drain_thread(void* arg) {
  (void)arg;
  while (g_drain_running) {
    drain_step(&g_drain_count);
    Sleep(1);
  }
  return 0;
}
#pragma optimize("", on)

int main(void) {
  DWORD pid = GetCurrentProcessId();
  printf("PID %lu\n", (unsigned long)pid);
  fflush(stdout);

  char line[256];
  while (fgets(line, sizeof(line), stdin)) {
    if (line[0] == 'q') break;
    int val;
    float fval;
    if (sscanf(line, "set %d", &val) == 1) {
      *g_health_ptr = val;
      printf("OK\n");
    } else if (sscanf(line, "setf %f", &fval) == 1) {
      g_stamina = fval;
      printf("OK\n");
    } else if (sscanf(line, "setp %f", &fval) == 1) {
      g_player_ptr->stamina = fval; // lets pointer.test.ts narrow to this exact field
      printf("OK\n");
    } else if (sscanf(line, "setcount %d", &val) == 1) {
      g_drain_count = val; // lets the test narrow the scan to this exact global
      printf("OK\n");
    } else if (strncmp(line, "getcount", 8) == 0) {
      printf("OK %d\n", g_drain_count);
    } else if (strncmp(line, "drainloop", 9) == 0) {
      if (!g_drain_running) {
        g_drain_running = 1;
        _beginthreadex(NULL, 0, drain_thread, NULL, 0, NULL);
      }
      printf("OK\n");
    } else if (strncmp(line, "stopdrain", 9) == 0) {
      g_drain_running = 0;
      printf("OK\n");
    } else if (strncmp(line, "get", 3) == 0) {
      printf("OK %d\n", *g_health_ptr);
    } else if (strncmp(line, "watchloop", 9) == 0) {
      if (!g_watch_running) {
        g_watch_running = 1;
        _beginthreadex(NULL, 0, watch_thread, NULL, 0, NULL);
      }
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
