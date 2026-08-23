import { loadProfile, saveProfile, setProfileDir } from './profile'

export type CheatMode = 'freeze' | 'oneshot'
// Every numeric width Apprentice can scan for, freeze, or write through a
// Mono value target. 'int8' (an unsigned 1-byte write/read — kept
// unsigned to match the width a Mono bool field, e.g. Player.m_godMode,
// actually occupies, and how it's always been read/written here) was
// previously named 'byte' and excluded from scanning; native/src/scanner.cc
// and native/src/memory_ops.cc now handle every one of these widths
// uniformly through native/src/value_type.h, so scanning works for all of
// them. int16/int32/int64 are signed.
//
// Force-mode code patches (cave_ops.cc's encodeStore) can only encode a
// 32-bit immediate — a force-mode PatchCheat's dataType must stay
// 'int32' or 'float'; patchEngine.ts's apply() refuses any other width
// before installing anything.
export type DataType = 'int8' | 'int16' | 'int32' | 'int64' | 'float' | 'double'

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
  // See MonoTarget.value/dataType below — the same per-target override,
  // available on every target kind.
  value?: number
  dataType?: DataType
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
  // See MonoTarget.value/dataType below — the same per-target override,
  // available on every target kind.
  value?: number
  dataType?: DataType
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
  // The class instanceFieldName is actually DECLARED on, when it isn't
  // className itself — e.g. m_localPlayer's declared type is Player, but
  // m_runSpeed lives on Character, a base class Player inherits from
  // without redeclaring. The native field lookup doesn't walk the
  // inheritance chain (confirmed live: resolving "m_runSpeed" against
  // Player's own class handle returns null; against Character's, it
  // resolves), so a field inherited from an ancestor needs that ancestor's
  // own class resolved separately from the one the static field lives on.
  // Absent means "same class as className" — every existing target keeps
  // resolving exactly as it did before this field existed.
  instanceClassName?: string
  // A second hop past instanceFieldName, for a field that sits on an object
  // reached THROUGH the first one rather than on it directly — e.g.
  // InventoryGui.m_instance -> .m_dragItem gets you the ADDRESS OF THE
  // POINTER FIELD holding the dragged ItemData, not the ItemData object
  // itself; the field you actually want (ItemData.m_stack) is one more
  // dereference away, at a fixed offset that never needed a class name to
  // find (the same "0x38" convention code patches already hardcode).
  // Absent means "not a two-hop target" — every existing MonoTarget keeps
  // resolving exactly as before. See resolveMonoTargetAddress's comment for
  // why this can't be expressed as a second instanceFieldName: the object it
  // points into (ItemData) isn't necessarily the same class as the first
  // hop's owner (InventoryGui), so there is no single classHandle a second
  // named field lookup could search against — only the raw offset is
  // portable here.
  pointerFieldOffset?: string
  // Per-target override for the cheat's own `value`/`dataType`. writeCheat
  // (ipc.ts) writes ONE value/dataType to every target in a cheat's list by
  // default — fine when all targets are redundant paths to the same
  // logical field, but not when a single cheat needs to drive two
  // DIFFERENT fields of different types in lockstep (e.g. "God Mode"
  // arming Player.m_godMode, an int8 bool, while ALSO freezing
  // Character.m_health, a float, at a max-HP constant — two fields that
  // must flip together but can't share one value or width). Absent means
  // "use the cheat's own value/dataType", exactly as every target behaved
  // before this field existed.
  value?: number
  dataType?: DataType
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
  // When present, EditCheatModal renders `value` as a 1x-20x multiplier
  // slider instead of a raw number field: value = multiplierBaseline *
  // sliderFactor, and the slider shows sliderFactor back (value /
  // multiplierBaseline). This is UI sugar only — the engine still just
  // freezes `value` verbatim, exactly as it always has; a cheat saved
  // before this field existed has no baseline and keeps showing the plain
  // number field it always did. The baseline itself is a one-time snapshot
  // (e.g. Valheim's default m_runSpeed, 7.0) captured when the cheat was
  // created, not re-read live — see EditPatchModal's scale-mode slider for
  // the equivalent idea on the patch side, where the engine itself does
  // the multiplying instead of the UI.
  multiplierBaseline?: number
  // An Electron accelerator string (e.g. "CommandOrControl+Shift+F1"),
  // captured by the renderer's "Set hotkey" control. Absent means no
  // hotkey — every cheat saved before this field existed keeps loading
  // and behaving unchanged. Registered globally (works while the game,
  // not Apprentice, has focus) only while this cheat's exe is attached —
  // see hotkeys.ts.
  hotkey?: string
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
  mode?: 'nop' | 'force' | 'capture' | 'guard' | 'immune' | 'copy' | 'scale'
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
  // Bytes past the method's own compiled start to patch, for a site that
  // isn't the method's entry — e.g. the merge point right before a method
  // returns, where the computed value sits in a register regardless of
  // which internal branch got there. Mono's JIT is deterministic per IL
  // input on a fixed game build (no tiered/adaptive recompilation the way
  // V8 has), so an offset captured this session reliably lands on the same
  // instruction next session even though the bytes there differ (embedded
  // pointers vary; instruction boundaries and ordering don't) — the same
  // property that makes compileMethod's own address resolution reliable
  // session to session. Absent means the patch targets the method's start,
  // exactly as before this field existed.
  monoMethodOffset?: string
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
  // One more instance-field hop past armPointerFieldName's static field, for
  // an object reached THROUGH the player rather than the player object
  // itself — e.g. Skills:OnDeath's `this` is the player's Skills instance
  // (Player.m_localPlayer -> .m_skills), not the Player instance armValue
  // alone would resolve. Both fields must be declared on armPointerClassName
  // — see resolveMonoPointerChain's own comment for why. Absent means the
  // static field's own dereferenced value IS the arm pointer, exactly as
  // before this field existed.
  armPointerInstanceFieldName?: string
  // force only: where the field sits relative to that register, what to
  // write, and how to turn `value` into the 32 bits that get written.
  fieldOffset?: string
  // copy: which GPR's live value to store — the "set this field to
  // whatever that register currently holds" shape force mode cannot
  // represent (force only encodes a fixed 32-bit immediate known at
  // capture/import time).
  // scale: which XMM register holds the float the game is about to store
  // — the register scale multiplies in place by `value` before the game's
  // own (unmodified) store replays. Same field, disjoint meaning: a patch
  // is either copy or scale, never both, so one name can carry either a
  // GPR or an XMM register name depending on mode.
  sourceRegister?: string
  // scale only: gates the multiply on a comparison instead of running it
  // unconditionally. Names a method on monoClass (e.g. HitData's
  // "GetAttacker") called with baseRegister as its sole argument at
  // install time's every execution; the multiply only runs when that
  // call's return matches the pointer armPointerClassName/
  // armPointerFieldName (or armValue) resolves to — e.g. "only when the
  // hit's attacker is the local player." Absent means the plain,
  // unconditional scale every existing scale patch already has —
  // baseRegister isn't even required without it. Reuses monoClass (the
  // same class the patch site itself is anchored to) as the class this
  // method is resolved against, since every use so far has needed exactly
  // that class's own resolver method; a use needing a different class
  // would need a new field, not a repurposed one.
  compareMonoMethod?: string
  value?: number
  dataType?: DataType
  // Same meaning as CheatDefinition.hotkey above.
  hotkey?: string
}

