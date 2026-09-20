#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

// Where the signature builder reads code from. Two implementations: a live
// process (write_watch.cc) and a recorded snapshot (snapshot_ops.cc), so the
// same builder can be regression-tested against recorded games offline.
class SigMemory {
 public:
  virtual ~SigMemory() = default;
  // Copies up to `len` bytes at `addr` into `buf`; returns how many were
  // copied (0 = unreadable). A short count is the signal that the read hit
  // the end of a region.
  virtual size_t Read(uintptr_t addr, uint8_t* buf, size_t len) const = 0;
  // Base address of the memory region containing `addr`; false if unknown.
  virtual bool RegionBase(uintptr_t addr, uintptr_t& base) const = 0;
};

struct SigResult {
  std::string signature;         // space-separated "48 89 ??" tokens
  uint32_t signatureOffset = 0;  // pattern bytes that precede the instruction
};

// `insn`/`insnLen` are the caught instruction's own bytes, used as the
// fallback signature when the surrounding window cannot be read.
SigResult BuildSignature(const SigMemory& mem, uintptr_t insnAddr,
                         const uint8_t* insn, size_t insnLen);
