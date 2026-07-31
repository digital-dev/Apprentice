#include <stdio.h>
#include <windows.h>
#include <string.h>
#include <stdlib.h>
#include <process.h>
#include <xmmintrin.h>

int g_health = 100;
int* g_health_ptr = &g_health; // pointer.test.ts resolves through this
float g_stamina = 100.0f; // scanner.test.ts float-path coverage
volatile int g_drain_count = 1000000; // patch_ops.test.ts drains and NOPs this

// Mimics a real object layout: the field we care about sits at a nonzero
// offset inside a struct, and only the struct's base address is pointed
// to. pointer.test.ts uses this to verify the field-offset-tolerant chain
// search, since exact-value pointer matching would never find this case.
// `shieldPad`/`shield` occupy the same 16 bytes the original `padding[4]`
// did (offsets 0-15); `stamina` is unchanged at offset 16, so pointer.test.ts's
// offset-16 assumption and every other consumer of this layout still holds.
// `shield` sits at offset 4 — inside the 16-byte block a wide SSE store
// below writes, but not at that store's start — so a watch on it exercises
// the covering-write match (effectiveAddress < watched) rather than the
// exact-match case stamina already covers.
typedef struct {
  float shieldPad;  // offset 0 - unused, just fills the rest of the wide store
  float shield;     // offset 4 - watched by write_watch.test.ts's covering-write case
  int padding[2];   // offset 8..15 - unused, keeps the struct's size/layout unchanged
  float stamina;    // offset 16
} PlayerComponent;

PlayerComponent g_player = { 0.0f, 55.0f, { 0, 0 }, 77.0f }; // distinct values, avoid colliding with other scan targets
PlayerComponent* g_player_ptr = &g_player;

float g_force_value = 10.0f; // cave_ops.test.ts forces a constant into this
static volatile int g_force_running = 0;

// cave_ops.test.ts's decodeRun regression: a store with zero trailing slack
// before its function's own `ret`, deliberately kept bare (unlike
// force_write's padded version above) so there's a real, live instance of
// the "displaced run must fold in the ret" hazard for decodeRun to refuse.
float g_tight_value = 20.0f;
static volatile int g_tight_running = 0;

// write_watch.test.ts's decode-ranking regressions: a dedicated field whose
// captured write site gets deliberately redirected into hand-crafted cave
// code, so the test can construct exact adversarial byte patterns (a
// coincidental short suffix decode, and a coincidental prefix-extended
// decode) without depending on whatever registers/bytes the compiler
// happens to pick.
float g_probe_value = 30.0f;
static volatile int g_probe_running = 0;

static volatile int g_watch_running = 0;

static volatile int g_drain_running = 0;
static volatile int g_wide_running = 0;
static volatile int g_shield_running = 0;

static HMODULE g_probe_dll = NULL;
static void (*g_probe_write)(float*, float) = NULL;
static float g_probe_target = 5.0f;

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

// Writes the whole component in one wide store rather than touching the
// field directly, the way a compiler emits a value-type/struct copy. The
// effective address is the START of the block, so the watched field sits
// at an offset INSIDE the access — the case that used to be discarded as
// undecodable, and the reason a real game's drain instruction could never
// be caught while its regen instruction could.
#pragma optimize("", off)
static void wide_write(PlayerComponent* p, PlayerComponent v) {
  *p = v;
}
static unsigned __stdcall wide_thread(void* arg) {
  (void)arg;
  float f = 0.0f;
  while (g_wide_running) {
    PlayerComponent v = { 1.0f, 2.0f, { 3, 4 }, f };
    wide_write(g_player_ptr, v);
    f += 1.0f;
    Sleep(10);
  }
  return 0;
}
#pragma optimize("", on)

// Writes all 4 leading floats of PlayerComponent (shieldPad, shield, and the
// two padding ints reinterpreted as float bit patterns) in a single 16-byte
// SSE store: `movups [reg], xmm`. Unlike wide_write's struct-copy block move,
// this is a single non-string instruction with a static effective address
// (the struct base) — the shape the covering-write relaxation in
// FindWriteInstruction was actually written for: `shield` at offset 4 falls
// inside the store's [base, base+16) range without being at its start, so
// this covers-but-doesn't-start-at-the-watched-address, and (unlike
// wide_write) the instruction's own destination register never advances, so
// it stays attributable at the trap.
#pragma optimize("", off)
static void shield_write(PlayerComponent* p, float a, float b, float c, float d) {
  float vals[4] = { a, b, c, d };
  __m128 v = _mm_loadu_ps(vals);
  _mm_storeu_ps((float*)p, v);
}
static unsigned __stdcall shield_thread(void* arg) {
  (void)arg;
  float f = 0.0f;
  while (g_shield_running) {
    shield_write(g_player_ptr, 0.0f, f, 0.0f, 0.0f);
    f += 1.0f;
    Sleep(10);
  }
  return 0;
}
#pragma optimize("", on)

// Writes through a runtime pointer argument so the store is
// `movss [reg+disp], xmm` — the shape a real game object write has, and
// the shape an injection displaces. A RIP-relative store to a known
// global would be refused by decodeRun and could never be injected.
//
// `sink` exists purely to give the displaceable run somewhere safe to
// extend into. A bare `*p = v;` compiles (under /Od) to a 4-byte
// `movss [reg], xmm` sitting immediately against this function's `ret`,
// with zero trailing slack. A 5-byte `jmp rel32` redirect needs 5 whole
// bytes at the site, so with nothing else there `decodeRun` has no choice
// but to fold the `ret` itself into the displaced run — and a `ret` inside
// a run ends the function the instant the cave replays it, before the
// injected effect or jump-back ever runs. `sink` is a different stack
// address than `*p`, so writing it never re-triggers the watched-address
// breakpoint and never re-clobbers the forced value; it only gives the run
// a second whole, harmless, position-independent instruction to extend
// into instead of the `ret` — matching how real target functions almost
// always have more code after the interesting write.
#pragma optimize("", off)
static void force_write(float* p, float v) {
  *p = v;
  volatile float sink = v;
  (void)sink;
}
static unsigned __stdcall force_thread(void* arg) {
  (void)arg;
  float v = 0.0f;
  while (g_force_running) {
    force_write(&g_force_value, v);
    v += 1.0f;
    Sleep(10);
  }
  return 0;
}
#pragma optimize("", on)

