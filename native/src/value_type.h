#pragma once
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>

// The width/interpretation table both scanner.cc and memory_ops.cc read
// through — kept in one place so int8's "unsigned, to match the existing
// byte-for-a-Mono-bool-field behavior" convention can't drift between the
// two files. int16/int32/int64 are signed; float/double are IEEE-754.
enum class ValueKind { UInt8, Int16, Int32, Int64, Float, Double };

struct ValueSpec {
  size_t size;
  ValueKind kind;
};

inline std::optional<ValueSpec> SpecForDataType(const std::string& dataType) {
  if (dataType == "int8") return ValueSpec{1, ValueKind::UInt8};
  if (dataType == "int16") return ValueSpec{2, ValueKind::Int16};
  if (dataType == "int32") return ValueSpec{4, ValueKind::Int32};
  if (dataType == "int64") return ValueSpec{8, ValueKind::Int64};
  if (dataType == "float") return ValueSpec{4, ValueKind::Float};
  if (dataType == "double") return ValueSpec{8, ValueKind::Double};
  return std::nullopt;
}

inline bool IsFloatKind(ValueKind kind) {
  return kind == ValueKind::Float || kind == ValueKind::Double;
}

// Interprets `spec.size` raw bytes as a double — scanner.cc's comparisons
// and memory_ops.cc's ReadValue both go through this, so a value reads the
// same way no matter which file touches it.
inline double InterpretAsDouble(const uint8_t* bytes, const ValueSpec& spec) {
  switch (spec.kind) {
    case ValueKind::UInt8: {
      uint8_t v;
      memcpy(&v, bytes, sizeof(v));
      return static_cast<double>(v);
    }
    case ValueKind::Int16: {
      int16_t v;
      memcpy(&v, bytes, sizeof(v));
      return static_cast<double>(v);
    }
    case ValueKind::Int32: {
      int32_t v;
      memcpy(&v, bytes, sizeof(v));
      return static_cast<double>(v);
    }
    case ValueKind::Int64: {
      int64_t v;
      memcpy(&v, bytes, sizeof(v));
      return static_cast<double>(v);
    }
    case ValueKind::Float: {
      float v;
      memcpy(&v, bytes, sizeof(v));
      return static_cast<double>(v);
    }
    case ValueKind::Double: {
      double v;
      memcpy(&v, bytes, sizeof(v));
      return v;
    }
  }
  return 0.0; // unreachable — every ValueKind is handled above
}

// The reverse of InterpretAsDouble: encodes a JS-side double into
// `spec.size` raw bytes for a write. memory_ops.cc's WriteValue is the
// only caller — scanner.cc never writes.
inline void EncodeFromDouble(double value, const ValueSpec& spec, uint8_t* out) {
  switch (spec.kind) {
    case ValueKind::UInt8: {
      uint8_t v = static_cast<uint8_t>(value);
      memcpy(out, &v, sizeof(v));
      return;
    }
    case ValueKind::Int16: {
      int16_t v = static_cast<int16_t>(value);
      memcpy(out, &v, sizeof(v));
      return;
    }
    case ValueKind::Int32: {
      int32_t v = static_cast<int32_t>(value);
      memcpy(out, &v, sizeof(v));
      return;
    }
    case ValueKind::Int64: {
      int64_t v = static_cast<int64_t>(value);
      memcpy(out, &v, sizeof(v));
      return;
    }
    case ValueKind::Float: {
      float v = static_cast<float>(value);
      memcpy(out, &v, sizeof(v));
      return;
    }
    case ValueKind::Double: {
      memcpy(out, &value, sizeof(value));
      return;
    }
  }
}
