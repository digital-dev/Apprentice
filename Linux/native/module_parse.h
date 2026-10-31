#pragma once
// Pure PE and ELF image parsers for the Linux backend. They read the image
// through a callback (target memory in production, a byte buffer in
// tests/module_parse_test.cc), so no OS headers and no IO live here.
//
// The images are untrusted: a game can hold any bytes at a module base. Every
// header field is bounds-checked before it is used as a size, offset or loop
// bound, and every table is capped, so corrupt data returns false instead of
// spinning or allocating gigabytes.
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace linuxmod {

// All-or-nothing read of target memory: false unless all `size` bytes were read.
using ReadFn = std::function<bool(uintptr_t address, void* out, size_t size)>;

enum class ImageKind { Unknown, Pe, Elf };

namespace detail {

// Little-endian loads (x86-64 only, like the rest of this backend).
inline uint16_t U16(const uint8_t* p) { uint16_t v; memcpy(&v, p, 2); return v; }
inline uint32_t U32(const uint8_t* p) { uint32_t v; memcpy(&v, p, 4); return v; }
inline uint64_t U64(const uint8_t* p) { uint64_t v; memcpy(&v, p, 8); return v; }

constexpr size_t kMaxExports = 0x20000;        // PE ordinals are 16-bit
constexpr size_t kMaxSymbols = 1u << 20;       // ELF .dynsym entries
constexpr size_t kMaxStrtab = 32u << 20;
constexpr size_t kMaxNameLen = 1024;
constexpr size_t kMaxDynamic = 0x10000;        // bytes of PT_DYNAMIC read
constexpr size_t kMaxExportBlock = 8u << 20;
constexpr uint32_t kMaxLfanew = 0x100000;
constexpr size_t kElfSymSize = 24;
constexpr uint64_t kMaxImageSize = 1ull << 36;  // 64 GiB: far above any real module

// A NUL-terminated string at `addr`, at most kMaxNameLen long. Reads stay
// within one page at a time so a string ending just before an unmapped page
// is still readable. False on a failed read or an unterminated/overlong string.
inline bool ReadCString(const ReadFn& read, uintptr_t addr, std::string& out) {
  out.clear();
  char buf[256];
  while (out.size() < kMaxNameLen) {
    size_t toPage = 4096 - (size_t)(addr & 4095);
    size_t n = toPage < sizeof(buf) ? toPage : sizeof(buf);
    if (!read(addr, buf, n)) return false;
    const void* nul = memchr(buf, 0, n);
    if (nul) {
      out.append(buf, (const char*)nul - buf);
      return out.size() <= kMaxNameLen;
    }
    out.append(buf, n);
    addr += n;
  }
  return false;
}

// Reads `count` elements of `elemSize` bytes at `addr` into `out`. False when
// the product overflows, exceeds `maxBytes`, or the read fails.
inline bool ReadTable(const ReadFn& read, uintptr_t addr, uint64_t count, size_t elemSize,
                      size_t maxBytes, std::vector<uint8_t>& out) {
  if (elemSize == 0 || count > maxBytes / elemSize) return false;
  out.assign((size_t)count * elemSize, 0);
  if (out.empty()) return true;
  return read(addr, out.data(), out.size());
}

// ELF64 header check plus program headers (all-or-nothing). False unless a
// little-endian ELF64 EXEC/DYN image with a sane program header table.
inline bool ReadElfPhdrs(const ReadFn& read, uintptr_t base, std::vector<uint8_t>& ph,
                         uint16_t& phnum) {
  uint8_t eh[64];
  if (!read(base, eh, sizeof(eh))) return false;
  if (memcmp(eh, "\x7f""ELF", 4) != 0 || eh[4] != 2 /*64-bit*/ || eh[5] != 1 /*LE*/) return false;
  uint16_t type = U16(eh + 16);
  if (type != 2 /*EXEC*/ && type != 3 /*DYN*/) return false;
  uint64_t phoff = U64(eh + 32);
  uint16_t phentsize = U16(eh + 54);
  phnum = U16(eh + 56);
  if (phentsize != 56 || phnum == 0 || phnum > 256 || phoff == 0 || phoff > 0x100000) return false;
  return ReadTable(read, base + (uintptr_t)phoff, phnum, 56, 56 * 256, ph);
}

}  // namespace detail

// What kind of image starts at `base`, from its first bytes.
inline ImageKind DetectImage(const ReadFn& read, uintptr_t base) {
  uint8_t magic[4];
  if (!read(base, magic, sizeof(magic))) return ImageKind::Unknown;
  if (magic[0] == 'M' && magic[1] == 'Z') return ImageKind::Pe;
  if (magic[0] == 0x7f && magic[1] == 'E' && magic[2] == 'L' && magic[3] == 'F')
    return ImageKind::Elf;
  return ImageKind::Unknown;
}

struct PeHeaders {
  uint32_t sizeOfImage = 0;
  uint32_t timestamp = 0;
  uint32_t exportRva = 0;
  uint32_t exportSize = 0;
};

// The PE32+ fields ListModules and the export walk need. False for anything
// that is not a well-formed 64-bit PE (a 32-bit image is refused, as on Windows).
inline bool ParsePeHeaders(const ReadFn& read, uintptr_t base, PeHeaders& out) {
  using namespace detail;
  uint8_t dos[64];
  if (!read(base, dos, sizeof(dos))) return false;
  if (dos[0] != 'M' || dos[1] != 'Z') return false;
  uint32_t lfanew = U32(dos + 0x3c);
  if (lfanew < sizeof(dos) || lfanew > kMaxLfanew) return false;

  // Signature(4) + COFF header(20) + optional header(112) + 16 data directories(128).
  uint8_t nt[264];
  if (!read(base + lfanew, nt, sizeof(nt))) return false;
  if (memcmp(nt, "PE\0\0", 4) != 0) return false;
  if (U16(nt + 24) != 0x20b) return false;  // PE32+
  uint16_t optSize = U16(nt + 20);
  PeHeaders h;
  h.timestamp = U32(nt + 8);
  h.sizeOfImage = U32(nt + 24 + 56);
  // The export directory entry only exists if the header says so.
  if (optSize >= 112 + 8 && U32(nt + 24 + 108) >= 1) {
    h.exportRva = U32(nt + 24 + 112);
    h.exportSize = U32(nt + 24 + 116);
  }
  out = h;
  return true;
}

// Every named export of the PE at `base` (loaded image layout: RVAs are read at
// base+RVA) as name -> absolute address. Forwarders (an export whose RVA points
// back inside the export directory) are left out: they name another DLL's
// export, not an address. False when the image is not a readable PE64.
inline bool ParsePeExports(const ReadFn& read, uintptr_t base,
                           std::map<std::string, uintptr_t>& out) {
  using namespace detail;
  out.clear();
  PeHeaders pe;
  if (!ParsePeHeaders(read, base, pe)) return false;
  if (pe.exportRva == 0 || pe.exportSize == 0 || pe.sizeOfImage == 0) return false;
  const uint64_t imageSize = pe.sizeOfImage;
  auto inImage = [&](uint64_t rva, uint64_t len) {
    return rva <= imageSize && len <= imageSize - rva;
  };
  if (!inImage(pe.exportRva, 40)) return false;

  uint8_t dir[40];
  if (!read(base + pe.exportRva, dir, sizeof(dir))) return false;
  uint32_t nFunctions = U32(dir + 20);
  uint32_t nNames = U32(dir + 24);
  uint32_t funcsRva = U32(dir + 28);
  uint32_t namesRva = U32(dir + 32);
  uint32_t ordsRva = U32(dir + 36);
  if (nNames == 0) return true;  // valid, just nothing named
  if (nFunctions > kMaxExports || nNames > kMaxExports) return false;
  if (!inImage(funcsRva, 4ull * nFunctions) || !inImage(namesRva, 4ull * nNames) ||
      !inImage(ordsRva, 2ull * nNames))
    return false;

  std::vector<uint8_t> funcs, names, ords;
  if (!ReadTable(read, base + funcsRva, nFunctions, 4, kMaxExports * 4, funcs)) return false;
  if (!ReadTable(read, base + namesRva, nNames, 4, kMaxExports * 4, names)) return false;
  if (!ReadTable(read, base + ordsRva, nNames, 2, kMaxExports * 2, ords)) return false;

  // Names normally sit inside the export directory block: read it once and
  // fall back to per-string reads for any name outside it.
  std::vector<uint8_t> block;
  bool haveBlock = pe.exportSize <= kMaxExportBlock && inImage(pe.exportRva, pe.exportSize) &&
                   ReadTable(read, base + pe.exportRva, pe.exportSize, 1, kMaxExportBlock, block);

  const uint64_t fwdStart = pe.exportRva, fwdEnd = (uint64_t)pe.exportRva + pe.exportSize;
  for (uint32_t i = 0; i < nNames; ++i) {
    uint16_t ord = U16(ords.data() + 2 * (size_t)i);
    if (ord >= nFunctions) continue;
    uint32_t funcRva = U32(funcs.data() + 4 * (size_t)ord);
    if (funcRva == 0) continue;
    if (funcRva >= fwdStart && funcRva < fwdEnd) continue;  // forwarder
    if (funcRva >= imageSize) continue;

    uint32_t nameRva = U32(names.data() + 4 * (size_t)i);
    std::string name;
    if (haveBlock && nameRva >= fwdStart && nameRva < fwdEnd) {
      size_t off = nameRva - fwdStart;
      const void* nul = memchr(block.data() + off, 0, block.size() - off);
      if (!nul) continue;
      name.assign((const char*)block.data() + off, (const char*)nul - (const char*)block.data() - off);
    } else {
      if (!inImage(nameRva, 1)) continue;
      if (!ReadCString(read, base + nameRva, name)) continue;
    }
    if (name.empty()) continue;
    out.emplace(name, base + funcRva);
  }
  return true;
}

// Every defined global/weak function and object in the ELF64 image at `base`
// (the address of its ELF header, i.e. the lowest mapping of the file) as
// name -> absolute address. Found through PT_DYNAMIC -> DT_SYMTAB/DT_STRTAB; the
// symbol count comes from DT_HASH, else DT_GNU_HASH, else the distance from
// .dynsym to .dynstr. False when the image is not a readable ELF64 with a
// dynamic symbol table.
inline bool ParseElfDynsym(const ReadFn& read, uintptr_t base,
                           std::map<std::string, uintptr_t>& out) {
  using namespace detail;
  out.clear();
  std::vector<uint8_t> ph;
  uint16_t phnum = 0;
  if (!ReadElfPhdrs(read, base, ph, phnum)) return false;

  bool haveLoad = false, haveDyn = false;
  uint64_t minVaddr = 0, dynVaddr = 0, dynSize = 0;
  for (uint16_t i = 0; i < phnum; ++i) {
    const uint8_t* p = ph.data() + 56 * (size_t)i;
    uint32_t ptype = U32(p);
    uint64_t vaddr = U64(p + 16), memsz = U64(p + 40);
    if (ptype == 1 /*PT_LOAD*/) {
      uint64_t v = vaddr & ~0xfffull;
      if (!haveLoad || v < minVaddr) minVaddr = v;
      haveLoad = true;
    } else if (ptype == 2 /*PT_DYNAMIC*/ && !haveDyn) {
      dynVaddr = vaddr;
      dynSize = memsz;
      haveDyn = true;
    }
  }
  if (!haveLoad || !haveDyn || dynSize < 16) return false;
  const uintptr_t bias = base - (uintptr_t)minVaddr;  // wraps harmlessly for ET_EXEC

  if (dynSize > kMaxDynamic) dynSize = kMaxDynamic;
  std::vector<uint8_t> dyn;
  if (!ReadTable(read, bias + (uintptr_t)dynVaddr, dynSize / 16, 16, kMaxDynamic, dyn)) return false;

  uint64_t symtab = 0, strtab = 0, strsz = 0, hash = 0, gnuHash = 0, versym = 0, syment = kElfSymSize;
  for (size_t i = 0; i + 16 <= dyn.size(); i += 16) {
    int64_t tag = (int64_t)U64(dyn.data() + i);
    uint64_t val = U64(dyn.data() + i + 8);
    if (tag == 0) break;  // DT_NULL
    switch (tag) {
      case 4: hash = val; break;
      case 5: strtab = val; break;
      case 6: symtab = val; break;
      case 10: strsz = val; break;
      case 11: syment = val; break;
      case 0x6ffffef5: gnuHash = val; break;
      case 0x6ffffff0: versym = val; break;  // DT_VERSYM
      default: break;
    }
  }
  if (symtab == 0 || strtab == 0 || syment != kElfSymSize) return false;

  // glibc rewrites these d_ptr values to absolute addresses in place; musl and
  // read-only .dynsection layouts leave them as link-time vaddrs.
  auto fix = [&](uint64_t v) -> uintptr_t {
    return v >= (uint64_t)base ? (uintptr_t)v : bias + (uintptr_t)v;
  };
  const uintptr_t symAddr = fix(symtab), strAddr = fix(strtab);

  uint64_t count = 0;
  if (hash != 0) {
    uint8_t h[8];
    if (!read(fix(hash), h, sizeof(h))) return false;
    count = U32(h + 4);  // nchain == number of symbols
  } else if (gnuHash != 0) {
    const uintptr_t gh = fix(gnuHash);
    uint8_t h[16];
    if (!read(gh, h, sizeof(h))) return false;
    uint32_t nbuckets = U32(h), symoffset = U32(h + 4), bloomSize = U32(h + 8);
    if (nbuckets == 0 || nbuckets > kMaxSymbols || bloomSize > kMaxSymbols) return false;
    const uintptr_t bucketsAddr = gh + 16 + 8 * (uintptr_t)bloomSize;
    std::vector<uint8_t> buckets;
    if (!ReadTable(read, bucketsAddr, nbuckets, 4, kMaxSymbols * 4, buckets)) return false;
    uint32_t maxBucket = 0;
    for (uint32_t i = 0; i < nbuckets; ++i) {
      uint32_t b = U32(buckets.data() + 4 * (size_t)i);
      if (b > maxBucket) maxBucket = b;
    }
    if (maxBucket < symoffset) {
      count = symoffset;
    } else {
      // Walk the chain of the highest bucket to its terminator (low bit set).
      const uintptr_t chainAddr = bucketsAddr + 4 * (uintptr_t)nbuckets;
      uint64_t idx = maxBucket;
      bool ended = false;
      for (uint32_t guard = 0; guard < kMaxSymbols; ++guard, ++idx) {
        uint8_t w[4];
        if (!read(chainAddr + 4 * (uintptr_t)(idx - symoffset), w, 4)) return false;
        if (U32(w) & 1) { ended = true; break; }
      }
      if (!ended) return false;
      count = idx + 1;
    }
  } else if (strAddr > symAddr) {
    count = (strAddr - symAddr) / kElfSymSize;  // .dynstr normally follows .dynsym
  }
  if (count == 0 || count > kMaxSymbols) return false;

  std::vector<uint8_t> syms;
  if (!ReadTable(read, symAddr, count, kElfSymSize, kMaxSymbols * kElfSymSize, syms)) return false;
  std::vector<uint8_t> strs;
  const bool bulkStrings = strsz > 0 && strsz <= kMaxStrtab &&
                           ReadTable(read, strAddr, strsz, 1, kMaxStrtab, strs);

  // DT_VERSYM: one uint16 per symbol; bit 15 marks a hidden (non-default,
  // "@" rather than "@@") version. Absent or unreadable: no versioning, first
  // definition of a name wins.
  std::vector<uint8_t> vers;
  if (versym != 0 && !ReadTable(read, fix(versym), count, 2, kMaxSymbols * 2, vers)) vers.clear();
  std::map<std::string, bool> hiddenOf;  // only used when vers is present
  std::set<std::string> ifuncDefault;

  for (uint64_t i = 1; i < count; ++i) {  // symbol 0 is the reserved null symbol
    const uint8_t* s = syms.data() + kElfSymSize * (size_t)i;
    uint32_t nameOff = U32(s);
    uint8_t info = s[4];
    uint16_t shndx = U16(s + 6);
    uint64_t value = U64(s + 8);
    uint8_t stype = info & 0xf, bind = info >> 4;
    if (shndx == 0 /*UNDEF*/ || shndx >= 0xff00 /*ABS, COMMON, reserved*/ || value == 0) continue;
    // NOTYPE/OBJECT/FUNC. STT_GNU_IFUNC (10) is excluded on purpose: its value is the
    // address of a resolver, and calling that is not calling the function (dlsym runs the
    // resolver; we cannot), so "not found" is the honest answer.
    if (stype != 0 && stype != 1 && stype != 2 && stype != 10) continue;
    const bool ifunc = stype == 10;
    if (bind != 1 && bind != 2 && bind != 10) continue;                    // GLOBAL/WEAK/UNIQUE
    std::string name;
    if (bulkStrings) {
      if (nameOff >= strs.size()) continue;
      const void* nul = memchr(strs.data() + nameOff, 0, strs.size() - nameOff);
      if (!nul) continue;
      name.assign((const char*)strs.data() + nameOff,
                  (const char*)nul - ((const char*)strs.data() + nameOff));
    } else if (!ReadCString(read, strAddr + nameOff, name)) {
      continue;
    }
    if (name.empty()) continue;
    const uintptr_t addr = bias + (uintptr_t)value;
    if (ifunc) {
      // A default IFUNC (memcpy@@GLIBC_2.14) also shadows any older plain
      // definition of the name (memcpy@GLIBC_2.2.5): drop the name altogether, since
      // returning the compat one is not what dlsym gives.
      if (!vers.empty() && (U16(vers.data() + 2 * (size_t)i) & 0x8000) == 0) ifuncDefault.insert(name);
      continue;
    }
    if (vers.empty()) {
      out.emplace(name, addr);
      continue;
    }
    // Several versions of one name (memcpy@GLIBC_2.2.5 then memcpy@@GLIBC_2.14):
    // the default (non-hidden) one wins, as in dlsym, wherever it sits in .dynsym.
    const bool hidden = (U16(vers.data() + 2 * (size_t)i) & 0x8000) != 0;
    auto it = hiddenOf.find(name);
    if (it == hiddenOf.end()) {
      hiddenOf.emplace(name, hidden);
      out[name] = addr;
    } else if (it->second && !hidden) {
      it->second = false;
      out[name] = addr;
    }
  }
  for (const std::string& n : ifuncDefault) out.erase(n);
  return true;
}

// Size of the loaded ELF64 image at `base` as the program headers say:
// max(p_vaddr + p_memsz) over PT_LOAD minus the lowest PT_LOAD page, rounded up to a page. Unlike the
// file-backed mappings it includes .bss, which the kernel maps anonymously past
// the file pages. False when the headers are unreadable or insane.
inline bool ElfImageExtent(const ReadFn& read, uintptr_t base, uint64_t& size) {
  using namespace detail;
  std::vector<uint8_t> ph;
  uint16_t phnum = 0;
  if (!ReadElfPhdrs(read, base, ph, phnum)) return false;
  bool haveLoad = false;
  uint64_t lo = 0, hi = 0;
  for (uint16_t i = 0; i < phnum; ++i) {
    const uint8_t* p = ph.data() + 56 * (size_t)i;
    if (U32(p) != 1 /*PT_LOAD*/) continue;
    uint64_t vaddr = U64(p + 16), memsz = U64(p + 40);
    if (memsz > kMaxImageSize || vaddr > kMaxImageSize * 4096) return false;
    uint64_t start = vaddr & ~0xfffull, end = vaddr + memsz;
    if (!haveLoad || start < lo) lo = start;
    if (!haveLoad || end > hi) hi = end;
    haveLoad = true;
  }
  if (!haveLoad || hi <= lo || hi - lo > kMaxImageSize) return false;
  size = (hi - lo + 0xfff) & ~0xfffull;  // whole pages, as the kernel maps it (and SizeOfImage is)
  return true;
}

// What ListModules and ListModuleRanges both need to know about a file's lowest
// mapping, computed once so the two cannot disagree.
struct MeasuredImage {
  ImageKind kind = ImageKind::Unknown;
  uint64_t size = 0;       // PE SizeOfImage, or ELF extent; the file span if headers fail
  uint32_t timestamp = 0;  // PE TimeDateStamp, 0 for ELF
  bool headersOk = false;  // the PE/ELF headers parsed
};

// `fileSpan` is the span of the file's mappings, the fallback size.
inline MeasuredImage MeasureImage(const ReadFn& read, uintptr_t base, uint64_t fileSpan) {
  MeasuredImage m;
  m.kind = DetectImage(read, base);
  m.size = fileSpan;
  if (m.kind == ImageKind::Pe) {
    PeHeaders pe;
    if (ParsePeHeaders(read, base, pe)) {
      m.headersOk = true;
      m.timestamp = pe.timestamp;
      if (pe.sizeOfImage != 0) m.size = pe.sizeOfImage;
    }
  } else if (m.kind == ImageKind::Elf) {
    uint64_t extent = 0;
    if (ElfImageExtent(read, base, extent)) {
      m.headersOk = true;
      m.size = extent;
    }
  }
  return m;
}

}  // namespace linuxmod
