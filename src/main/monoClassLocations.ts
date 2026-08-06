export interface ClassLocationOps {
  listAssemblyNames(): Promise<{ image: string; name: string }[]>
  listClassesInImage(imageHandle: string): Promise<{ namespaceName: string; className: string }[]>
}

// Every assembly that defines a class with this exact name (namespace
// ignored — a name-only resolve like monoResolveClass's own is namespace-
// blind too, since that's what a typed-in class name usually is). Composes
// the two already-proven, already-used calls behind Mono Explorer's own
// assembly/class browsing rather than adding a new native primitive: the
// native resolveClass path (MonoResolveClassWorker) enumerates every loaded
// assembly's image and STOPS at the first class matching the name — real,
// necessary for a fast single resolve, but silent about it. A name that
// happens to exist in more than one loaded assembly (a real game can load
// dozens) gets resolved to whichever one the native enumeration happened to
// reach first, with no signal that a DIFFERENT match existed. This function
// is how the UI surfaces that instead of trusting a resolve blindly — call
// it right after a resolve succeeds, and warn if it returns more than one
// name.
//
// Sequential per assembly, same reasoning as MonoExplorer's own
// buildSearchIndex: this walks every loaded assembly's full class list,
// which is exactly the cost buildSearchIndex already accepts for the same
// reason (no concurrent native round-trips against a live process).
export async function findClassLocations(
  className: string,
  ops: ClassLocationOps
): Promise<string[]> {
  const assemblies = await ops.listAssemblyNames()
  const matches: string[] = []
  for (const assembly of assemblies) {
    const classes = await ops.listClassesInImage(assembly.image)
    if (classes.some((c) => c.className === className)) matches.push(assembly.name)
  }
  return matches
}