// A cheat whose enable/disable are one-shot Lua scripts, instead of a
// value write or a code patch. No mode/dataType/targets — its only state
// is which script last ran, tracked the way FreezeLoop tracks freeze
// state (see ScriptRuntime, main/scriptRuntime.ts).
export interface ScriptCheat {
  kind: 'script'
  id: string
  name: string
  enableScript: string
  disableScript: string
  // Same meaning as CheatDefinition.hotkey / PatchCheat.hotkey above.
  hotkey?: string
}

export type StoredCheat = CheatDefinition | PatchCheat | ScriptCheat

export function isPatchCheat(cheat: StoredCheat): cheat is PatchCheat {
  return cheat.kind === 'patch'
}

export function isScriptCheat(cheat: StoredCheat): cheat is ScriptCheat {
  return (cheat as ScriptCheat).kind === 'script'
}

export function patchMode(
  patch: PatchCheat
): 'nop' | 'force' | 'capture' | 'guard' | 'immune' | 'copy' | 'scale' {
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

// Another cheat in the same profile already using this exact hotkey, by
// name — or null if it's free (including when `cheat.hotkey` is unset,
// which is never a conflict). Pure, so it's testable without a profile on
// disk; ipc.ts's cheats:save handler is the only real caller, and it's
// what makes this check authoritative — the renderer's own pre-check
// before calling saveCheat is only for immediate feedback and can be
// stale.
export function findHotkeyConflict(cheats: StoredCheat[], cheat: StoredCheat): string | null {
  if (!cheat.hotkey) return null
  const conflict = cheats.find((c) => c.id !== cheat.id && c.hotkey === cheat.hotkey)
  return conflict ? conflict.name : null
}
