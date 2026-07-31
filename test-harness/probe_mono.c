#include <windows.h>
#include <string.h>

// Fake stand-ins for Mono's opaque handle types. Real Mono callers never
// look inside these structs — they only pass the pointers back into other
// mono_* calls — so this fixture is free to lay them out however is
// convenient, as long as every exported function's SIGNATURE (argument
// and return types) matches real Mono's public embedding API exactly.
// That signature match is what lets mono_bridge.cc's calling code be
// tested here and trusted against the real mono.dll unchanged.

typedef struct { int dummy; } FakeDomain;
typedef struct { int dummy; } FakeThread;
typedef struct { int dummy; } FakeAssembly;
typedef struct { int dummy; } FakeImage;

typedef struct {
  const char* name;
  int offset; // field offset within an instance, as mono_field_get_offset returns
} FakeField;

typedef struct {
  const char* name;
} FakeMethod;

typedef struct {
  const char* namespaceName;
  const char* className;
  FakeField fields[2];
  int fieldCount;
  FakeMethod methods[2];
  int methodCount;
} FakeClass;

static FakeDomain g_domain;
static FakeThread g_thread;
static FakeAssembly g_assembly;
static FakeImage g_image;

// "Player" with one static-ish field the tests treat as m_godMode, and one
// method standing in for ApplyDamage. "Character" is a second class purely
// to prove class-name lookup actually discriminates between two classes
// rather than always returning the first one defined.
static FakeClass g_classes[2] = {
  { "", "Player",
    { { "m_godMode", 0x691 }, { "m_localPlayer", 0x10 } }, 2,
    { { "UseStamina" }, { "TakeDamage" } }, 2 },
  { "", "Character",
    { { "m_health", 0x20 } }, 1,
    { { "ApplyDamage" } }, 1 },
};

__declspec(dllexport) FakeDomain* __stdcall mono_get_root_domain(void) {
  return &g_domain;
}

__declspec(dllexport) FakeThread* __stdcall mono_thread_attach(FakeDomain* domain) {
  (void)domain;
  return &g_thread;
}

__declspec(dllexport) void __stdcall mono_thread_detach(FakeThread* thread) {
  (void)thread;
}

__declspec(dllexport) FakeImage* __stdcall mono_assembly_get_image(FakeAssembly* assembly) {
  (void)assembly;
  return &g_image;
}

__declspec(dllexport) FakeClass* __stdcall mono_class_from_name(
    FakeImage* image, const char* nameSpace, const char* name) {
  (void)image;
  for (int i = 0; i < 2; i++) {
    if (strcmp(g_classes[i].namespaceName, nameSpace) == 0 &&
        strcmp(g_classes[i].className, name) == 0) {
      return &g_classes[i];
    }
  }
  return NULL;
}

// Iterator-style, matching real Mono: caller owns an 8-byte iter slot,
// initialized to 0, passed by pointer; each call returns the next field
// (or NULL when exhausted) and advances *iter itself.
__declspec(dllexport) FakeField* __stdcall mono_class_get_fields(FakeClass* klass, void** iter) {
  intptr_t index = (intptr_t)*iter;
  if (index >= klass->fieldCount) return NULL;
  *iter = (void*)(index + 1);
  return &klass->fields[index];
}

__declspec(dllexport) const char* __stdcall mono_field_get_name(FakeField* field) {
  return field->name;
}

__declspec(dllexport) int __stdcall mono_field_get_offset(FakeField* field) {
  return field->offset;
}

__declspec(dllexport) FakeMethod* __stdcall mono_class_get_methods(FakeClass* klass, void** iter) {
  intptr_t index = (intptr_t)*iter;
  if (index >= klass->methodCount) return NULL;
  *iter = (void*)(index + 1);
  return &klass->methods[index];
}

__declspec(dllexport) const char* __stdcall mono_method_get_name(FakeMethod* method) {
  return method->name;
}

// Real mono_compile_method returns the JIT-compiled entry address. This
// fixture has no JIT, so it returns the method struct's own address —
// tests assert THAT a non-null, stable address comes back and that calling
// it twice for the same method returns the same address, not that it
// points at real machine code.
__declspec(dllexport) void* __stdcall mono_compile_method(FakeMethod* method) {
  return (void*)method;
}

typedef void (__stdcall *ForeachCallback)(void* data, void* userData);

__declspec(dllexport) void __stdcall mono_assembly_foreach(ForeachCallback callback, void* userData) {
  callback(&g_assembly, userData);
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved) {
  (void)h; (void)reason; (void)reserved;
  return TRUE;
}
