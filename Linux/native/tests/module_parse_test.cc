// Tests for the PE/ELF parsers in module_parse.h, against real binaries.
// Run from Linux/native/tests (run-tests.sh does) after it built the ELF
// fixtures. Build:
//   g++ -std=c++17 -O0 -g -Wall -fsanitize=address,undefined -ldl -o module_parse_test module_parse_test.cc
//
// The parsers read "target memory" through a callback. Here that is either a
// byte buffer laid out the way the loader maps the file (PE sections at their
// RVAs, ELF PT_LOAD segments at their vaddrs), or this very process, which is
// the case that matters in production: a really loaded ELF whose .dynamic the
// dynamic linker has already relocated in place.
#include "../module_parse.h"

#include <dlfcn.h>
#include <link.h>
#include <sys/uio.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>

using namespace linuxmod;

static int g_failures = 0;
#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                 \
      ++g_failures;                                                          \
    }                                                                        \
  } while (0)

using Bytes = std::vector<uint8_t>;
using Exports = std::map<std::string, uintptr_t>;

static Bytes Slurp(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) {
    printf("FAIL: fixture missing: %s (run from Linux/native/tests after run-tests.sh built the ELF fixtures)\n",
           path.c_str());
    exit(1);
  }
  std::stringstream ss;
  ss << f.rdbuf();
  std::string s = ss.str();
  return Bytes(s.begin(), s.end());
}

static uint16_t Rd16(const Bytes& b, size_t o) { return o + 2 <= b.size() ? detail::U16(&b[o]) : 0; }
static uint32_t Rd32(const Bytes& b, size_t o) { return o + 4 <= b.size() ? detail::U32(&b[o]) : 0; }
static uint64_t Rd64(const Bytes& b, size_t o) { return o + 8 <= b.size() ? detail::U64(&b[o]) : 0; }

// A read callback over an image buffer placed at `base`. Out-of-range reads
// fail whole, like a read that runs into an unmapped page.
static ReadFn BufferReader(const Bytes& image, uintptr_t base) {
  return [&image, base](uintptr_t addr, void* out, size_t size) {
    if (addr < base) return false;
    uint64_t off = addr - base;
    if (off > image.size() || size > image.size() - off) return false;
    memcpy(out, image.data() + off, size);
    return true;
  };
}

// The loader step for a PE on disk: headers, then each section at its RVA.
static Bytes LayoutPe(const Bytes& file) {
  uint32_t lfanew = Rd32(file, 0x3c);
  uint16_t nsec = Rd16(file, lfanew + 6);
  uint16_t optSize = Rd16(file, lfanew + 20);
  uint32_t sizeOfImage = Rd32(file, lfanew + 24 + 56);
  uint32_t sizeOfHeaders = Rd32(file, lfanew + 24 + 60);
  Bytes img(sizeOfImage, 0);
  memcpy(img.data(), file.data(), sizeOfHeaders);
  size_t sec = lfanew + 24 + optSize;
  for (uint16_t i = 0; i < nsec; ++i, sec += 40) {
    uint32_t vsize = Rd32(file, sec + 8), va = Rd32(file, sec + 12);
    uint32_t rawSize = Rd32(file, sec + 16), rawPtr = Rd32(file, sec + 20);
    uint32_t n = rawSize < vsize ? rawSize : vsize;
    if (rawPtr + n <= file.size() && va + n <= img.size()) memcpy(img.data() + va, file.data() + rawPtr, n);
  }
  return img;
}

// The loader step for an ELF on disk: each PT_LOAD at its vaddr (relative to
// the lowest one, which is where `base` points). Dynamic d_ptr values stay the
// unrelocated link-time vaddrs, as in a musl-style or read-only .dynamic.
static Bytes LayoutElf(const Bytes& file) {
  uint64_t phoff = Rd64(file, 32);
  uint16_t phnum = Rd16(file, 56);
  uint64_t lo = ~0ull, hi = 0;
  for (uint16_t i = 0; i < phnum; ++i) {
    size_t p = phoff + 56u * i;
    if (Rd32(file, p) != 1) continue;
    uint64_t v = Rd64(file, p + 16), m = Rd64(file, p + 40);
    if ((v & ~0xfffull) < lo) lo = v & ~0xfffull;
    if (v + m > hi) hi = v + m;
  }
  Bytes img(hi - lo, 0);
  for (uint16_t i = 0; i < phnum; ++i) {
    size_t p = phoff + 56u * i;
    if (Rd32(file, p) != 1) continue;
    uint64_t off = Rd64(file, p + 8), v = Rd64(file, p + 16), fsz = Rd64(file, p + 32);
    memcpy(img.data() + (v - lo), file.data() + off, fsz);
  }
  return img;
}

