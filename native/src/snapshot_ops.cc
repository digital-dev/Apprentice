#include "snapshot_ops.h"
#include "aob.h"
#include "cave_ops.h"
#include "sigbuild.h"
#include "platform/platform.h"
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

std::string ToHex(uintptr_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}
uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

// A contiguous run of recorded bytes. `data` borrows a JS Buffer, which stays
// alive for the duration of the synchronous call that parsed it.
struct Seg {
  uintptr_t start = 0;
  const uint8_t* data = nullptr;
  size_t size = 0;
};

// One recorded executable region plus the readable margins around it. The
// margins exist for fidelity, not for scanning: the signature builder reads a
// window that starts before the instruction and runs past it, and a live read
// of that window crosses region boundaries into neighbouring readable memory
// (all-or-nothing). Without the margins a site near a region edge would take
// the builder's "window unreadable" fallback here and not there.
struct SnapRegion {
  Seg body;
  Seg pre;   // bytes ending at body.start, absent when unreadable when recorded
  Seg post;  // bytes starting at body.start + body.size, likewise
};

std::vector<SnapRegion> ParseRegions(const Napi::Value& v) {
  std::vector<SnapRegion> out;
  if (!v.IsArray()) {
    Napi::TypeError::New(v.Env(), "regions must be an array").ThrowAsJavaScriptException();
    return out;
  }
  Napi::Array arr = v.As<Napi::Array>();
  for (uint32_t i = 0; i < arr.Length(); i++) {
    Napi::Value item = arr.Get(i);
    if (!item.IsObject()) continue;
    Napi::Object o = item.As<Napi::Object>();
    Napi::Value base = o.Get("base");
    Napi::Value bytes = o.Get("bytes");
    if (!base.IsString() || !bytes.IsBuffer()) {
      Napi::TypeError::New(v.Env(), "each region needs { base: string, bytes: Buffer }")
          .ThrowAsJavaScriptException();
      return out;
    }
    Napi::Buffer<uint8_t> buf = bytes.As<Napi::Buffer<uint8_t>>();
    SnapRegion r;
    r.body = {ParseHex(base.As<Napi::String>().Utf8Value()), buf.Data(), buf.Length()};
    Napi::Value pre = o.Get("pre");
    if (pre.IsBuffer()) {
      Napi::Buffer<uint8_t> p = pre.As<Napi::Buffer<uint8_t>>();
      r.pre = {r.body.start - p.Length(), p.Data(), p.Length()};
    }
    Napi::Value post = o.Get("post");
    if (post.IsBuffer()) {
      Napi::Buffer<uint8_t> p = post.As<Napi::Buffer<uint8_t>>();
      r.post = {r.body.start + r.body.size, p.Data(), p.Length()};
    }
    out.push_back(r);
  }
  std::sort(out.begin(), out.end(), [](const SnapRegion& a, const SnapRegion& b) {
    return a.body.start < b.body.start;
  });
  return out;
}

const SnapRegion* FindRegion(const std::vector<SnapRegion>& regions, uintptr_t addr) {
  for (const SnapRegion& r : regions) {
    if (addr >= r.body.start && addr - r.body.start < r.body.size) return &r;
  }
  return nullptr;
}

// The recorded segment (body or margin) holding `addr`, or null.
const Seg* FindSeg(const std::vector<SnapRegion>& regions, uintptr_t addr) {
  for (const SnapRegion& r : regions) {
    for (const Seg* s : {&r.body, &r.pre, &r.post}) {
      if (s->data && addr >= s->start && addr - s->start < s->size) return s;
    }
  }
  return nullptr;
}

class SnapSigMemory : public SigMemory {
 public:
  explicit SnapSigMemory(const std::vector<SnapRegion>& regions) : regions_(regions) {}
  // All-or-nothing, like the ReadProcessMemory the live adapter wraps: a
  // range that touches any byte we did not record reads as unreadable.
  size_t Read(uintptr_t addr, uint8_t* buf, size_t len) const override {
    size_t done = 0;
    while (done < len) {
      const Seg* s = FindSeg(regions_, addr + done);
      if (!s) return 0;
      const size_t off = (size_t)(addr + done - s->start);
      const size_t n = std::min(len - done, s->size - off);
      std::memcpy(buf + done, s->data + off, n);
      done += n;
    }
    return len;
  }
  bool RegionBase(uintptr_t addr, uintptr_t& base) const override {
    const SnapRegion* r = FindRegion(regions_, addr);
    if (!r) return false;
    base = r->body.start;
    return true;
  }

