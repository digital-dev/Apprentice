import type { FieldCandidate } from './ranker'

// Thin seam over the addon's mono_* primitives so the enumeration logic is
// testable without a live process.
export interface MonoEnumOps {
  listAssemblyNames(): Promise<{ image: string; name: string }[]>
  listClassesInImage(image: string): Promise<{ namespaceName: string; className: string; classHandle: string }[]>
  listFieldNames(classHandle: string): Promise<string[]>
  staticFieldAddress(classHandle: string, fieldName: string): Promise<string | null>
  readBytes(address: string, length: number): string | null
}

export interface Root {
  className: string
  staticFieldName: string
}

export interface Enumeration {
  fields: FieldCandidate[]
  // Static singleton handles whose pointer is non-zero right now.
  roots: Root[]
  // Same shape but the pointer is null (player not in a world yet).
  deadRoots: Root[]
  classesScanned: number
}

const GAME_ASSEMBLY = /^Assembly-CSharp/i
const SYSTEM_ASSEMBLY = /^(mscorlib|System|Unity|Mono\.|netstandard|Newtonsoft)/i
// Names that look like a singleton handle to the live instance.
const ROOT_NAME = /^(m_|_|s_)?(instance|local|localplayer|player|current|main|singleton)$/i
const NULL_POINTER = '0000000000000000'

export async function enumerateMono(ops: MonoEnumOps, classHints: RegExp[]): Promise<Enumeration> {
  const assemblies = await ops.listAssemblyNames()
  const game = assemblies.filter((a) => GAME_ASSEMBLY.test(a.name))
  const images = game.length > 0 ? game : assemblies.filter((a) => !SYSTEM_ASSEMBLY.test(a.name))

  const fields: FieldCandidate[] = []
  const roots: Root[] = []
  const deadRoots: Root[] = []
  let classesScanned = 0

  for (const image of images) {
    const classes = await ops.listClassesInImage(image.image)
    for (const cls of classes) {
      // resolveMonoTargetAddress only resolves with an empty namespace.
      if (cls.namespaceName !== '') continue
      if (!classHints.some((h) => h.test(cls.className))) continue
      classesScanned++
      const names = await ops.listFieldNames(cls.classHandle)
      for (const fieldName of names) {
        fields.push({ className: cls.className, fieldName })
        if (!ROOT_NAME.test(fieldName)) continue
        const address = await ops.staticFieldAddress(cls.classHandle, fieldName)
        if (address === null) continue
        const pointer = ops.readBytes(address, 8)
        if (pointer === null) continue
        const root = { className: cls.className, staticFieldName: fieldName }
        if (pointer === NULL_POINTER) deadRoots.push(root)
        else roots.push(root)
      }
    }
  }
  return { fields, roots, deadRoots, classesScanned }
}