static bool Has(const Exports& e, const char* name) { return e.count(name) != 0; }

// ---------------------------------------------------------------- PE

static void TestPeProbe() {
  const uintptr_t base = 0x7ff600000000ull;
  Bytes img = LayoutPe(Slurp("fixtures/probe.dll"));
  ReadFn read = BufferReader(img, base);

  PeHeaders h;
  CHECK(ParsePeHeaders(read, base, h));
  CHECK(h.sizeOfImage == 0x1e000);
  CHECK(h.timestamp == 0x6a695ebc);
  CHECK(DetectImage(read, base) == ImageKind::Pe);

  Exports e;
  CHECK(ParsePeExports(read, base, e));
  CHECK(e.size() == 3);
  // RVAs from `objdump -p probe.dll`.
  CHECK(e["g_pad"] == base + 0x18ac0);
  CHECK(e["g_probe_field"] == base + 0x18000);
  CHECK(e["probe_write"] == base + 0x1000);
  CHECK(!Has(e, "nope"));
}

static void TestPeMono() {
  const uintptr_t base = 0x180000000ull;
  Bytes img = LayoutPe(Slurp("fixtures/probe_mono.dll"));
  ReadFn read = BufferReader(img, base);

  PeHeaders h;
  CHECK(ParsePeHeaders(read, base, h));
  CHECK(h.sizeOfImage == 0x1f000);
  CHECK(h.timestamp == 0x6a94a24c);

  Exports e;
  CHECK(ParsePeExports(read, base, e));
  CHECK(e.size() == 27);
  CHECK(e["mono_assembly_foreach"] == base + 0x13e0);
  CHECK(e["mono_assembly_get_image"] == base + 0x1040);
  CHECK(e["mono_class_from_name"] == base + 0x1060);
}

