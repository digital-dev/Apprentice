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
