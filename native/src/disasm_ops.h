#pragma once
#include <napi.h>

// Disassembles an already-fetched buffer of raw bytes (from memory:readBlock)
// into a list of {address, bytes, text, length} instruction rows. Takes no
// process handle and touches no memory itself — the renderer's Memory Viewer
// already reads the block it wants to look at; this only interprets it, the
// same split readMemoryBlock/decodeAt already draw for the hex+value view.
Napi::Value DisassembleBuffer(const Napi::CallbackInfo& info);
