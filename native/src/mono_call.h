#pragma once
#include <napi.h>
#include <cstdint>
#include <vector>
#include "platform/platform.h"

Napi::Value ResolveExport(const Napi::CallbackInfo& info);
Napi::Value CreateRemoteThread(const Napi::CallbackInfo& info);
Napi::Value CallRemoteFunction(const Napi::CallbackInfo& info);

// Builds the call stub, writes it into a fresh cave near `function`, runs it
// on a throwaway remote thread, and reads back its 8-byte return value into
// `result`. False on any failure (including a timed-out thread — see the
// never-free-a-live-cave rule, which is why a timeout still leaks its cave
// rather than freeing it). Free function rather than private to
// RemoteCallWorker: a later task's mono_bridge.cc calls this directly too.
bool RunRemoteCall(platform::ProcessHandle handle, uintptr_t function,
                    const std::vector<uintptr_t>& args, uint8_t result[8]);
