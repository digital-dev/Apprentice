#include "patch_ops.h"
#include "protected_write.h"
#include <windows.h>
#include <string>
#include <vector>
#include <cstdint>
#include <cstdio>
#include <cctype>
#include <algorithm>
#include <exception>

namespace {

// Never allocate a whole region in one shot — see the chunking note in
// scanner.cc for the scheme. Here the "value width" is the pattern length
// and the stride is 1 byte, so a match genuinely CAN straddle a chunk
// boundary: the (plen - 1) read overlap past each chunk's owned start
// offsets is what keeps those matches findable.
constexpr size_t kChunkSize = 4 * 1024 * 1024;

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

std::string BytesToHex(const uint8_t* data, size_t len) {
  std::string out;
  char hb[4];
  for (size_t i = 0; i < len; i++) {
    snprintf(hb, sizeof(hb), "%02x", data[i]);
    out += hb;
  }
  return out;
}

// Decodes one hex digit strictly ('0'-'9', 'a'-'f', 'A'-'F' only). Returns
// -1 for anything else so the caller can reject the whole string instead
// of silently accepting it.
int HexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
  if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
  return -1;
}

// Unspaced hex ("4883ec20") -> bytes. Returns false on odd length, an empty
// string, or any character that is not a strict hex digit, so a malformed
// patch never reaches WriteProcessMemory. Decoded by nibble rather than via
// strtoul: strtoul skips leading whitespace and accepts a sign, which would
// let inputs like " a", "+1", or "-1" (negated and truncated to 0xff) slip
// through as if they were valid byte pairs.
bool HexToBytes(const std::string& hex, std::vector<uint8_t>& out) {
  if (hex.size() % 2 != 0 || hex.empty()) return false;
  out.clear();
  for (size_t i = 0; i < hex.size(); i += 2) {
    int hi = HexNibble(hex[i]);
    int lo = HexNibble(hex[i + 1]);
    if (hi < 0 || lo < 0) return false;
    out.push_back(static_cast<uint8_t>((hi << 4) | lo));
  }
  return true;
}

std::string ToHexAddr(uintptr_t addr) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)addr);
  return buf;
}

// A parsed AOB pattern: one entry per byte. `wildcard` entries match any
// byte ("??" in the signature text).
struct PatternByte {
  uint8_t value;
  bool wildcard;
};

