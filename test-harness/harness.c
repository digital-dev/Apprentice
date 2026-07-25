#include <stdio.h>
#include <windows.h>
#include <string.h>
#include <stdlib.h>

int g_health = 100;
int* g_health_ptr = &g_health; // pointer.test.ts resolves through this
float g_stamina = 100.0f; // scanner.test.ts float-path coverage

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
    } else if (strncmp(line, "get", 3) == 0) {
      printf("OK %d\n", *g_health_ptr);
    } else {
      printf("OK\n");
    }
    fflush(stdout);
  }
  return 0;
}