static void TestPeRefusals() {
  const uintptr_t base = 0x10000;
  Bytes good = LayoutPe(Slurp("fixtures/probe.dll"));
  Exports e;
  PeHeaders h;

  // Not a PE at all, and an unreadable base.
  Bytes junk(0x2000, 0x41);
  CHECK(!ParsePeExports(BufferReader(junk, base), base, e));
  CHECK(!ParsePeHeaders(BufferReader(junk, base), base, h));
  CHECK(!ParsePeExports(BufferReader(good, base), base + 0x100000000ull, e));

  // 32-bit image (PE32 magic) is refused, as on Windows.
  Bytes pe32 = good;
  pe32[0x100 + 24] = 0x0b;
  pe32[0x100 + 25] = 0x01;
  CHECK(!ParsePeExports(BufferReader(pe32, base), base, e));

  // e_lfanew out of range.
  for (uint32_t bad : {0u, 0x10u, 0x3fu, 0x100001u, 0xfffffff0u, 0xffffffffu}) {
    Bytes b = good;
    memcpy(&b[0x3c], &bad, 4);
    CHECK(!ParsePeExports(BufferReader(b, base), base, e));
  }

  // Export directory offsets.
  const size_t exportDirRva = Rd32(good, 0x100 + 24 + 112);
  auto patch32 = [&](size_t off, uint32_t v) {
    Bytes b = good;
    memcpy(&b[off], &v, 4);
    return b;
  };
  // Huge name/function counts must fail fast, not allocate.
  CHECK(!ParsePeExports(BufferReader(patch32(exportDirRva + 24, 0xffffffffu), base), base, e));
  CHECK(!ParsePeExports(BufferReader(patch32(exportDirRva + 20, 0xffffffffu), base), base, e));
  // Table RVAs outside the image.
  CHECK(!ParsePeExports(BufferReader(patch32(exportDirRva + 28, 0xfffffff0u), base), base, e));
  CHECK(!ParsePeExports(BufferReader(patch32(exportDirRva + 32, 0xfffffff0u), base), base, e));
  CHECK(!ParsePeExports(BufferReader(patch32(exportDirRva + 36, 0x1fffffffu), base), base, e));
  // Export directory RVA outside the image / zero size.
  CHECK(!ParsePeExports(BufferReader(patch32(0x100 + 24 + 112, 0xffffffffu), base), base, e));
  CHECK(!ParsePeExports(BufferReader(patch32(0x100 + 24 + 116, 0), base), base, e));

  // A name RVA outside the image drops that export only.
  {
    uint32_t namesRva = Rd32(good, exportDirRva + 32);
    Bytes b = good;
    uint32_t wild = 0xfffffff0u;
    memcpy(&b[namesRva], &wild, 4);  // first name (g_pad)
    CHECK(ParsePeExports(BufferReader(b, base), base, e));
    CHECK(!Has(e, "g_pad") && Has(e, "probe_write"));
  }

  // An ordinal past NumberOfFunctions drops that export only.
  {
    uint32_t ordsRva = Rd32(good, exportDirRva + 36);
    Bytes b = good;
    uint16_t wild = 0x7fff;
    memcpy(&b[ordsRva], &wild, 2);
    CHECK(ParsePeExports(BufferReader(b, base), base, e));
    CHECK(!Has(e, "g_pad") && Has(e, "probe_write") && Has(e, "g_probe_field"));
  }

  // A forwarder (function RVA pointing back inside the export directory) is
  // skipped: ResolveExport reports those as 0.
  {
    uint32_t funcsRva = Rd32(good, exportDirRva + 28);
    Bytes b = good;
    uint32_t fwd = (uint32_t)exportDirRva + 0x30;  // inside [rva, rva+size)
    memcpy(&b[funcsRva + 4 * 2], &fwd, 4);         // ordinal 2 = probe_write
    CHECK(ParsePeExports(BufferReader(b, base), base, e));
    CHECK(!Has(e, "probe_write") && Has(e, "g_pad") && Has(e, "g_probe_field"));
  }

  // The image cut short anywhere reads as a failed read: false, never a crash.
  for (size_t cut : {size_t(0), size_t(0x40), size_t(0x100), size_t(0x180), size_t(0x400),
                     exportDirRva + 0x10, exportDirRva + 0x40}) {
    Bytes b(good.begin(), good.begin() + cut);
    ParsePeExports(BufferReader(b, base), base, e);
  }
}

// ---------------------------------------------------------------- ELF

struct ElfCase {
  const char* file;
  const char* label;
};

static const char* kFixtureSyms[] = {"fx_counter", "fx_data", "fx_name", "fx_weak", "fx_add", "fx_calls", "fx_ver"};

static void ExpectFixtureSymbols(const Exports& e, uintptr_t base, void* handle,
                                 uintptr_t loadBias, const char* label) {
  for (const char* name : kFixtureSyms) {
    void* real = dlsym(handle, name);
    uintptr_t want = base + ((uintptr_t)real - loadBias);
    auto it = e.find(name);
    if (it == e.end() || it->second != want) {
      printf("FAIL: %s: %s resolves to %#lx, want %#lx\n", label, name,
             it == e.end() ? 0ul : (unsigned long)it->second, (unsigned long)want);
      ++g_failures;
    }
  }
  CHECK(!Has(e, "fx_hidden"));            // hidden visibility: not in .dynsym
  CHECK(!Has(e, "fx_static"));            // local
  CHECK(!Has(e, "fx_undefined_import"));  // undefined import
}

static ReadFn SelfReader() {
  return [](uintptr_t addr, void* out, size_t size) {
    iovec local{out, size}, remote{(void*)addr, size};
    return process_vm_readv(getpid(), &local, 1, &remote, 1, 0) == (ssize_t)size;
  };
}

