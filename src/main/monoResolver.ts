import { nativeAddon } from './nativeAddon'

// mono_class_from_name (what nativeAddon.monoResolveClass calls, per-image,
// through mono_bridge.cc's hand-encoded single-thread stub) only finds
// TOP-LEVEL types — confirmed live against a running game: it returns
// null for a compiler-generated nested class (every C# iterator/coroutine
// gets one, e.g. "<SpawnCustomerNPC>d__203" nested inside "NPC_Manager"),
// even though that class is loaded and shows up fine in a flat
// monoListClassesInImage enumeration. That enumeration walks the image's
// typedef table by row index rather than a name lookup, so it sees nested
// types mono_class_from_name's namespace-indexed search does not.
//
// Rather than teach mono_bridge.cc's delicate hand-encoded stub to walk
// mono_class_get_nested_types + compare names on the same single
// never-hop-threads attach (a real but much riskier native change), this
// resolves the same case by falling back to the already-proven
// enumerate-every-image-and-match-by-name path when the direct call
// fails — same two primitives the Mono Explorer's class picker already
// uses, just driven from here instead of the UI. Only attempted when
// namespaceName is empty: every nested/compiler-generated class this
// exists for carries one, and a caller that supplied a real namespace
// wanted the direct, unambiguous top-level lookup, not a scan.
//
// Cached per (monoDllBase, className) so a cheat retrying this every
// backoff tick while "arming" doesn't re-enumerate every image (Assembly-
// CSharp alone can be several thousand classes) on every attempt — only
// once, the first time the direct call comes back empty for that name in
// this monoDllBase (a fresh game session gets a fresh monoDllBase, so a
// stale entry never survives a restart).
const nestedClassCache = new Map<string, string | null>()

async function resolveNestedClassByEnumeration(
  handle: number,
  monoDllBase: string,
  className: string
): Promise<string | null> {
  const cacheKey = `${monoDllBase}:${className}`
  if (nestedClassCache.has(cacheKey)) return nestedClassCache.get(cacheKey) ?? null

  let found: string | null = null
  const assemblies = await nativeAddon.monoListAssemblyNames(handle, monoDllBase)
  for (const assembly of assemblies) {
    const classes = await nativeAddon.monoListClassesInImage(handle, monoDllBase, assembly.image)
    const hit = classes.find((c) => c.className === className)
    if (hit !== undefined) {
      found = hit.classHandle
      break
    }
  }
  nestedClassCache.set(cacheKey, found)
  return found
}

// Thin wrappers over the native Mono bridge. Every function here resolves
// or returns null — never throws — matching the codebase's existing
// convention for "can't find it right now" being a normal outcome, not an
// error (see nativeAddon.ts's tryReadBytes/tryReadValue).
export const monoResolver = {
  resolveClass: async (
    handle: number,
    monoDllBase: string,
    namespaceName: string,
    className: string
  ): Promise<string | null> => {
    const direct = await nativeAddon.monoResolveClass(handle, monoDllBase, namespaceName, className)
    if (direct !== null) return direct
    if (namespaceName !== '') return null
    return resolveNestedClassByEnumeration(handle, monoDllBase, className)
  },

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
    nativeAddon.monoListAssemblies(handle, monoDllBase),

  listAssemblyNames: (handle: number, monoDllBase: string): Promise<{ image: string; name: string }[]> =>
    nativeAddon.monoListAssemblyNames(handle, monoDllBase),

  listClassesInImage: (
    handle: number,
    monoDllBase: string,
    imageHandle: string
  ): Promise<{ namespaceName: string; className: string; classHandle: string }[]> =>
    nativeAddon.monoListClassesInImage(handle, monoDllBase, imageHandle)
}
