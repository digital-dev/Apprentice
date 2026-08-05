// One row per field or method, built once per assembly by MonoExplorer (see
// buildSearchIndex there) so a name can be found across every class in that
// assembly instead of browsing one class at a time.
export interface SearchIndexEntry {
  namespaceName: string
  className: string
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
