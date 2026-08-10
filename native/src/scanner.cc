#include "scanner.h"
#include "value_type.h"
#include <windows.h>
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>
#include <cmath>

namespace {

// Prevents an unbounded-memory crash on a narrow/common value (worst case:
// int8 stride-1 scanning for 0 or 1 against a multi-GB process can produce
// hundreds of millions of matches otherwise). The UI's job is to tell the
// user to narrow further; this cap is what keeps that possible instead of
// OOMing before the user ever sees a result.
constexpr size_t kMaxScanResults = 1'000'000;

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
      std::vector<uint8_t> buffer(mbi.RegionSize);
      SIZE_T bytesRead = 0;
      if (ReadProcessMemory(h, mbi.BaseAddress, buffer.data(), mbi.RegionSize, &bytesRead)) {
        uintptr_t base = (uintptr_t)mbi.BaseAddress;
        for (SIZE_T offset = 0; offset + spec.size <= bytesRead; offset += stride) {
          double value = InterpretAsDouble(buffer.data() + offset, spec);
          if (ValuesEqual(value, target, isFloat)) {
            out.push_back({base + offset, value});
            if (out.size() >= kMaxScanResults) break;
          }
        }
      }
      // A whole-region read can legitimately fail (e.g. protection changed
      // between VirtualQueryEx and ReadProcessMemory) — skip that region
      // rather than falling back to a per-address read, which is what made
      // scanning slow enough to look hung against a real game process.
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

  void Execute() override { results_ = RunScanFirst(handle_, spec_, target_); }

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
  // Each candidate carries its own previously-known value (from the last
  // scanFirst/scanNext call), so relative filters (changed/increased/...)
  // compare each address against its OWN prior value rather than a single
  // value broadcast across every candidate — which would be wrong for any
  // candidates whose values have diverged from each other since the last
  // scan.
  Napi::Array candidates = info[1].As<Napi::Array>();
  std::string dataType = info[2].As<Napi::String>().Utf8Value();
  auto specOpt = SpecForDataType(dataType);
  if (!specOpt) {
    Napi::Error::New(env, "dataType must be one of int8, int16, int32, int64, float, double")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  ValueSpec spec = *specOpt;
  bool isFloat = IsFloatKind(spec.kind);
  Napi::Object filter = info[3].As<Napi::Object>();
  std::string mode = filter.Get("mode").As<Napi::String>().Utf8Value();

  Napi::Array result = Napi::Array::New(env);
  uint32_t count = 0;

  for (uint32_t i = 0; i < candidates.Length(); i++) {
    Napi::Object candidate = candidates.Get(i).As<Napi::Object>();
    uintptr_t addr = ParseHex(candidate.Get("address").As<Napi::String>().Utf8Value());
    double current;
    if (!ReadValueAsDouble(h, addr, spec, &current)) continue;

    bool keep = false;
    if (mode == "exact") {
      double target = filter.Get("value").As<Napi::Number>().DoubleValue();
      keep = ValuesEqual(current, target, isFloat);
    } else {
      double previous = candidate.Get("value").As<Napi::Number>().DoubleValue();
      if (mode == "changed") keep = !ValuesEqual(current, previous, isFloat);
      else if (mode == "unchanged") keep = ValuesEqual(current, previous, isFloat);
      else if (mode == "increased") keep = current > previous;
      else if (mode == "decreased") keep = current < previous;
    }

    if (keep) {
      Napi::Object item = Napi::Object::New(env);
      item.Set("address", Napi::String::New(env, ToHex(addr)));
      item.Set("value", Napi::Number::New(env, current));
      result.Set(count++, item);
    }
  }

  return result;
}
