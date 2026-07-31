import { nativeAddon } from './nativeAddon'

// Thin wrappers over the native Mono bridge. Every function here resolves
// or returns null — never throws — matching the codebase's existing
// convention for "can't find it right now" being a normal outcome, not an
// error (see nativeAddon.ts's tryReadBytes/tryReadValue).
export const monoResolver = {
  resolveClass: (
    handle: number,
    monoDllBase: string,
    namespaceName: string,
    className: string
  ): Promise<string | null> => nativeAddon.monoResolveClass(handle, monoDllBase, namespaceName, className),

  resolveField: (
    handle: number,
    monoDllBase: string,
    classHandle: string,
    fieldName: string
  ): Promise<{ offset: number } | null> =>
    nativeAddon.monoResolveField(handle, monoDllBase, classHandle, fieldName),

  staticFieldAddress: (
    handle: number,
    monoDllBase: string,
    classHandle: string,
    fieldName: string
  ): Promise<string | null> =>
    nativeAddon.monoStaticFieldAddress(handle, monoDllBase, classHandle, fieldName),

  // The one operation in this bridge that can force real JIT compilation
  // of a method the game hasn't run yet. Every caller of this function
  // must be a deliberate, explicit user action — never a background retry
  // — per the sub-project's own safety rule.
  compileMethod: (
    handle: number,
    monoDllBase: string,
    classHandle: string,
    methodName: string
  ): Promise<string | null> => nativeAddon.monoCompileMethod(handle, monoDllBase, classHandle, methodName),

  listFieldNames: (handle: number, monoDllBase: string, classHandle: string): Promise<string[]> =>
    nativeAddon.monoListFieldNames(handle, monoDllBase, classHandle),

  listMethodNames: (handle: number, monoDllBase: string, classHandle: string): Promise<string[]> =>
    nativeAddon.monoListMethodNames(handle, monoDllBase, classHandle),

  listAssemblies: (handle: number, monoDllBase: string): Promise<string[]> =>
    nativeAddon.monoListAssemblies(handle, monoDllBase)
}
