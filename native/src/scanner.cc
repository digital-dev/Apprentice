#include "scanner.h"
#include "value_type.h"
#include <windows.h>
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <algorithm>
#include <exception>

namespace {

// Prevents an unbounded-memory crash on a narrow/common value (worst case:
// int8 stride-1 scanning for 0 or 1 against a multi-GB process can produce
// hundreds of millions of matches otherwise). The UI's job is to tell the
// user to narrow further; this cap is what keeps that possible instead of
// OOMing before the user ever sees a result.
constexpr size_t kMaxScanResults = 1'000'000;

// Never allocate a whole region in one shot: a single multi-GB committed
// region (routine in a real game) would otherwise allocate multi-GB inside
// Apprentice's own process just to scan it. Regions are read in fixed-size
// chunks instead.
//
// Chunking is only safe if it can't miss a value that straddles a chunk
// boundary, so the scheme below is deliberately explicit about which chunk
// "owns" which start positions:
//
//   chunk i OWNS the start offsets [i*kChunkSize, i*(kChunkSize)+scanSpan)
//   chunk i READS [i*kChunkSize, i*kChunkSize + scanSpan + (width-1))
//
// The owned ranges exactly partition [0, regionSize), so every start offset
// belongs to exactly one chunk (no misses, no duplicates). The read extends
// (width - 1) bytes past the owned range — clamped to the region end — so a
// value STARTING at the last owned offset is still fully present in the
// buffer. Both properties are independent of the stride.
//
// kChunkSize is also a multiple of 8 (the widest stride/value in use here
// and in pointer.cc), so an aligned stride stays in phase across chunk
// boundaries: chunk i's owned range starts at a multiple of the stride
// relative to the region base, so iterating 0, stride, 2*stride, ... within
// the chunk hits exactly the region-global strided positions.
constexpr size_t kChunkSize = 4 * 1024 * 1024;
static_assert(kChunkSize % 8 == 0, "kChunkSize must be a multiple of the widest scan stride");

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

std::string ToHex(uintptr_t addr) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)addr);
  return buf;
}

// Float equality after a game tick can differ by tiny rounding error even
// when "the same" value was written, so float/double comparisons use a
// small epsilon; every integer width compares exact.
bool ValuesEqual(double a, double b, bool isFloat) {
  if (isFloat) return std::abs(a - b) < 0.0001;
  return a == b;
}

bool ReadValueAsDouble(HANDLE h, uintptr_t addr, const ValueSpec& spec, double* out) {
  uint8_t buf[8]; // widest supported type (int64/double) is 8 bytes
  SIZE_T read;
  if (!ReadProcessMemory(h, (LPCVOID)addr, buf, spec.size, &read) || read != spec.size)
    return false;
  *out = InterpretAsDouble(buf, spec);
  return true;
}

struct AddressValue {
  uintptr_t address;
  double value;
};