static void TestElfFixture(const ElfCase& c) {
  std::string path = std::string("fixtures/") + c.file;
  void* h = dlopen(("./" + path).c_str(), RTLD_LAZY);
  if (!h) {
    printf("FAIL: dlopen %s: %s\n", path.c_str(), dlerror());
    ++g_failures;
    return;
  }
  link_map* lm = nullptr;
  dlinfo(h, RTLD_DI_LINKMAP, &lm);
  const uintptr_t loadBias = lm->l_addr;

  // (a) Really loaded in this process: in-place relocated d_ptr values.
  Exports live;
  CHECK(ParseElfDynsym(SelfReader(), loadBias, live));
  ExpectFixtureSymbols(live, loadBias, h, loadBias, c.label);

  // (b) File laid out by PT_LOAD at a fake base: unrelocated d_ptr values.
  Bytes file = Slurp(path);
  Bytes img = LayoutElf(file);
  const uintptr_t fake = 0x7f1234560000ull;
  Exports laid;
  CHECK(DetectImage(BufferReader(img, fake), fake) == ImageKind::Elf);
  CHECK(ParseElfDynsym(BufferReader(img, fake), fake, laid));
  ExpectFixtureSymbols(laid, fake, h, loadBias, c.label);

  // (c) No hash tag at all: the symbol count falls back to .dynstr - .dynsym.
  {
    Bytes b = img;
    uint64_t phoff = Rd64(file, 32);
    uint16_t phnum = Rd16(file, 56);
    for (uint16_t i = 0; i < phnum; ++i) {
      size_t p = phoff + 56u * i;
      if (Rd32(file, p) != 2) continue;
      size_t dyn = Rd64(file, p + 16);  // minVaddr is 0 for these .so files
      for (size_t o = dyn; o + 16 <= b.size(); o += 16) {
        uint64_t tag = Rd64(b, o);
        if (tag == 0) break;
        if (tag == 4 || tag == 0x6ffffef5) {
          uint64_t unknown = 0x6fffff00;
          memcpy(&b[o], &unknown, 8);
        }
      }
    }
    Exports e;
    CHECK(ParseElfDynsym(BufferReader(b, fake), fake, e));
    ExpectFixtureSymbols(e, fake, h, loadBias, c.label);
  }
  dlclose(h);
}

static void TestElfLibc() {
  void* h = dlopen("libc.so.6", RTLD_LAZY | RTLD_NOLOAD);
  if (!h) h = dlopen("libc.so.6", RTLD_LAZY);
  CHECK(h != nullptr);
  if (!h) return;
  link_map* lm = nullptr;
  dlinfo(h, RTLD_DI_LINKMAP, &lm);
  Exports e;
  CHECK(ParseElfDynsym(SelfReader(), lm->l_addr, e));
  CHECK(e.size() > 1000);
  for (const char* name : {"malloc", "free", "getpid", "printf", "process_vm_readv"})
    CHECK(e[name] == (uintptr_t)dlsym(h, name));
  // Versioned names: libc has a hidden compat definition BEFORE the default one in
  // .dynsym (realpath@GLIBC_2.2.5 then realpath@@GLIBC_2.3, same for
  // sched_getaffinity); the default must win, as in dlsym.
  for (const char* name : {"realpath", "sched_getaffinity"}) {
    CHECK(Has(e, name));
    CHECK(e[name] == (uintptr_t)dlsym(h, name));
  }
  // STT_GNU_IFUNC symbols resolve to a resolver, not the function: reported as not found.
  for (const char* name : {"memcpy", "strlen", "strcmp"}) CHECK(!Has(e, name));
}

// Where the dynamic table, symbols and version table sit in a laid-out fixture image.
struct DynLayout {
  uint64_t dyn = 0, symtab = 0, strtab = 0, versym = 0;
  size_t versymEntryOff = 0;  // offset in the image of the DT_VERSYM d_val
};
static DynLayout FindDyn(const Bytes& file, const Bytes& img) {
  DynLayout d;
  uint64_t phoff = Rd64(file, 32);
  uint16_t phnum = Rd16(file, 56);
  for (uint16_t i = 0; i < phnum; ++i) {
    size_t p = phoff + 56u * i;
    if (Rd32(file, p) == 2) d.dyn = Rd64(file, p + 16);  // minVaddr is 0 for these .so files
  }
  for (size_t o = d.dyn; o + 16 <= img.size(); o += 16) {
    uint64_t tag = Rd64(img, o), val = Rd64(img, o + 8);
    if (tag == 0) break;
    if (tag == 5) d.strtab = val;
    if (tag == 6) d.symtab = val;
    if (tag == 0x6ffffff0) { d.versym = val; d.versymEntryOff = o + 8; }
  }
  return d;
}

