#pragma once
#include "platform.h"

// Drops a process's remote-allocation table (AllocateNear's own
// bookkeeping of what it gave out and how big each piece is) and its
// per-process trampoline cache (CreateRemoteThread's lazily-made,
// never-freed return target). Called by CloseProcess: a recycled pid must
// never inherit another process's idea of what is allocated where.
// Defined in platform_linux_remote.cc.
namespace platform {
void DropRemoteState(ProcessHandle handle);
}  // namespace platform
