/* ELF fixture for module_parse_test: built by Linux/scripts/run-tests.sh with
 * gcc -shared -fPIC three ways (--hash-style=gnu, sysv, both) so the test
 * exercises every symbol-count path of ParseElfDynsym. Not checked in as a
 * binary; the test compares against dlsym of the real build. */
int fx_counter = 7;
int fx_data[16];
const char fx_name[] = "fixture";
__attribute__((weak)) int fx_weak = 3;
__attribute__((noinline)) int fx_add(int a, int b) { return a + b; }
__attribute__((visibility("hidden"))) int fx_hidden(void) { return 1; }
static int fx_static(void) { return 2; }
extern int fx_undefined_import(void);
int fx_calls(void) { return fx_static() + fx_hidden() + fx_undefined_import(); }

/* Two versions of one name, as libc has for memcpy/sched_getaffinity: the
 * hidden compat one (@V1) and the default one (@@V2). Linked with
 * elf_fixture.map. dlsym("fx_ver") returns the default. */
int fx_ver_v1(void) { return 1; }
int fx_ver_v2(void) { return 2; }
__asm__(".symver fx_ver_v1,fx_ver@V1");
__asm__(".symver fx_ver_v2,fx_ver@@V2");
