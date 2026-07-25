#include <stdio.h>
#include <windows.h>

int main(void) {
  DWORD pid = GetCurrentProcessId();
  printf("PID %lu\n", (unsigned long)pid);
  fflush(stdout);

  char line[256];
  while (fgets(line, sizeof(line), stdin)) {
    if (line[0] == 'q') break;
    printf("OK\n");
    fflush(stdout);
  }
  return 0;
}