// The default (@@) version must win whichever order .dynsym lists the two
// definitions of fx_ver, so flip which one is hidden and check both orders.
static void TestElfVersioning() {
  void* h = dlopen("./fixtures/elf_gnu.so", RTLD_LAZY);
  CHECK(h != nullptr);
  if (!h) return;
  link_map* lm = nullptr;
  dlinfo(h, RTLD_DI_LINKMAP, &lm);
  const uint64_t defAddr = (uintptr_t)dlsym(h, "fx_ver") - lm->l_addr;
  const uint64_t oldAddr = (uintptr_t)dlvsym(h, "fx_ver", "V1") - lm->l_addr;
  CHECK(defAddr != oldAddr);

  Bytes file = Slurp("fixtures/elf_gnu.so");
  Bytes img = LayoutElf(file);
  DynLayout d = FindDyn(file, img);
  CHECK(d.versym != 0);
  size_t idxDef = 0, idxOld = 0;
  for (size_t i = 1; i < (d.strtab - d.symtab) / 24; ++i) {
    uint64_t v = Rd64(img, d.symtab + 24 * i + 8);
    if (v == defAddr) idxDef = i;
    if (v == oldAddr) idxOld = i;
  }
  CHECK(idxDef && idxOld);
  const uintptr_t base = 0x7f0000000000ull;
  auto parse = [&](const Bytes& b) {
    Exports e;
    CHECK(ParseElfDynsym(BufferReader(b, base), base, e));
    return e["fx_ver"] - base;
  };
  CHECK(parse(img) == defAddr);  // as built
  // Make the *other* definition the default one: the answer must follow the hidden bit.
  Bytes flipped = img;
  uint16_t hidden = 0x8000 | 2, shown = 2;
  memcpy(&flipped[d.versym + 2 * idxDef], &hidden, 2);
  memcpy(&flipped[d.versym + 2 * idxOld], &shown, 2);
  CHECK(parse(flipped) == oldAddr);
  // Both hidden: the first definition stays.
  Bytes bothHidden = flipped;
  memcpy(&bothHidden[d.versym + 2 * idxOld], &hidden, 2);
  CHECK(parse(bothHidden) == (idxDef < idxOld ? defAddr : oldAddr));
  // The hidden definition forced first, regardless of the build's order.
  Bytes oldFirstHidden = img;
  memcpy(&oldFirstHidden[d.versym + 2 * idxOld], &hidden, 2);
  memcpy(&oldFirstHidden[d.versym + 2 * idxDef], &shown, 2);
  CHECK(parse(oldFirstHidden) == defAddr);

  // Hostile DT_VERSYM: out of range, past the image end (short table), huge. The
  // version table is ignored (first definition wins); everything else still parses.
  for (uint64_t bad : std::vector<uint64_t>{0xfffffffffff0ull, img.size() - 2, img.size(), ~0ull}) {
    Bytes b = img;
    memcpy(&b[d.versymEntryOff], &bad, 8);
    Exports e;
    CHECK(ParseElfDynsym(BufferReader(b, base), base, e));
    CHECK(Has(e, "fx_add") && Has(e, "fx_ver"));
  }
  dlclose(h);
}

