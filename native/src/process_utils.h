#pragma once
#include <napi.h>
#include <cstdint>

Napi::Value ListProcesses(const Napi::CallbackInfo& info);
Napi::Value Attach(const Napi::CallbackInfo& info);
Napi::Value Detach(const Napi::CallbackInfo& info);

// True if `handle` (an OpenProcess HANDLE, as returned by Attach, passed as
// a uintptr_t so this header stays windows.h-free like every other header
// in native/src/ — addon.cc includes this one first, and pulling windows.h
// in that early reordered macro definitions enough to break an unrelated
// Napi::Function::New call further down the translation unit) still refers
// to a running process. A crashed/exited target leaves the handle valid but
// pointing at a dead process — every read/scan entry point on that handle
// then either throws confusing per-call errors (mono lookups: "class/field
// not found") or silently returns an empty result (scans), both of which
// read exactly like "nothing matched" instead of "the game is gone". Callers
// that walk a lot of memory (scanFirst/scanNext/scanAob) check this up front
// so the caller gets one unambiguous error instead of that guesswork.
bool IsProcessAlive(uintptr_t handle);