bool ParseSignature(const std::string& sig, std::vector<PatternByte>& out) {
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

// Walk committed executable memory looking for the pattern. Only
// executable regions are searched: a code patch targets an instruction, and
// skipping the (much larger) data regions keeps this fast. Bare
// PAGE_EXECUTE is excluded because it isn't readable, so ReadProcessMemory
// would fail on it anyway. One bulk read per region, same as the value
// scanner — a per-address read is what made earlier scans look hung.
// `rangeStart`/`rangeEnd` are inclusive-exclusive bounds. rangeEnd == 0
// means "no upper bound", which is how an unbounded call arrives here — the
// existing behaviour, byte for byte.
std::vector<uintptr_t> RunScanAob(HANDLE h, const std::vector<PatternByte>& pattern,
                                   uintptr_t rangeStart, uintptr_t rangeEnd) {
  std::vector<uintptr_t> out;
  const size_t plen = pattern.size();
  // `overlap = plen - 1` below is size_t arithmetic, so an empty pattern
  // would wrap to SIZE_MAX and turn the chunk loop into nonsense. Not
  // reachable today (HexToBytes rejects an empty signature before we get
  // here), but this function should not depend on a caller-side check for
  // its own memory safety — the sibling scanners in scanner.cc/pointer.cc
  // pin their equivalent invariant with a static_assert; this one is a
  // runtime size, so it gets a runtime guard.
  if (plen == 0) return out;

  MEMORY_BASIC_INFORMATION mbi;
  uintptr_t addr = rangeStart;
  while (VirtualQueryEx(h, (LPCVOID)addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
    uintptr_t regionBase = (uintptr_t)mbi.BaseAddress;
    if (rangeEnd != 0 && regionBase >= rangeEnd) break;

    bool executable = (mbi.State == MEM_COMMIT) &&
        (mbi.Protect & (PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)) &&
        !(mbi.Protect & PAGE_GUARD);

    if (executable && mbi.RegionSize >= plen) {
      const size_t regionSize = (size_t)mbi.RegionSize;
      const size_t overlap = plen - 1;
      std::vector<uint8_t> buffer(std::min(regionSize, kChunkSize + overlap));

      for (size_t chunkOffset = 0; chunkOffset < regionSize; chunkOffset += kChunkSize) {
        // Chunk owns start offsets [chunkOffset, chunkOffset + scanSpan);
        // reads (plen - 1) further so a match starting at the last owned
        // offset is still complete in the buffer.
        const size_t scanSpan = std::min(kChunkSize, regionSize - chunkOffset);
        const size_t readLen = std::min(kChunkSize + overlap, regionSize - chunkOffset);
        SIZE_T bytesRead = 0;
        if (!ReadProcessMemory(h, (LPCVOID)(regionBase + chunkOffset), buffer.data(), readLen,
                               &bytesRead) ||
            bytesRead < plen) {
          continue;
        }
        for (size_t offset = 0; offset < scanSpan && offset + plen <= bytesRead; offset++) {
          bool match = true;
          for (size_t k = 0; k < plen; k++) {
            if (pattern[k].wildcard) continue;
            if (buffer[offset + k] != pattern[k].value) { match = false; break; }
          }
          if (match) {
            uintptr_t hit = regionBase + chunkOffset + offset;
            if (hit >= rangeStart && (rangeEnd == 0 || hit + plen <= rangeEnd)) {
              out.push_back(hit);
            }
          }
        }
      }
    }

    uintptr_t next = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
    if (next <= addr) break; // guard against non-advancing regions
    addr = next;
  }
  return out;
}

// Same reasoning as ScanFirstWorker in scanner.cc: this walks a real game's
// whole executable memory, so it runs on a libuv worker thread rather than
// blocking the entire Electron app.
class ScanAobWorker : public Napi::AsyncWorker {
 public:
  ScanAobWorker(Napi::Env env, HANDLE handle, std::vector<PatternByte> pattern,
                uintptr_t rangeStart, uintptr_t rangeEnd)
      : Napi::AsyncWorker(env),
        handle_(handle),
        pattern_(std::move(pattern)),
        rangeStart_(rangeStart),
        rangeEnd_(rangeEnd),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // binding.gyp defines NAPI_DISABLE_CPP_EXCEPTIONS, so node-addon-api does
  // NOT wrap Execute() in a try/catch — an escaped C++ exception here (a
  // std::bad_alloc from the per-chunk buffer being the realistic one) calls
  // std::terminate on a libuv worker thread and kills the whole Electron
  // process. SetError routes to OnError below instead, rejecting the
  // promise. Pure safety net: the success path is unchanged.
  void Execute() override {
    try {
      results_ = RunScanAob(handle_, pattern_, rangeStart_, rangeEnd_);
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error during scanAob");
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array result = Napi::Array::New(env, results_.size());
    for (size_t i = 0; i < results_.size(); i++) {
      result.Set((uint32_t)i, Napi::String::New(env, ToHexAddr(results_[i])));
    }
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  HANDLE handle_;
  std::vector<PatternByte> pattern_;
  uintptr_t rangeStart_;
  uintptr_t rangeEnd_;
  std::vector<uintptr_t> results_;
  Napi::Promise::Deferred deferred_;
};

} // namespace

Napi::Value ReadBytes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());
  size_t length = static_cast<size_t>(info[2].As<Napi::Number>().Uint32Value());
  // ToBoolean() coerces rather than throwing, so a caller that explicitly
  // passes `undefined` as the 4th arg (no current caller does, but nothing
  // stops one) still resolves to false instead of raising.
  bool raw = info.Length() > 3 && info[3].ToBoolean().Value();

  // Raised from 64 to 4096: the memory viewer requests one 256-byte page
  // per poll tick, well under this cap; 4096 remains a safety bound
  // against a malformed call, not a real constraint on any caller.
  if (length == 0 || length > 4096) {
    Napi::Error::New(env, "readBytes length must be 1..4096").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::vector<uint8_t> buffer(length);
  SIZE_T read = 0;
  if (!ReadProcessMemory(h, (LPCVOID)address, buffer.data(), length, &read) || read != length) {
    Napi::Error::New(env, "ReadProcessMemory failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (raw) {
    return Napi::Buffer<uint8_t>::Copy(env, buffer.data(), length);
  }
  return Napi::String::New(env, BytesToHex(buffer.data(), length));
}

// Writing into a live process's CODE, which normally sits on read-execute
// pages: temporarily make the page writable, write, put the original
// protection back, then flush the target's instruction cache so the CPU
// doesn't keep executing a stale cached copy of the bytes we just changed.
// See protected_write.h's ProtectedCodeWrite for the full dance (including
// why a range that straddles a page boundary is refused rather than
// silently mishandled) — this addon only ever patches a single captured
// instruction, so that refusal should never trigger in normal use. Data
// writers use ProtectedDataWrite instead, which handles a straddle per
// page rather than refusing it.
Napi::Value WriteBytes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());
  std::string hex = info[2].As<Napi::String>().Utf8Value();

  std::vector<uint8_t> bytes;
  if (!HexToBytes(hex, bytes)) return Napi::Boolean::New(env, false);

  bool ok = ProtectedCodeWrite(h, address, bytes.data(), bytes.size());
  return Napi::Boolean::New(env, ok);
}

Napi::Value ScanAob(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  std::string signature = info[1].As<Napi::String>().Utf8Value();

  std::vector<PatternByte> pattern;
  if (!ParseSignature(signature, pattern)) {
    Napi::Error::New(env, "malformed AOB signature").ThrowAsJavaScriptException();
    return env.Null();
  }

  uintptr_t rangeStart = 0, rangeEnd = 0;
  if (info.Length() >= 3 && info[2].IsString()) rangeStart = ParseHex(info[2].As<Napi::String>().Utf8Value());
  if (info.Length() >= 4 && info[3].IsString()) rangeEnd = ParseHex(info[3].As<Napi::String>().Utf8Value());

  auto* worker = new ScanAobWorker(env, h, std::move(pattern), rangeStart, rangeEnd);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}
