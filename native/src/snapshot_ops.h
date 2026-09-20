#pragma once
#include <napi.h>

// Replay support: run the signature builder, AOB scan and decodeRun over a
// recorded snapshot of a game's executable memory instead of a live process.
// `regions` is an array of { base: '0x..', bytes: Buffer }, one entry per
// memory region as the OS reported it (never merged: a live scan searches one
// region at a time, so the replay must too).

// listExecRegions(handle) -> [{ base: '0x..', size: number }]
Napi::Value ListExecRegions(const Napi::CallbackInfo& info);
// snapshotBuildSignature(regions, insnAddress, insnLength)
//   -> { signature, signatureOffset } | null when insnAddress is in no region
Napi::Value SnapshotBuildSignature(const Napi::CallbackInfo& info);
// snapshotScanAob(regions, signature) -> ['0x..'] in ascending address order
Napi::Value SnapshotScanAob(const Napi::CallbackInfo& info);
// snapshotDecodeRun(regions, address, minBytes) -> same shape as decodeRun
Napi::Value SnapshotDecodeRun(const Napi::CallbackInfo& info);
// readRegionBuffer(handle, base, size) -> Buffer | null when any part of the
// range is unreadable. One bulk read, for the recorder: readBytes is capped at
// 4096 bytes and returns hex, far too slow for a game's whole code image.
Napi::Value ReadRegionBuffer(const Napi::CallbackInfo& info);
