#include "disasm_ops.h"
#include "Zydis.h"
#include <cstdint>
#include <cstdio>
#include <string>

namespace {

std::string ToHexAddr(uint64_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}

std::string BytesToHex(const uint8_t* data, size_t len) {
  static const char kHexDigits[] = "0123456789abcdef";
  std::string out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    out.push_back(kHexDigits[data[i] >> 4]);
    out.push_back(kHexDigits[data[i] & 0xf]);
  }
  return out;
}

} // namespace

Napi::Value DisassembleBuffer(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsString()) {
    Napi::TypeError::New(env, "disassembleBuffer(buffer, baseAddressHex[, maxCount])")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
  const uint8_t* data = buf.Data();
  const size_t len = buf.Length();

  // std::stoull with base 16 accepts an optional "0x"/"0X" prefix per the
  // standard, so the hex strings this app passes everywhere (always
  // "0x"-prefixed — see ParseHex in chain_walk.h) work unmodified here too.
  uint64_t base = 0;
  try {
    base = std::stoull(info[1].As<Napi::String>().Utf8Value(), nullptr, 16);
  } catch (...) {
    Napi::TypeError::New(env, "invalid base address").ThrowAsJavaScriptException();
    return env.Null();
  }
  const uint32_t maxCount =
      info.Length() > 2 && info[2].IsNumber() ? info[2].As<Napi::Number>().Uint32Value() : 200;

  ZydisDecoder decoder;
  ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);
  ZydisFormatter formatter;
  ZydisFormatterInit(&formatter, ZYDIS_FORMATTER_STYLE_INTEL);

  Napi::Array result = Napi::Array::New(env);
  uint32_t idx = 0;
  size_t offset = 0;

  while (offset < len && idx < maxCount) {
    ZydisDecodedInstruction insn;
    ZydisDecodedOperand ops[ZYDIS_MAX_OPERAND_COUNT];
    ZyanStatus status =
        ZydisDecoderDecodeFull(&decoder, data + offset, len - offset, &insn, ops);

    Napi::Object row = Napi::Object::New(env);
    const uint64_t insnAddr = base + offset;
    row.Set("address", ToHexAddr(insnAddr));

    if (!ZYAN_SUCCESS(status)) {
      // Undecodable — most often the tail of the buffer (too few bytes left
      // for whatever's there) or a genuinely non-code region the viewer
      // pointed at. Emit one raw byte as "??" and advance by 1 so garbage
      // data doesn't stall the whole listing at the first bad byte.
      row.Set("bytes", BytesToHex(data + offset, 1));
      row.Set("text", "??");
      row.Set("length", Napi::Number::New(env, 1));
      result.Set(idx++, row);
      offset += 1;
      continue;
    }

    char textBuf[256];
    ZydisFormatterFormatInstruction(&formatter, &insn, ops, insn.operand_count_visible,
                                     textBuf, sizeof(textBuf), insnAddr, ZYAN_NULL);

    row.Set("bytes", BytesToHex(data + offset, insn.length));
    row.Set("text", std::string(textBuf));
    row.Set("length", Napi::Number::New(env, insn.length));
    result.Set(idx++, row);
    offset += insn.length;
  }

  return result;
}
