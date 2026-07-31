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
    nativeAddon.monoStaticFieldAddress(handle, monoDllBase, classHandle, fieldName)
}
