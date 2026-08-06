// One row per field or method, built once per assembly by MonoExplorer (see
// buildSearchIndex there) so a name can be found across every class in that
// assembly instead of browsing one class at a time. classHandle is the
// OWNING class's own already-resolved handle (the same one buildSearchIndex
// used to list this field/method in the first place) — carried along so
// jumping to a search hit can use it directly instead of a second,
// separate, ambiguous-by-name resolve.
export interface SearchIndexEntry {
  namespaceName: string
  className: string
  classHandle: string
  kind: 'field' | 'method'
  name: string
}

// Empty query returns nothing rather than the whole index — an unfiltered
// dump of every field/method in a real game assembly is thousands of rows,
// not a useful "no query yet" state to render.
export function filterSearchIndex(index: SearchIndexEntry[], query: string): SearchIndexEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  return index.filter((entry) => entry.name.toLowerCase().includes(q))
}
