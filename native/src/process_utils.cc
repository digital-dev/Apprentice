#include "process_utils.h"
#include <windows.h>
#include <tlhelp32.h>
#include <psapi.h>

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

Napi::Value Attach(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "attach(pid) expects a number").ThrowAsJavaScriptException();
    return env.Null();
  }
  DWORD pid = info[0].As<Napi::Number>().Uint32Value();

  HANDLE process = OpenProcess(
      PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_VM_OPERATION,
      FALSE, pid);
  if (process == NULL) {
    Napi::Error::New(env, "OpenProcess failed (access denied or process not found)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  HMODULE mod;
  DWORD needed;
  uintptr_t base = 0;
  if (EnumProcessModules(process, &mod, sizeof(mod), &needed)) {
    base = reinterpret_cast<uintptr_t>(mod);
  } else {
    CloseHandle(process);
    Napi::Error::New(env, "EnumProcessModules failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("handle", Napi::Number::New(env, static_cast<double>(reinterpret_cast<uintptr_t>(process))));
  char hex[32];
  snprintf(hex, sizeof(hex), "0x%llx", (unsigned long long)base);
  result.Set("baseAddress", Napi::String::New(env, hex));
  return result;
}

bool IsProcessAlive(uintptr_t handle) {
  DWORD exitCode = 0;
  // GetExitCodeProcess succeeds even on a dead process (that's the whole
  // point of the call) — it's the exitCode value, not the return value,
  // that says whether the process is still running.
  if (!GetExitCodeProcess(reinterpret_cast<HANDLE>(handle), &exitCode)) return false;
  return exitCode == STILL_ACTIVE;
}

Napi::Value Detach(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "detach(handle) expects a number").ThrowAsJavaScriptException();
    return env.Null();
  }
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  bool ok = CloseHandle(h) != 0;
  return Napi::Boolean::New(env, ok);
}
