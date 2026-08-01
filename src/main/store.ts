import { loadProfile, saveProfile, setProfileDir } from './profile'

export type CheatMode = 'freeze' | 'oneshot'
// 'byte' is a 1-byte write/read — the width a Mono bool field (e.g.
// Player.m_godMode) actually occupies. int32/float always write 4 bytes;
// using either of those on a 1-byte field overwrites 3 bytes of whatever
// field follows it in the object's layout. Scanning (scanner.cc) does not
// support 'byte' — this exists for the Mono value-target write path only,
// where the field's real width is already known from its resolution, not
// discovered by scanning.
export type DataType = 'int32' | 'float' | 'byte'

// A cheat can write to more than one resolved pointer chain at once. Naive
// memory scanning sometimes finds a chain that only looks static (a false
// positive within the offset-tolerant search) and stops resolving after a
// few seconds even though other candidates from the same scan keep
// working — writing to every selected target on each tick, and treating
// the cheat as broken only when ALL of them fail, makes a saved cheat
// resilient to any single target going stale.
export interface ChainTarget {
  moduleName: string
  baseOffset: string
  offsets: string[]
}

// A target reached through a pointer captured by an injection, rather than
// through a chain found by scanning. Scanned chains walk whatever path
// existed in that session and do not survive a restart of a managed runtime;
// a capture patch relocates by byte pattern and records the object's real
// address every time the game touches it, so a cheat anchored to one keeps
// working across restarts.
export interface AnchorTarget {
  kind: 'anchor'
  patchId: string
  offset: string
}

// A value reached through Mono-resolved metadata by name, instead of a
// scanned chain or a captured pointer. staticFieldName's ADDRESS is the
// base; when instanceFieldName is absent, that address's own VALUE is the
// target (a plain static field). When present, the static field's value is
// dereferenced once (it holds an object pointer) and instanceFieldName's
// offset is added — the [LocalPlayer]+Player.m_godMode shape exactly.
export interface MonoTarget {
  kind: 'mono'
  className: string
  staticFieldName: string
  instanceFieldName?: string
}

export type CheatTarget = ChainTarget | AnchorTarget | MonoTarget

export function isAnchorTarget(target: CheatTarget): target is AnchorTarget {
  return (target as AnchorTarget).kind === 'anchor'
}

export function isMonoTarget(target: CheatTarget): target is MonoTarget {
  return (target as MonoTarget).kind === 'mono'
}

export interface CheatDefinition {
  kind?: 'value'
  id: string
  name: string
  dataType: DataType
  mode: CheatMode
  targets: CheatTarget[]
  value: number
}

// A code patch: NOP out the instruction the game uses to write a value,
// instead of fighting that write by freezing the value. Stored in the same
// per-game array as value cheats and told apart by `kind` — an absent
// `kind` means a value cheat, which keeps every existing games/*.json file
// loading unchanged.
export interface PatchCheat {
  kind: 'patch'
  // How this patch changes the game. Absent means 'nop': every patch saved
  // before injection existed keeps working through the same code path.
  mode?: 'nop' | 'force' | 'capture' | 'guard' | 'immune'
  id: string
  name: string
  originalBytes: string // captured instruction bytes, unspaced lowercase hex
  length: number // bytes to NOP == instruction length
  signature: string // AOB with ?? wildcards, for relocating JIT code
  // How many signature bytes precede the captured instruction. The pattern
  // covers the surrounding method for uniqueness — a short method's own
  // bytes are not distinctive enough on their own — so a scan match is the
  // start of that context and the instruction is at match + this. Absent
  // means 0: every patch saved before signatures grew a lead-in has its
  // instruction at the start of the pattern, and must keep locating exactly
  // as it did.
  signatureOffset?: number
  // True when this patch exists only to anchor a value cheat, rather than
  // being something the user created and toggles directly. A persistent
  // value cheat is really two pieces — a capture patch that records where
  // the object is, and the cheat that writes through it — but that is our
  // implementation showing through, not something to make the user manage.
  // The cheat list hides these and drives them from the cheat they belong to.
  internal?: boolean
  moduleName: string | null // named module, or null for JIT/anonymous code
  moduleOffset: string | null // hex offset within that module
  // An alternative to moduleName/moduleOffset: resolve this patch's
  // address by asking the live Mono runtime for a class+method, instead of
  // arithmetic or an AOB scan. Absent means "not Mono-anchored" — every
  // existing patch keeps resolving exactly as before.
  monoClass?: string
  monoMethod?: string
  // force, capture, guard and immune: which register held the object at
  // capture time (for immune: which register the hooked method's entry
  // point receives its "this" argument in — rcx for a Mono-JIT instance
  // method).
  baseRegister?: string
  // guard and immune: the value that register held when the capture caught
  // it writing the watched address — i.e. the object that is actually
  // yours. Written into the slot at install so the guard/immune-check
  // protects the right thing immediately, instead of self-arming on
  // whichever entity the game happens to touch first. For guard, absent
  // means fall back to self-arming; immune has no per-call self-arming
  // moment to fall back to (it guards a method's entry, not a shared
  // write), so an immune patch without armValue (or armPointerClassName/
  // armPointerFieldName, below) refuses to install. Used as a fallback
  // when the dynamic pair below isn't set, and always as the last-known
  // value shown in the UI.
  armValue?: string
  // The live-resolved alternative to a frozen armValue: re-resolves the
  // object pointer fresh on every install (className's static field
  // fieldName, e.g. Player.m_localPlayer) instead of trusting a value
  // captured in a PREVIOUS process instance. armValue alone goes stale the
  // moment the game restarts — a new process means a new player object at
  // a new address — defeating the point of resolving everything else
  // (class, method) fresh by name each session. When both are present,
  // this pair wins; armValue is the fallback if resolution fails this
  // particular install attempt (better to try the last-known value than
  // refuse outright).
  armPointerClassName?: string
  armPointerFieldName?: string
  // force only: where the field sits relative to that register, what to
  // write, and how to turn `value` into the 32 bits that get written.
  fieldOffset?: string
  value?: number
  dataType?: DataType
}

export type StoredCheat = CheatDefinition | PatchCheat

export function isPatchCheat(cheat: StoredCheat): cheat is PatchCheat {
  return cheat.kind === 'patch'
}

export function patchMode(patch: PatchCheat): 'nop' | 'force' | 'capture' | 'guard' | 'immune' {
  return patch.mode ?? 'nop'
}

export function setGamesDir(dir: string): void {
  setProfileDir(dir)
}

export function loadCheats(exeName: string): StoredCheat[] {
  return loadProfile(exeName).cheats
}

export function saveCheat(exeName: string, cheat: StoredCheat): void {
  const profile = loadProfile(exeName)
  const idx = profile.cheats.findIndex((c) => c.id === cheat.id)
  if (idx >= 0) profile.cheats[idx] = cheat
  else profile.cheats.push(cheat)
  saveProfile(exeName, profile)
}

export function deleteCheat(exeName: string, cheatId: string): void {
  const profile = loadProfile(exeName)
  profile.cheats = profile.cheats.filter((c) => c.id !== cheatId)
  saveProfile(exeName, profile)
}