// The actual memory walk, kept free of any Napi:: types so it's safe to run
// on a background thread (see ScanFirstWorker below) — Napi::Env/Value are
// not thread-safe and must only be touched on the JS thread.
std::vector<AddressValue> RunScanFirst(HANDLE h, const ValueSpec& spec, double target) {
  std::vector<AddressValue> out;
  bool isFloat = IsFloatKind(spec.kind);
  // Cheat Engine convention: scan on 4-byte alignment regardless of value
  // width, so 8-byte types (int64/double) aren't missed when they sit at a
  // non-8-byte-aligned offset inside an otherwise-aligned struct. Narrow
  // types keep their natural stride.
  size_t stride = spec.size <= 4 ? spec.size : 4;

  MEMORY_BASIC_INFORMATION mbi;
  uintptr_t addr = 0;
  while (out.size() < kMaxScanResults &&
         VirtualQueryEx(h, (LPCVOID)addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
    bool readable = (mbi.State == MEM_COMMIT) &&
        (mbi.Protect & (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE)) &&
        !(mbi.Protect & PAGE_GUARD);

    if (readable && mbi.RegionSize >= spec.size) {
      const size_t regionSize = (size_t)mbi.RegionSize;
      const uintptr_t regionBase = (uintptr_t)mbi.BaseAddress;
      // A value starting at the last offset this chunk owns runs
      // (spec.size - 1) bytes past the chunk — read that tail too, so a
      // boundary-straddling value is complete in the buffer instead of
      // being silently dropped. (Relevant for real: int64/double are 8
      // bytes but scan on a 4-byte stride, so a value CAN start 4 bytes
      // before a chunk boundary and finish after it.)
      const size_t overlap = spec.size - 1;
      std::vector<uint8_t> buffer(std::min(regionSize, kChunkSize + overlap));

      for (size_t chunkOffset = 0; chunkOffset < regionSize; chunkOffset += kChunkSize) {
        const size_t scanSpan = std::min(kChunkSize, regionSize - chunkOffset);
        const size_t readLen = std::min(kChunkSize + overlap, regionSize - chunkOffset);
        SIZE_T bytesRead = 0;
        // A chunk read can legitimately fail (e.g. protection changed
        // between VirtualQueryEx and ReadProcessMemory) — skip that chunk
        // rather than falling back to a per-address read, which is what
        // made scanning slow enough to look hung against a real game.
        if (!ReadProcessMemory(h, (LPCVOID)(regionBase + chunkOffset), buffer.data(), readLen,
                               &bytesRead)) {
          continue;
        }
        for (size_t offset = 0; offset < scanSpan && offset + spec.size <= bytesRead;
             offset += stride) {
          double value = InterpretAsDouble(buffer.data() + offset, spec);
          if (ValuesEqual(value, target, isFloat)) {
            out.push_back({regionBase + chunkOffset + offset, value});
            if (out.size() >= kMaxScanResults) break;
          }
        }
        if (out.size() >= kMaxScanResults) break;
      }
    }

    uintptr_t next = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
    if (next <= addr) break; // guard against non-advancing regions
    addr = next;
  }

  return out;
}

// Runs RunScanFirst on a libuv worker thread instead of the main JS thread.
// scanFirst walks the whole process's committed memory, which even after
// the bulk-read optimization can take real wall-clock time against a large
// real game process — running it synchronously on the main thread blocks
// the ENTIRE Electron app (not just this call) for that whole duration,
// which is indistinguishable from a hang to the user.
class ScanFirstWorker : public Napi::AsyncWorker {
 public:
  ScanFirstWorker(Napi::Env env, HANDLE handle, ValueSpec spec, double target)
      : Napi::AsyncWorker(env),
        handle_(handle),
        spec_(spec),
        target_(target),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // binding.gyp defines NAPI_DISABLE_CPP_EXCEPTIONS, so node-addon-api does
  // NOT wrap Execute() in a try/catch — an escaped C++ exception here (a
  // std::bad_alloc from the per-chunk buffer being the realistic one) calls
  // std::terminate on a libuv worker thread and kills the whole Electron
  // process. SetError routes to the OnError below instead, rejecting the
  // promise. Pure safety net: the success path is unchanged.
  void Execute() override {
    try {
      results_ = RunScanFirst(handle_, spec_, target_);
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error during scanFirst");
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array result = Napi::Array::New(env, results_.size());
    for (size_t i = 0; i < results_.size(); i++) {
      Napi::Object item = Napi::Object::New(env);
      item.Set("address", Napi::String::New(env, ToHex(results_[i].address)));
      item.Set("value", Napi::Number::New(env, results_[i].value));
      result.Set((uint32_t)i, item);
    }
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  HANDLE handle_;
  ValueSpec spec_;
  double target_;
  std::vector<AddressValue> results_;
  Napi::Promise::Deferred deferred_;
};

// Runs on a background thread via ScanNextWorker below — must not touch any
// Napi:: type, for the same reason RunScanFirst doesn't. Each candidate
// carries its own previously-known value (from the last scanFirst/scanNext
// call), so relative filters (changed/increased/...) compare each address
// against its OWN prior value rather than a single value broadcast across
// every candidate — which would be wrong for any candidates whose values have
// diverged from each other since the last scan.
std::vector<AddressValue> RunScanNext(
    HANDLE h, const std::vector<AddressValue>& candidates, const ValueSpec& spec,
    const std::string& mode, double filterValue) {
  std::vector<AddressValue> out;
  bool isFloat = IsFloatKind(spec.kind);
  for (const auto& candidate : candidates) {
    double current;
    if (!ReadValueAsDouble(h, candidate.address, spec, &current)) continue;
    bool keep = false;
    if (mode == "exact") {
      keep = ValuesEqual(current, filterValue, isFloat);
    } else {
      if (mode == "changed") keep = !ValuesEqual(current, candidate.value, isFloat);
      else if (mode == "unchanged") keep = ValuesEqual(current, candidate.value, isFloat);
      else if (mode == "increased") keep = current > candidate.value;
      else if (mode == "decreased") keep = current < candidate.value;
    }
    if (keep) out.push_back({candidate.address, current});
  }
  return out;
}

// Same rationale as ScanFirstWorker: scanNext issues one ReadProcessMemory
// syscall per candidate, and an under-narrowed first scan can leave hundreds
// of thousands of candidates — running that synchronously froze the entire
// Electron app for the duration of every next-scan filter click.
class ScanNextWorker : public Napi::AsyncWorker {
 public:
  ScanNextWorker(Napi::Env env, HANDLE h, std::vector<AddressValue> candidates,
                 ValueSpec spec, std::string mode, double filterValue)
      : Napi::AsyncWorker(env),
        h_(h),
        candidates_(std::move(candidates)),
        spec_(spec),
        mode_(std::move(mode)),
        filterValue_(filterValue),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // Same NAPI_DISABLE_CPP_EXCEPTIONS reasoning as ScanFirstWorker::Execute.
  void Execute() override {
    try {
      results_ = RunScanNext(h_, candidates_, spec_, mode_, filterValue_);
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error during scanNext");
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array result = Napi::Array::New(env, results_.size());
    for (size_t i = 0; i < results_.size(); i++) {
      Napi::Object item = Napi::Object::New(env);
      item.Set("address", Napi::String::New(env, ToHex(results_[i].address)));
      item.Set("value", Napi::Number::New(env, results_[i].value));
      result.Set((uint32_t)i, item);
    }
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  HANDLE h_;
  std::vector<AddressValue> candidates_;
  ValueSpec spec_;
  std::string mode_;
  double filterValue_;
  std::vector<AddressValue> results_;
  Napi::Promise::Deferred deferred_;
};

} // namespace

Napi::Value ScanFirst(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  std::string dataType = info[1].As<Napi::String>().Utf8Value();
  auto specOpt = SpecForDataType(dataType);
  if (!specOpt) {
    Napi::Error::New(env, "dataType must be one of int8, int16, int32, int64, float, double")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  double target = info[2].As<Napi::Number>().DoubleValue();

  auto* worker = new ScanFirstWorker(env, h, *specOpt, target);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value ScanNext(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  Napi::Array jsCandidates = info[1].As<Napi::Array>();
  std::string dataType = info[2].As<Napi::String>().Utf8Value();
  auto specOpt = SpecForDataType(dataType);
  if (!specOpt) {
    Napi::Error::New(env, "dataType must be one of int8, int16, int32, int64, float, double")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object filter = info[3].As<Napi::Object>();
  std::string mode = filter.Get("mode").As<Napi::String>().Utf8Value();
  double filterValue = mode == "exact" ? filter.Get("value").As<Napi::Number>().DoubleValue() : 0.0;

  // Every Napi:: handle is bound to the JS thread's Env, so the candidate
  // array is converted to plain C++ AddressValues HERE, on the JS thread,
  // before the worker is queued — Execute() must never see a Napi:: type.
  std::vector<AddressValue> candidates;
  candidates.reserve(jsCandidates.Length());
  for (uint32_t i = 0; i < jsCandidates.Length(); i++) {
    Napi::Object c = jsCandidates.Get(i).As<Napi::Object>();
    candidates.push_back({ParseHex(c.Get("address").As<Napi::String>().Utf8Value()),
                          c.Get("value").As<Napi::Number>().DoubleValue()});
  }

  auto* worker = new ScanNextWorker(env, h, std::move(candidates), *specOpt, mode, filterValue);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}
