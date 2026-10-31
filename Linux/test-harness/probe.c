// ELF counterpart of test-harness/probe.c (the Windows PE probe DLL). Built by
// Linux/scripts/run-tests.sh twice: probe.so (PAD_SIZE=4096) and probe2.so
// (PAD_SIZE=262144, the "game updated" variant: a different mapped size).
//   gcc -shared -fPIC -O0 -DPAD_SIZE=4096 -o Linux/test-harness/probe.so Linux/test-harness/probe.c
#define EXPORT __attribute__((visibility("default")))

// A patchable float store: non-inlined, target passed as a runtime pointer, so
// the compiler emits `movss [reg], xmm`, the shape of a game's field write.
EXPORT float g_probe_field = 5.0f;

EXPORT __attribute__((noinline)) void probe_write(float* target, float value) {
  *target = value;
}

// Deliberately NOT all-zero: an all-zero array would live in .bss, which is an
// anonymous mapping and would not change the size of the file's mappings, so
// the variant would look identical to ListModules. The first byte makes it .data.
EXPORT char g_pad[PAD_SIZE] = {1};
