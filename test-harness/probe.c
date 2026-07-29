#include <windows.h>

// A patchable float store in a real, loadable PE. Non-inlined and taking
// its target as a runtime pointer argument so the compiler emits
// `movss [reg], xmm` — the same shape as a game's field write, and
// something an AOB signature can match. A store to a known global would be
// RIP-relative and would exercise a different (and unpatchable) path.
__declspec(dllexport) float g_probe_field = 5.0f;

#pragma optimize("", off)
__declspec(dllexport) void probe_write(float* target, float value) {
  *target = value;
}
#pragma optimize("", on)

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved) {
  (void)h; (void)reason; (void)reserved;
  return TRUE;
}

// PAD_SIZE is defined by the build command. The variant DLL is compiled
// with a larger value, which changes SizeOfImage — that is how a test
// simulates a game update without waiting for one.
__declspec(dllexport) char g_pad[PAD_SIZE] = {0};
