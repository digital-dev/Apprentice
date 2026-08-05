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

// An image owns its own class list — mono_class_from_name searches only
// within it, not a single global table. This is load-bearing for testing
// the real resolver's multi-assembly search: with two assemblies, each
// holding a DIFFERENT class, a search has to genuinely skip the
// non-matching assembly's image and keep going to find the other one. A
// single shared image (this fixture's original shape) could never
// exercise that path — every lookup trivially "succeeded" on the first
// assembly regardless of which image was actually passed in, which is
// exactly the kind of gap that let an image-handling bug ship unnoticed
// until this fixture was tested against a real game with ~100 real
// assemblies instead of one fake one.
typedef struct {
  FakeClass* classes;
  int classCount;
  const char* name; // what mono_image_get_name returns — an assembly's display name
} FakeImage;

typedef struct {
  FakeImage* image;
} FakeAssembly;

static FakeDomain g_domain;
static FakeThread g_thread;

// "Player" lives in the first assembly's image; "Character" lives in the
// second. Two assemblies, not one.
static FakeClass g_classesA[1] = {
  { "", "Player",
    { { "m_godMode", 0x691 }, { "m_localPlayer", 0x10 } }, 2,
    { { "UseStamina" }, { "TakeDamage" } }, 2 },
};
static FakeClass g_classesB[1] = {
  { "", "Character",
    { { "m_health", 0x20 } }, 1,
    { { "ApplyDamage" } }, 1 },
};

static FakeImage g_imageA = { g_classesA, 1, "FakeAssemblyA" };
static FakeImage g_imageB = { g_classesB, 1, "FakeAssemblyB" };
static FakeAssembly g_assemblyA = { &g_imageA };
static FakeAssembly g_assemblyB = { &g_imageB };

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
  return assembly->image;
}

__declspec(dllexport) FakeClass* __stdcall mono_class_from_name(
    FakeImage* image, const char* nameSpace, const char* name) {
  for (int i = 0; i < image->classCount; i++) {
    if (strcmp(image->classes[i].namespaceName, nameSpace) == 0 &&
        strcmp(image->classes[i].className, name) == 0) {
      return &image->classes[i];
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
  callback(&g_assemblyA, userData);
  callback(&g_assemblyB, userData);
}

__declspec(dllexport) const char* __stdcall mono_image_get_name(FakeImage* image) {
  return image->name;
}

// Real Mono: mono_image_get_table_info(image, table_id) returns an opaque
// MonoTableInfo*, later passed to mono_table_info_get_rows and to
// mono_class_get (via the row-derived token) to enumerate every class in
// an image without knowing any of their names in advance — there is no
// simpler "for each class" call, unlike mono_assembly_foreach for
// assemblies. This fixture doesn't need a real table structure: it just
// returns the image itself as the opaque handle, since everything the
// caller needs (the class array) is already reachable from there.
__declspec(dllexport) void* __stdcall mono_image_get_table_info(FakeImage* image, int tableId) {
  (void)tableId;
  return image;
}

__declspec(dllexport) int __stdcall mono_table_info_get_rows(void* tableInfo) {
  FakeImage* image = (FakeImage*)tableInfo;
  return image->classCount;
}

// Real signature: mono_class_get(MonoImage*, uint32_t typeToken), where
// typeToken = MONO_TOKEN_TYPE_DEF (0x02000000) | (row_index + 1) — Mono's
// TypeDef table is 1-indexed. This fixture decodes the SAME formula real
// callers rely on, so a caller's token arithmetic is genuinely exercised,
// not just its happy path.
__declspec(dllexport) FakeClass* __stdcall mono_class_get(FakeImage* image, unsigned int typeToken) {
  int index = (int)(typeToken & 0x00FFFFFFu) - 1;
  if (index < 0 || index >= image->classCount) return NULL;
  return &image->classes[index];
}

__declspec(dllexport) const char* __stdcall mono_class_get_name(FakeClass* klass) {
  return klass->className;
}

__declspec(dllexport) const char* __stdcall mono_class_get_namespace(FakeClass* klass) {
  return klass->namespaceName;
}

// Stand-ins for arbitrary GAME code (not Mono's own embedding API) —
// what monoCallAttached exists to call safely. A real target is something
// like Character.GetHealth(): takes the object, returns a float.
__declspec(dllexport) float __stdcall probe_get_float(void* obj) {
  (void)obj;
  return 42.5f;
}
__declspec(dllexport) __int64 __stdcall probe_get_int(void* obj) {
  return (__int64)obj + 1;
}

// Mimics Character.SetHealth(float): an instance method whose one real
// argument is a float — arg position 2, so it arrives in XMM1, not XMM0.
// Returns it back (doubled) so a test can prove the float actually made it
// through, not just that SOME value came back.
static float g_lastSetValue = 0;
__declspec(dllexport) float __stdcall probe_set_float(void* obj, float value) {
  (void)obj;
  g_lastSetValue = value;
  return value * 2.0f;
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved) {
  (void)h; (void)reason; (void)reserved;
  return TRUE;
}
