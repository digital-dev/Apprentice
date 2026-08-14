#pragma once
#include <napi.h>

// Both scan entry points run their memory walk on a libuv worker thread and
// return a Promise (resolving to an array of {address, value}) rather than
// the array itself — a large scan takes real wall-clock time and would
// otherwise block the entire Electron app on the main thread.
Napi::Value ScanFirst(const Napi::CallbackInfo& info);
Napi::Value ScanNext(const Napi::CallbackInfo& info);
