#pragma once
#include <napi.h>
#include <cstdint>
#include <vector>
#include "platform/platform.h"

Napi::Value ResolveExport(const Napi::CallbackInfo& info);
Napi::Value CreateRemoteThread(const Napi::CallbackInfo& info);
Napi::Value CallRemoteFunction(const Napi::CallbackInfo& info);
Napi::Value CallRemoteFunctionFloat(const Napi::CallbackInfo& info);

// Hand-encodes the small remote-call stub RunRemoteCall writes into a cave
// and runs on a throwaway thread: loads up to 4 integer/pointer args into
// the registers `abi` dictates, calls `function`, and writes its 8-byte RAX
// result plus XMM0 (for a float/double return) to `resultAddress`. See the
// doc comment immediately above its definition in mono_call.cc for the
// exact byte layout of each ABI. Declared here (rather than kept anonymous
// inside mono_call.cc, as it was before Task 13) only so the native
// byte-level test under Linux/native/tests/ can call the real
// implementation directly instead of a hand-maintained copy of it.
std::vector<uint8_t> BuildCallStub(platform::Abi abi, uintptr_t function,
                                    const std::vector<uintptr_t>& args,
                                    uintptr_t resultAddress);

// Resolves the calling convention `function`'s own module uses: finds the
// loaded module containing `function` and returns its ABI, falling back to
// the process's main module if `function` isn't inside any known module
// (e.g. a scratch cave). See the definition in mono_call.cc for the full
// rationale. Exposed here so any caller that only has a bare function
// address and a process handle — cave_ops.cc's EncodeConditionalScale among
// them — can resolve the same way RemoteCallWorker/RemoteCallFloatWorker do,
// rather than re-implementing the ListModuleRanges scan.
platform::Abi ResolveAbiForFunction(platform::ProcessHandle handle, uintptr_t function);

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
//
// `abi` selects which calling convention the generated stub (BuildCallStub,
// in mono_call.cc) uses to load `args` and invoke `function` — Microsoft x64
// (Windows, and Wine's PE targets) or System V (native Linux/ELF targets).
// Every caller resolves it the same way: platform::PlatformAbiFor(handle,
// <the base of the module `function` belongs to>) — see mono_call.cc's
// RemoteCallWorker/RemoteCallFloatWorker for the case where that module has
// to be found from `function` alone, and mono_bridge.cc's call sites for the
// case where the caller already knows it (monoDllBase).
bool RunRemoteCall(platform::ProcessHandle handle, platform::Abi abi, uintptr_t function,
                    const std::vector<uintptr_t>& args, uint8_t result[8],
                    uint8_t floatResult[8] = nullptr);
