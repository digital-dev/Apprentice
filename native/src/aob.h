#pragma once
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

// A parsed AOB pattern: one entry per byte. `wildcard` entries match any
// byte ("??" in the signature text).
struct PatternByte {
  uint8_t value;
  bool wildcard;
};

inline bool ParseSignature(const std::string& sig, std::vector<PatternByte>& out) {
  out.clear();
  size_t i = 0;
  while (i < sig.size()) {
    if (sig[i] == ' ') { i++; continue; }
    if (i + 1 >= sig.size()) return false;
    if (sig[i] == '?' && sig[i + 1] == '?') {
      out.push_back({0, true});
    } else {
      char buf[3] = {sig[i], sig[i + 1], 0};
      char* end = nullptr;
      unsigned long v = strtoul(buf, &end, 16);
      if (end != buf + 2) return false;
      out.push_back({static_cast<uint8_t>(v), false});
    }
    i += 2;
  }
  return !out.empty();
}