static void TestImageExtent() {
  const uintptr_t base = 0x7f0000000000ull;
  // ELF: the extent comes from the program headers and covers .bss.
  for (const char* f : {"elf_gnu.so", "elf_sysv.so", "elf_both.so"}) {
    Bytes file = Slurp(std::string("fixtures/") + f);
    Bytes img = LayoutElf(file);  // sized max(vaddr+memsz) - minVaddr, .bss included
    uint64_t size = 0;
    CHECK(ElfImageExtent(BufferReader(img, base), base, size));
    const uint64_t rounded = (img.size() + 0xfff) & ~0xfffull;  // the extent is whole pages
    CHECK(size == rounded);
    MeasuredImage m = MeasureImage(BufferReader(img, base), base, 0x1000);
    CHECK(m.kind == ImageKind::Elf && m.headersOk && m.size == rounded && m.timestamp == 0);
  }
  // PE: SizeOfImage and the timestamp.
  {
    Bytes img = LayoutPe(Slurp("fixtures/probe.dll"));
    MeasuredImage m = MeasureImage(BufferReader(img, base), base, 0x1000);
    CHECK(m.kind == ImageKind::Pe && m.headersOk && m.size == 0x1e000 && m.timestamp == 0x6a695ebc);
  }
  // Headers that cannot be read: the file span is the fallback; unknown stays unknown.
  {
    Bytes mz(0x40, 0);  // "MZ" but truncated: the PE header read fails
    mz[0] = 'M';
    mz[1] = 'Z';
    MeasuredImage m = MeasureImage(BufferReader(mz, base), base, 0x5000);
    CHECK(m.kind == ImageKind::Pe && !m.headersOk && m.size == 0x5000);
    Bytes data(0x1000, 'x');
    CHECK(MeasureImage(BufferReader(data, base), base, 0x1000).kind == ImageKind::Unknown);
  }
  // Hostile program headers.
  Bytes file = Slurp("fixtures/elf_gnu.so");
  Bytes good = LayoutElf(file);
  uint64_t phoff = Rd64(file, 32);
  uint16_t phnum = Rd16(file, 56);
  auto patch = [&](size_t off, uint64_t v, size_t len) {
    Bytes b = good;
    memcpy(&b[off], &v, len);
    return b;
  };
  uint64_t size = 0;
  CHECK(!ElfImageExtent(BufferReader(patch(56, 0xffff, 2), base), base, size));  // phnum huge
  CHECK(!ElfImageExtent(BufferReader(patch(56, 0, 2), base), base, size));
  CHECK(!ElfImageExtent(BufferReader(good, base), base + 0x100000000ull, size));
  {  // no PT_LOAD at all
    Bytes b = good;
    for (uint16_t i = 0; i < phnum; ++i)
      if (Rd32(file, phoff + 56u * i) == 1) {
        uint32_t t = 4;
        memcpy(&b[phoff + 56u * i], &t, 4);
      }
    CHECK(!ElfImageExtent(BufferReader(b, base), base, size));
  }
  for (uint16_t i = 0; i < phnum; ++i) {
    size_t p = phoff + 56u * i;
    if (Rd32(file, p) != 1) continue;
    CHECK(!ElfImageExtent(BufferReader(patch(p + 40, 0xffffffffffffffffull, 8), base), base, size));  // memsz overflow
    CHECK(!ElfImageExtent(BufferReader(patch(p + 40, 1ull << 40, 8), base), base, size));            // memsz absurd
    CHECK(!ElfImageExtent(BufferReader(patch(p + 16, 0xfffffffffffff000ull, 8), base), base, size));  // vaddr absurd
    break;
  }
}

