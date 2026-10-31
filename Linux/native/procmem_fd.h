#pragma once
#include "platform.h"

namespace platform {

// Closes and forgets the cached /proc/<pid>/mem descriptor of a handle (if any).
// Called by OpenProcess (a recycled pid must never meet the old process's fd) and
// CloseProcess. Defined in platform_linux_write.cc.
void DropProcMemFd(ProcessHandle handle);

} // namespace platform
