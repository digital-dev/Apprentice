#pragma once
#include <napi.h>
#include <cstdint>
#include <vector>
#include "platform/platform.h"

Napi::Value ResolveExport(const Napi::CallbackInfo& info);
Napi::Value CreateRemoteThread(const Napi::CallbackInfo& info);
Napi::Value CallRemoteFunction(const Napi::CallbackInfo& info);
Napi::Value CallRemoteFunctionFloat(const Napi::CallbackInfo& info);

// Builds the call stub, writes it into a fresh cave near `function`, runs it
// on a throwaway remote thread, and reads back its 8-byte return value into
// `result`. False on any failure (including a timed-out thread — see the
// never-free-a-live-cave rule, which is why a timeout still leaks its cave
// rather than freeing it). Free function rather than private to
// RemoteCallWorker: a later task's mono_bridge.cc calls this directly too.
//
// `floatResult`, if non-null, additionally receives the called function's
// XMM0 register — where the x64 calling convention returns float/double
// values, never in RAX. Every prior caller of this function only ever
// called Mono functions returning pointers/handles/ints, so this was never
// needed before; discovered missing when Character.GetHealth() (returns
// float) needed to be called directly for live acceptance testing and its
// "return value" always read back as whatever garbage RAX happened to hold.
bool RunRemoteCall(platform::ProcessHandle handle, uintptr_t function,
                    const std::vector<uintptr_t>& args, uint8_t result[8],
                    uint8_t floatResult[8] = nullptr);