static void TestElfRefusals() {
  const uintptr_t base = 0x400000;
  Bytes good = LayoutElf(Slurp("fixtures/elf_gnu.so"));
  Exports e;
  Bytes junk(0x3000, 0x7f);
  CHECK(!ParseElfDynsym(BufferReader(junk, base), base, e));
  CHECK(!ParseElfDynsym(BufferReader(good, base), base + 0x100000000ull, e));
  CHECK(DetectImage(BufferReader(junk, base), base) == ImageKind::Unknown);

  auto patch = [&](size_t off, uint64_t v, size_t len) {
    Bytes b = good;
    memcpy(&b[off], &v, len);
    return b;
  };
  CHECK(!ParseElfDynsym(BufferReader(patch(4, 1, 1), base), base, e));          // 32-bit class
  CHECK(!ParseElfDynsym(BufferReader(patch(5, 2, 1), base), base, e));          // big endian
  CHECK(!ParseElfDynsym(BufferReader(patch(16, 1, 2), base), base, e));         // ET_REL
  CHECK(!ParseElfDynsym(BufferReader(patch(32, 0xfffffffffffffff0ull, 8), base), base, e));  // e_phoff
  CHECK(!ParseElfDynsym(BufferReader(patch(54, 8, 2), base), base, e));         // e_phentsize
  CHECK(!ParseElfDynsym(BufferReader(patch(56, 0xffff, 2), base), base, e));    // e_phnum
  CHECK(!ParseElfDynsym(BufferReader(patch(56, 0, 2), base), base, e));

  // Corrupt PT_DYNAMIC p_vaddr / p_memsz: reads fail or are capped, no crash.
  uint64_t phoff = Rd64(good, 32);
  uint16_t phnum = Rd16(good, 56);
  for (uint16_t i = 0; i < phnum; ++i) {
    size_t p = phoff + 56u * i;
    if (Rd32(good, p) != 2) continue;
    ParseElfDynsym(BufferReader(patch(p + 16, 0xffffffffffff0000ull, 8), base), base, e);
    ParseElfDynsym(BufferReader(patch(p + 40, 0xffffffffffffffffull, 8), base), base, e);
    CHECK(!ParseElfDynsym(BufferReader(patch(p + 40, 8, 8), base), base, e));
  }
}

// ---------------------------------------------------------------- fuzz

// Deterministic corruption of the header areas: whatever the bytes say, the
// parser must return (the buffer reader makes any wild pointer a failed read;
// ASan makes any out-of-bounds use of its own buffers a hard failure).
static void FuzzImage(const Bytes& good, uintptr_t base, bool pe, size_t hotLo, size_t hotHi) {
  uint64_t state = 0x9e3779b97f4a7c15ull;
  auto next = [&]() {
    state = state * 6364136223846793005ull + 1442695040888963407ull;
    return (uint32_t)(state >> 33);
  };
  Exports e;
  for (int iter = 0; iter < 4000; ++iter) {
    Bytes b = good;
    int flips = 1 + next() % 8;
    for (int i = 0; i < flips; ++i) {
      size_t lo = next() % 3 == 0 ? 0 : hotLo;
      size_t hi = lo == 0 ? 0x400 : hotHi;
      if (hi > b.size()) hi = b.size();
      size_t off = lo + next() % (hi - lo);
      b[off] = next() % 4 == 0 ? 0xff : (uint8_t)next();
    }
    if (pe) ParsePeExports(BufferReader(b, base), base, e);
    else ParseElfDynsym(BufferReader(b, base), base, e);
  }
}

int main() {
  TestPeProbe();
  TestPeMono();
  TestPeRefusals();

  const ElfCase cases[] = {{"elf_gnu.so", "gnu-hash"}, {"elf_sysv.so", "sysv-hash"}, {"elf_both.so", "both-hash"}};
  for (const ElfCase& c : cases) TestElfFixture(c);
  TestElfLibc();
  TestElfRefusals();
  TestElfVersioning();
  TestImageExtent();

  {
    Bytes pe = LayoutPe(Slurp("fixtures/probe.dll"));
    uint32_t exportRva = Rd32(pe, 0x100 + 24 + 112);
    FuzzImage(pe, 0x10000, true, exportRva, exportRva + 0x80);
    Bytes elf = LayoutElf(Slurp("fixtures/elf_gnu.so"));
    // Hash/dynsym/dynstr/versym sit in the first segment; .dynamic is located from the headers.
    for (const char* f : {"fixtures/elf_gnu.so", "fixtures/elf_sysv.so"}) {
      Bytes file = Slurp(f);
      Bytes img = LayoutElf(file);
      DynLayout d = FindDyn(file, img);
      FuzzImage(img, 0x400000, false, 0x2f0, 0x700);
      FuzzImage(img, 0x400000, false, (size_t)d.dyn, (size_t)d.dyn + 0x180);
    }
  }

  if (g_failures) {
    printf("module_parse_test: %d failure(s)\n", g_failures);
    return 1;
  }
  printf("module_parse_test OK\n");
  return 0;
}