 private:
  const std::vector<SnapRegion>& regions_;
};

} // namespace

Napi::Value SnapshotBuildSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<SnapRegion> regions = ParseRegions(info[0]);
  if (env.IsExceptionPending()) return env.Null();
  const uintptr_t insnAddr = ParseHex(info[1].As<Napi::String>().Utf8Value());
  const size_t insnLen = (size_t)info[2].As<Napi::Number>().Uint32Value();

  SnapSigMemory mem(regions);
  std::vector<uint8_t> insn(insnLen);
  const size_t got = insnLen ? mem.Read(insnAddr, insn.data(), insnLen) : 0;
  if (got == 0) return env.Null();

  SigResult sig = BuildSignature(mem, insnAddr, insn.data(), got);
  Napi::Object result = Napi::Object::New(env);
  result.Set("signature", Napi::String::New(env, sig.signature));
  result.Set("signatureOffset", Napi::Number::New(env, sig.signatureOffset));
  return result;
}

Napi::Value SnapshotScanAob(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<SnapRegion> regions = ParseRegions(info[0]);
  if (env.IsExceptionPending()) return env.Null();
  std::vector<PatternByte> pattern;
  if (!ParseSignature(info[1].As<Napi::String>().Utf8Value(), pattern)) {
    Napi::Error::New(env, "invalid signature").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::vector<uintptr_t> hits;
  const size_t plen = pattern.size();
  for (const SnapRegion& r : regions) {
    // Margins are not searched: a live scan covers executable regions only,
    // and a match must lie fully inside one region.
    const Seg& b = r.body;
    if (b.size < plen) continue;
    for (size_t off = 0; off + plen <= b.size; off++) {
      bool match = true;
      for (size_t k = 0; k < plen; k++) {
        if (pattern[k].wildcard) continue;
        if (b.data[off + k] != pattern[k].value) { match = false; break; }
      }
      if (match) hits.push_back(b.start + off);
    }
  }

  Napi::Array out = Napi::Array::New(env, hits.size());
  for (size_t i = 0; i < hits.size(); i++) {
    out.Set((uint32_t)i, Napi::String::New(env, ToHex(hits[i])));
  }
  return out;
}

Napi::Value SnapshotDecodeRun(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<SnapRegion> regions = ParseRegions(info[0]);
  if (env.IsExceptionPending()) return env.Null();
  const uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());
  const size_t minBytes = (size_t)info[2].As<Napi::Number>().Uint32Value();

  // Same 64-byte window and read-shrinking as the live decodeRun: a short
  // read near the end of readable memory is normal and just stops the decode.
  uint8_t window[64] = {0};
  SnapSigMemory mem(regions);
  size_t got = mem.Read(address, window, sizeof(window));
  if (got == 0) {
    for (size_t probe = sizeof(window) / 2; probe >= 1; probe /= 2) {
      if (mem.Read(address, window, probe)) { got = probe; break; }
    }
  }
  return DecodeRunBuffer(env, window, got, minBytes);
}

Napi::Value ListExecRegions(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  platform::ProcessHandle h = static_cast<platform::ProcessHandle>(
      info[0].As<Napi::Number>().Int64Value());

  Napi::Array out = Napi::Array::New(env);
  uint32_t n = 0;
  uintptr_t addr = 0;
  platform::Region region;
  while (platform::QueryRegion(h, addr, region)) {
    if (region.executable && region.readable) {
      Napi::Object o = Napi::Object::New(env);
      o.Set("base", Napi::String::New(env, ToHex(region.base)));
      o.Set("size", Napi::Number::New(env, (double)region.size));
      out.Set(n++, o);
    }
    const uintptr_t next = region.base + region.size;
    if (next <= addr) break; // guard against non-advancing regions
    addr = next;
  }
  return out;
}

Napi::Value ReadRegionBuffer(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  platform::ProcessHandle h = static_cast<platform::ProcessHandle>(
      info[0].As<Napi::Number>().Int64Value());
  const uintptr_t base = ParseHex(info[1].As<Napi::String>().Utf8Value());
  const size_t size = (size_t)info[2].As<Napi::Number>().Int64Value();
  if (size == 0) return env.Null();

  Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::New(env, size);
  if (!platform::ReadMemory(h, base, buf.Data(), size)) return env.Null();
  return buf;
}
