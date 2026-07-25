#include "process_utils.h"
#include <windows.h>
#include <tlhelp32.h>

Napi::Value ListProcesses(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array result = Napi::Array::New(env);

  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) {
    Napi::Error::New(env, "CreateToolhelp32Snapshot failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  PROCESSENTRY32 entry;
  entry.dwSize = sizeof(PROCESSENTRY32);
  uint32_t i = 0;

  if (Process32First(snap, &entry)) {
    do {
      Napi::Object item = Napi::Object::New(env);
      item.Set("pid", Napi::Number::New(env, entry.th32ProcessID));
      item.Set("name", Napi::String::New(env, entry.szExeFile));
      result.Set(i++, item);
    } while (Process32Next(snap, &entry));
  }

  CloseHandle(snap);
  return result;
}
