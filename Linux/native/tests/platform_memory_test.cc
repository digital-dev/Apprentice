// Tests ListModules / ListModuleRanges / ResolveExport of the real Linux backend
// against this very process as the target. Build (run-tests.sh does):
//   g++ -std=c++17 -O0 -g -Wall -I../../../native/src/platform -o platform_memory_test \
//     platform_memory_test.cc ../platform_linux.cc ../platform_linux_process.cc ../platform_linux_memory.cc ../platform_linux_write.cc -ldl
// Run from Linux/native/tests, after Linux/test-harness/probe.so has been built.
#include "platform.h"

#include <dlfcn.h>
#include <link.h>
#include <sys/mman.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>

static int g_failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);       \
      ++g_failures;                                                \
    }                                                              \
  } while (0)

static const platform::ModuleInfo* FindByName(const std::vector<platform::ModuleInfo>& v, const char* n) {
  for (const auto& m : v)
    if (m.name == n) return &m;
  return nullptr;
}

int main() {
  std::string err;
  platform::ProcessHandle h = platform::OpenProcess((uint32_t)getpid(), err);
  CHECK(h != 0);

  // A library with a .bss tail: probe.so's g_bss_tail is zero-initialised, so the
  // kernel maps it anonymously past the file pages.
  void* lib = dlopen("../../test-harness/probe.so", RTLD_NOW);
  if (!lib) {
    printf("FAIL: dlopen probe.so: %s (build it first, see run-tests.sh)\n", dlerror());
    return 1;
  }
  link_map* lm = nullptr;
  dlinfo(lib, RTLD_DI_LINKMAP, &lm);
  const uintptr_t base = lm->l_addr;
  const uintptr_t bss = (uintptr_t)dlsym(lib, "g_bss_tail");
  CHECK(bss > base);

  // A mapped data file: not an image, so not a module in either listing.
  char tmpl[] = "/tmp/platform_memory_test_XXXXXX";
  int fd = mkstemp(tmpl);
  CHECK(fd >= 0);
  CHECK(ftruncate(fd, 8192) == 0);
  void* data = mmap(nullptr, 8192, PROT_READ, MAP_SHARED, fd, 0);
  CHECK(data != MAP_FAILED);
  const uintptr_t dataBase = (uintptr_t)data;
  const std::string dataName = std::string(tmpl).substr(5);  // basename

  std::vector<platform::ModuleInfo> mods;
  std::vector<platform::ModuleRange> ranges;
  CHECK(platform::ListModules(h, mods));
  CHECK(platform::ListModuleRanges(h, ranges));

  // Same modules, same order, same name/base/size from both calls.
  CHECK(mods.size() == ranges.size() && !mods.empty());
  for (size_t i = 0; i < mods.size() && i < ranges.size(); ++i) {
    if (mods[i].name != ranges[i].name || mods[i].base != ranges[i].base || mods[i].size != ranges[i].size) {
      printf("FAIL: module %zu differs: %s %#lx %u vs %s %#lx %lu\n", i, mods[i].name.c_str(),
             (unsigned long)mods[i].base, mods[i].size, ranges[i].name.c_str(), (unsigned long)ranges[i].base,
             (unsigned long)ranges[i].size);
      ++g_failures;
    }
  }

  // probe.so: its range covers the .bss global (extent from the program headers).
  const platform::ModuleInfo* probe = FindByName(mods, "probe.so");
  CHECK(probe != nullptr);
  if (probe) {
    CHECK(probe->base == base);
    CHECK(probe->size >= (bss - base) + 65536);
    CHECK(probe->timestamp == 0 && probe->version.empty());
  }

  // The data file shows up in neither list, by base or by name.
  for (const auto& m : mods) CHECK(m.base != dataBase && m.name != dataName);
  for (const auto& r : ranges) CHECK(r.base != dataBase && r.name != dataName);

  // ResolveExport on the live image: the .bss symbol and a function, as dlsym says.
  CHECK(platform::ResolveExport(h, base, "g_bss_tail") == bss);
  CHECK(platform::ResolveExport(h, base, "probe_write") == (uintptr_t)dlsym(lib, "probe_write"));
  CHECK(platform::ResolveExport(h, base, "no_such_symbol") == 0);

  if (g_failures) {
    printf("platform_memory_test: %d failure(s)\n", g_failures);
    return 1;
  }
  printf("platform_memory_test OK\n");
  return 0;
}