// Deliberately bare — no padding after the store, unlike force_write above.
// `*p = v;` alone compiles (under /Od) to a 4-byte `movss [reg], xmm`
// immediately against this function's `ret`, so a run asked to cover 5
// bytes (the size of a `jmp rel32` redirect) has nothing to extend into
// except that `ret`. decodeRun must refuse this (`relocatable: false`),
// not report it installable.
#pragma optimize("", off)
static void tight_write(float* p, float v) {
  *p = v;
}
static unsigned __stdcall tight_thread(void* arg) {
  (void)arg;
  float v = 0.0f;
  while (g_tight_running) {
    tight_write(&g_tight_value, v);
    v += 1.0f;
    Sleep(10);
  }
  return 0;
}
#pragma optimize("", on)

// Written through a runtime pointer argument for the same reason as
// force_write/tight_write above (a real `movss [reg], xmm` store, not a
// RIP-relative one) — used only as a capture target whose site gets
// redirected into hand-built cave code by write_watch.test.ts's decode-
// ranking regressions, never for the value-forcing pipeline itself.
#pragma optimize("", off)
static void probe_write(float* p, float v) {
  *p = v;
}
static unsigned __stdcall probe_thread(void* arg) {
  (void)arg;
  float v = 0.0f;
  while (g_probe_running) {
    probe_write(&g_probe_value, v);
    v += 1.0f;
    Sleep(10);
  }
  return 0;
}
#pragma optimize("", on)

#pragma optimize("", off)
static unsigned __stdcall drain_thread(void* arg) {
  (void)arg;
  while (g_drain_running) {
    drain_step(&g_drain_count);
    Sleep(1);
  }
  return 0;
}
#pragma optimize("", on)

// Matches LPTHREAD_START_ROUTINE's exact ABI (one pointer arg, arriving in
// RCX per the Windows x64 convention) so CreateRemoteThread can start a
// thread here directly, with no stub needed — this proves the raw
// mechanism works before Task 3 builds a stub for functions that need
// MORE than one argument.
__declspec(dllexport) unsigned long __stdcall RemoteThreadProbe(void* param) {
  *(int*)param = 0x1337;
  return 0;
}

int main(void) {
  DWORD pid = GetCurrentProcessId();
  printf("PID %lu\n", (unsigned long)pid);
  fflush(stdout);

  char line[256];
  while (fgets(line, sizeof(line), stdin)) {
    if (line[0] == 'q') break;
    int val;
    float fval;
    if (strncmp(line, "loaddll2", 8) == 0) {
      if (g_probe_dll == NULL) g_probe_dll = LoadLibraryA("test-harness\\probe2.dll");
      if (g_probe_dll == NULL) printf("ERR\n");
      else printf("OK 0x%llx\n", (unsigned long long)(uintptr_t)g_probe_dll);
    } else if (strncmp(line, "loaddll", 7) == 0) {
      if (g_probe_dll == NULL) g_probe_dll = LoadLibraryA("test-harness\\probe.dll");
      if (g_probe_dll == NULL) {
        printf("ERR\n");
      } else {
        g_probe_write = (void (*)(float*, float))GetProcAddress(g_probe_dll, "probe_write");
        printf("OK 0x%llx\n", (unsigned long long)(uintptr_t)g_probe_dll);
      }
    } else if (strncmp(line, "unloaddll", 9) == 0) {
      if (g_probe_dll != NULL) { FreeLibrary(g_probe_dll); g_probe_dll = NULL; g_probe_write = NULL; }
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
      g_player_ptr->stamina = fval; // lets pointer.test.ts narrow to this exact field
      printf("OK\n");
    } else if (sscanf(line, "setshield %f", &fval) == 1) {
      g_player_ptr->shield = fval; // lets write_watch.test.ts narrow the scan to this exact field
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
    } else if (strncmp(line, "wideloop", 8) == 0) {
      if (!g_wide_running) {
        g_wide_running = 1;
        _beginthreadex(NULL, 0, wide_thread, NULL, 0, NULL);
      }
      printf("OK\n");
    } else if (strncmp(line, "stopwide", 8) == 0) {
      g_wide_running = 0;
      printf("OK\n");
    } else if (strncmp(line, "shieldloop", 10) == 0) {
      if (!g_shield_running) {
        g_shield_running = 1;
        _beginthreadex(NULL, 0, shield_thread, NULL, 0, NULL);
      }
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
      if (!g_force_running) {
        g_force_running = 1;
        _beginthreadex(NULL, 0, force_thread, NULL, 0, NULL);
      }
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
      if (!g_tight_running) {
        g_tight_running = 1;
        _beginthreadex(NULL, 0, tight_thread, NULL, 0, NULL);
      }
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
      if (!g_probe_running) {
        g_probe_running = 1;
        _beginthreadex(NULL, 0, probe_thread, NULL, 0, NULL);
      }
      printf("OK\n");
    } else if (strncmp(line, "stopprobe", 9) == 0) {
      g_probe_running = 0;
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
