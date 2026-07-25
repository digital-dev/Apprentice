#include "patch_ops.h"
#include <windows.h>
#include <string>
#include <vector>
#include <cstdint>
#include <cstdio>
#include <cctype>

namespace {

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

} // namespace

Napi::Value ReadBytes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());
  size_t length = static_cast<size_t>(info[2].As<Napi::Number>().Uint32Value());

  if (length == 0 || length > 64) {
    Napi::Error::New(env, "readBytes length must be 1..64").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::vector<uint8_t> buffer(length);
  SIZE_T read = 0;
  if (!ReadProcessMemory(h, (LPCVOID)address, buffer.data(), length, &read) || read != length) {
    Napi::Error::New(env, "ReadProcessMemory failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::String::New(env, BytesToHex(buffer.data(), length));
}

// Writing into a live process's CODE, which normally sits on read-execute
// pages: temporarily make the page writable, write, put the original
// protection back, then flush the target's instruction cache so the CPU
// doesn't keep executing a stale cached copy of the bytes we just changed.
Napi::Value WriteBytes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());
  std::string hex = info[2].As<Napi::String>().Utf8Value();

  std::vector<uint8_t> bytes;
  if (!HexToBytes(hex, bytes)) return Napi::Boolean::New(env, false);

  // VirtualProtectEx changes every page touched by [address, address+size),
  // but it reports only the FIRST page's prior protection in oldProtect.
  // If the range straddled a page boundary (an instruction can span one),
  // restoring oldProtect across the whole range would stamp page 1's
  // protection onto page 2 — leaving that page with wrong, unintended
  // protection permanently, which is exactly the residue this feature
  // promises never to leave. This addon only ever patches a single
  // captured instruction, so a straddling range is an anomaly: refuse it
  // rather than add per-page VirtualQueryEx/restore machinery for a case
  // that should not arise in normal use.
  static const uintptr_t pageSize = [] {
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    return static_cast<uintptr_t>(si.dwPageSize);
  }();
  uintptr_t firstPage = address & ~(pageSize - 1);
  uintptr_t lastPage = (address + bytes.size() - 1) & ~(pageSize - 1);
  if (firstPage != lastPage) return Napi::Boolean::New(env, false);

  DWORD oldProtect = 0;
  if (!VirtualProtectEx(h, (LPVOID)address, bytes.size(), PAGE_EXECUTE_READWRITE, &oldProtect))
    return Napi::Boolean::New(env, false);

  SIZE_T written = 0;
  bool ok = WriteProcessMemory(h, (LPVOID)address, bytes.data(), bytes.size(), &written) &&
            written == bytes.size();

  // Restore protection regardless of whether the write succeeded — leaving
  // a game's code page permanently writable is exactly the kind of residue
  // this feature promises never to leave behind.
  DWORD ignored = 0;
  VirtualProtectEx(h, (LPVOID)address, bytes.size(), oldProtect, &ignored);
  FlushInstructionCache(h, (LPCVOID)address, bytes.size());

  return Napi::Boolean::New(env, ok);
}
