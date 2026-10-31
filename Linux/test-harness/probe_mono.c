// ELF counterpart of test-harness/probe_mono.c (the Windows PE fake Mono
// embedding-API DLL). Same fixture data and behavior; no __stdcall/__declspec
// (System V has one calling convention, and EXPORT is the usual visibility
// attribute, matching probe.c's own pattern), and __int64 -> int64_t.
//   gcc -shared -fPIC -o Linux/test-harness/probe_mono.so Linux/test-harness/probe_mono.c
#include <string.h>
#include <stdint.h>
#define EXPORT __attribute__((visibility("default")))

typedef struct { int dummy; } FakeDomain;
typedef struct { int dummy; } FakeThread;

typedef struct FakeClass FakeClass;

typedef struct {
  const char* name;
  int offset; // field offset within an instance, as mono_field_get_offset returns
  FakeClass* owner;
} FakeField;

typedef struct {
  const char* name;
} FakeMethod;

typedef struct {
  unsigned char staticData[2048];
} FakeVTable;

struct FakeClass {
  const char* namespaceName;
  const char* className;
  FakeField fields[2];
  int fieldCount;
  FakeMethod methods[2];
  int methodCount;
  FakeVTable vtable;
};

typedef struct {
  FakeClass* classes;
  int classCount;
  const char* name;
} FakeImage;

typedef struct {
  FakeImage* image;
} FakeAssembly;

static FakeDomain g_domain;
static FakeThread g_thread;

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

EXPORT FakeDomain* mono_get_root_domain(void) {
  return &g_domain;
}

EXPORT FakeThread* mono_thread_attach(FakeDomain* domain) {
  (void)domain;
  return &g_thread;
}

EXPORT void mono_thread_detach(FakeThread* thread) {
  (void)thread;
}

EXPORT FakeImage* mono_assembly_get_image(FakeAssembly* assembly) {
  return assembly->image;
}

EXPORT FakeClass* mono_class_from_name(
    FakeImage* image, const char* nameSpace, const char* name) {
  for (int i = 0; i < image->classCount; i++) {
    if (strcmp(image->classes[i].namespaceName, nameSpace) == 0 &&
        strcmp(image->classes[i].className, name) == 0) {
      return &image->classes[i];
    }
  }
  return NULL;
}

EXPORT FakeField* mono_class_get_fields(FakeClass* klass, void** iter) {
  intptr_t index = (intptr_t)*iter;
  if (index >= klass->fieldCount) return NULL;
  *iter = (void*)(index + 1);
  klass->fields[index].owner = klass;
  return &klass->fields[index];
}

EXPORT const char* mono_field_get_name(FakeField* field) {
  return field->name;
}

EXPORT int mono_field_get_offset(FakeField* field) {
  return field->offset;
}

EXPORT FakeVTable* mono_class_vtable(FakeDomain* domain, FakeClass* klass) {
  (void)domain;
  return &klass->vtable;
}

EXPORT void* mono_vtable_get_static_field_data(FakeVTable* vtable) {
  return vtable->staticData;
}

EXPORT FakeMethod* mono_class_get_methods(FakeClass* klass, void** iter) {
  intptr_t index = (intptr_t)*iter;
  if (index >= klass->methodCount) return NULL;
  *iter = (void*)(index + 1);
  return &klass->methods[index];
}

EXPORT const char* mono_method_get_name(FakeMethod* method) {
  return method->name;
}

EXPORT void* mono_compile_method(FakeMethod* method) {
  return (void*)method;
}

EXPORT FakeField* mono_class_get_field_from_name(
    FakeClass* klass, const char* name) {
  for (int i = 0; i < klass->fieldCount; i++) {
    if (strcmp(klass->fields[i].name, name) == 0) {
      klass->fields[i].owner = klass;
      return &klass->fields[i];
    }
  }
  return NULL;
}

EXPORT FakeClass* mono_field_get_parent(FakeField* field) {
  return field->owner;
}

EXPORT FakeMethod* mono_class_get_method_from_name(
    FakeClass* klass, const char* name, int param_count) {
  (void)param_count;
  for (int i = 0; i < klass->methodCount; i++) {
    if (strcmp(klass->methods[i].name, name) == 0) return &klass->methods[i];
  }
  return NULL;
}

EXPORT void mono_class_init(FakeClass* klass) {
  (void)klass;
}

typedef void (*ForeachCallback)(void* data, void* userData);

EXPORT void mono_assembly_foreach(ForeachCallback callback, void* userData) {
  callback(&g_assemblyA, userData);
  callback(&g_assemblyB, userData);
}

EXPORT const char* mono_image_get_name(FakeImage* image) {
  return image->name;
}

EXPORT void* mono_image_get_table_info(FakeImage* image, int tableId) {
  (void)tableId;
  return image;
}

EXPORT int mono_table_info_get_rows(void* tableInfo) {
  FakeImage* image = (FakeImage*)tableInfo;
  return image->classCount;
}

EXPORT FakeClass* mono_class_get(FakeImage* image, unsigned int typeToken) {
  int index = (int)(typeToken & 0x00FFFFFFu) - 1;
  if (index < 0 || index >= image->classCount) return NULL;
  return &image->classes[index];
}

EXPORT const char* mono_class_get_name(FakeClass* klass) {
  return klass->className;
}

EXPORT const char* mono_class_get_namespace(FakeClass* klass) {
  return klass->namespaceName;
}

EXPORT float probe_get_float(void* obj) {
  (void)obj;
  return 42.5f;
}
EXPORT int64_t probe_get_int(void* obj) {
  return (int64_t)obj + 1;
}

static float g_lastSetValue = 0;
EXPORT float probe_set_float(void* obj, float value) {
  (void)obj;
  g_lastSetValue = value;
  return value * 2.0f;
}
