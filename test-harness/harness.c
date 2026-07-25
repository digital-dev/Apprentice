#include <stdio.h>
#include <windows.h>
#include <string.h>
#include <stdlib.h>

int g_health = 100;
int* g_health_ptr = &g_health; // pointer.test.ts resolves through this

int main(void) {
  DWORD pid = GetCurrentProcessId();
  printf("PID %lu\n", (unsigned long)pid);
  fflush(stdout);

  char line[256];
  while (fgets(line, sizeof(line), stdin)) {
    if (line[0] == 'q') break;
    int val;
    if (sscanf(line, "set %d", &val) == 1) {
      *g_health_ptr = val;
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
