#include <stdio.h>
#include <windows.h>
#include <string.h>
#include <stdlib.h>

int g_health = 100;
int* g_health_ptr = &g_health; // pointer.test.ts resolves through this
float g_stamina = 100.0f; // scanner.test.ts float-path coverage

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
