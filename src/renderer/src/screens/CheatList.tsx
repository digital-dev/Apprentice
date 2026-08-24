import { useEffect, useRef, useState } from 'react'
import type {
  CheatDefinition,
  StoredCheat,
  PatchCheat,
  ScriptCheat,
  CheatTarget,
  DataType
} from '../../../main/store'
import type { TargetStatus, PatchStatus, CheatStatus } from '../tamper.d'
import type { PendingMonoSelection } from '../App'
import Toggle from '../components/Toggle'
import AddressChip from '../components/AddressChip'
import CheatRow, { type CheatRowVM, type RailState } from '../components/CheatRow'
import ScriptEditor from '../components/ScriptEditor'
import EditCheatModal from '../components/EditCheatModal'
import EditPatchModal from '../components/EditPatchModal'
import MultiplierSlider from '../components/MultiplierSlider'
import { playOn, playOff, playError } from '../sound'

// Deliberately re-declared here instead of importing store.ts's
// isPatchCheat: that would be a VALUE import from the main process into the
// renderer bundle, dragging node:fs/node:path in with it. The renderer only
// ever gets these objects over IPC, so a one-line local guard is the right
// boundary.
function isPatch(cheat: StoredCheat): cheat is PatchCheat {
  return cheat.kind === 'patch'
}

// Same reasoning as isPatch above: a local guard rather than importing
// store.ts's isScriptCheat.
function isScript(cheat: StoredCheat): cheat is ScriptCheat {
  return (cheat as ScriptCheat).kind === 'script'
}

// Same reasoning as isPatch above: a local guard rather than importing
// store.ts's isAnchorTarget. Anchored targets have no module/offset chain to
// display, so the list needs a display label and key that work for either
// kind of target.
function isAnchor(target: CheatTarget): target is Extract<CheatTarget, { kind: 'anchor' }> {
  return (target as { kind?: string }).kind === 'anchor'
}

// Same reasoning as isAnchor above: a local guard rather than importing
// store.ts's isMonoTarget.
function isMono(target: CheatTarget): target is Extract<CheatTarget, { kind: 'mono' }> {
  return (target as { kind?: string }).kind === 'mono'
}

function targetLabel(target: CheatTarget): string {
  if (isAnchor(target)) return `${target.patchId} +${target.offset}`
  if (isMono(target))
    return target.instanceFieldName
      ? `${target.className}.${target.staticFieldName}+${target.instanceFieldName}`
      : `${target.className}.${target.staticFieldName}`
  return target.baseOffset
}

function targetKey(target: CheatTarget, index: number): string {
  if (isAnchor(target)) return `anchor-${target.patchId}-${index}`
  if (isMono(target)) return `mono-${target.className}-${target.staticFieldName}-${index}`
  return `${target.moduleName}-${target.baseOffset}-${index}`
}

// A patch can fail to locate for opposite reasons that need opposite
// responses, so the chip names which one rather than saying "can't relocate"
// for all of them: 0 matches means the code is gone and needs re-capturing,
// while several matches means the signature isn't unique and the engine is
// refusing to guess. Collapsing these cost a real debugging session.
function patchStatusLabel(status: PatchStatus): string {
  switch (status.state) {
    case 'original':
      return `located ${status.address}`
    case 'applied':
      return `patched ${status.address}`
    case 'unreadable':
      return `found ${status.address}, unreadable`
    case 'mismatch':
      return `bytes changed at ${status.address}`
    case 'foreign-injection':
      // A jmp trampoline from a previous Tamper session is still live in the
      // game and this engine instance has no record of it — it can neither
      // be restored nor adopted safely. Distinct wording so this doesn't
      // read as an ordinary mismatch: the fix is "restart the game", not
      // "re-capture".
      return `previous injection still active at ${status.address} — restart the game to clear it`
    default:
      if (status.matchCount === null) return 'module not loaded'
      if (status.matchCount === 0) return 'no signature match'
      return `${status.matchCount} signature matches — ambiguous`
  }
}

// One chip, one honest answer. "Toggled on but still retrying" must never
// look the same as "working" — that ambiguity is what cost a whole Valheim
// session to a patch that was fine.
function cheatStateLabel(status: CheatStatus): string {
  switch (status.state) {
    case 'idle':
      return 'ready'
    case 'arming':
      return status.reason === 'not-yet-compiled'
        ? 'waiting for the game to run this code'
        : 'arming'
    case 'active':
      return status.unverified ? 'active (new game build)' : 'active'
    case 'degraded':
      return 'degraded — stopped working'
    case 'failed':
      switch (status.reason) {
        case 'ambiguous':
          return 'ambiguous signature — re-capture'
        case 'bytes-differ':
          return 'the code changed — re-capture'
        case 'module-missing':
          return 'module not loaded'
        case 'no-match':
          return 'no signature match — re-capture'
        // The one reason here that describes a failed DISARM rather than a
        // failed arm: the game's code is STILL patched even though the user
        // asked to turn the cheat off. A bare 'failed' would read as "the
        // cheat is off and something went wrong", which is the exact
        // opposite of the truth and the whole point of this reason existing.
        case 'restore-failed':
          return 'still patched — restore failed, try again'
        default:
          return 'failed'
      }
  }
}

export default function CheatList({
  exeName,
  pendingMonoSelection,
  onConsumePendingMonoSelection,
  onViewInMemory
}: {
  exeName: string
  // A selection handed over from Mono Explorer, if the user just came from
  // there ("use as value target" / "use as patch anchor"). Pre-fills the
  // matching mini creation form below; onConsumePendingMonoSelection clears
  // it once saved or dismissed so it doesn't linger into a later, unrelated
  // visit to this screen.
  pendingMonoSelection?: PendingMonoSelection | null
  onConsumePendingMonoSelection?: () => void
  onViewInMemory: (address: string) => void
}) {
  const [cheats, setCheats] = useState<CheatDefinition[]>([])
  const [patches, setPatches] = useState<PatchCheat[]>([])
  // Mirrors of `cheats`/`patches` for the mount-once hotkey-fired effect
  // below: that effect subscribes exactly once (see its own comment on
  // why it can't re-subscribe on every cheats/patches change without
  // stacking the OTHER, deliberately-uncleaned listeners in the same
  // effect), so it reads through these refs rather than closing over the
  // state values, which would otherwise stay frozen at their mount-time
  // (empty) value.
  const cheatsRef = useRef(cheats)
  const patchesRef = useRef(patches)
  const scriptsRef = useRef<ScriptCheat[]>([])
  cheatsRef.current = cheats
  patchesRef.current = patches
  // Where each patch currently sits and whether it's safe to toggle on.
  // Checked once on attach and refreshed after each toggle.
  const [patchStatuses, setPatchStatuses] = useState<Map<string, PatchStatus>>(new Map())
  const [patchEnabled, setPatchEnabled] = useState<Set<string>>(new Set())
  const [patchError, setPatchError] = useState<Map<string, string>>(new Map())
  // What each enabled capture patch has recorded. Polled rather than read
  // once, because the slot stays empty until the game actually runs the
  // captured instruction — which can be a long while after the patch
  // installs, and is the difference between "not working" and "not yet".
  const [patchSlots, setPatchSlots] = useState<Map<string, { slot: string; pointer: string | null }>>(
    new Map()
  )
  // Ids with an apply/restore round-trip in flight, so the Toggle can be
  // disabled and a fast double-click can't interleave apply and restore.
  const [patchBusy, setPatchBusy] = useState<Set<string>>(new Set())
  const [enabled, setEnabled] = useState<Set<string>>(new Set())
  // "degraded" (all targets failing past the freeze-loop threshold). It is
  // a soft state now: the cheat stays enabled and keeps retrying, so this
  // is cleared automatically by a cheat:recovered event when it starts
  // resolving again — no manual re-toggle needed.
  const [degraded, setDegraded] = useState<Set<string>>(new Set())
  // Per-cheat revalidation result, index-aligned with each cheat's targets.
  const [statuses, setStatuses] = useState<Map<string, TargetStatus[]>>(new Map())
  // Which cheat's verify panel is expanded, and the value typed into it.
  const [verifyOpen, setVerifyOpen] = useState<string | null>(null)
  const [verifyValue, setVerifyValue] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // Which cheat/patch is currently capturing a hotkey, the combo captured
  // so far (built live as modifiers/keys are pressed), and an error to
  // show inline (a rejected key, or a save-time conflict from cheats:save).
  const [capturingHotkeyId, setCapturingHotkeyId] = useState<string | null>(null)
  const [capturedHotkey, setCapturedHotkey] = useState<string | null>(null)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)
  const [hotkeyConflicts, setHotkeyConflicts] = useState<{ name: string; hotkey: string }[]>([])
  // An 'error' outcome from a hotkey fire (currently only a one-shot write
  // failure) — surfaced the same way patchError/toggle failures already
  // are, since the hotkey path itself gives no other feedback (the game,
  // not this window, has focus when it fires).
  const [hotkeyFireError, setHotkeyFireError] = useState<{ cheatName: string; message: string } | null>(
    null
  )
  // "View in Memory" on a value cheat's own ⋮ menu — unlike a patch (whose
  // located address is already sitting in patchStatuses from locatePatch),
  // a value cheat has no address to hand until asked: resolve it fresh
  // against whichever of its targets currently works, same fallback order
  // toggle()/writeCheat use (first target that resolves wins).
  const [memViewError, setMemViewError] = useState<string | null>(null)
  async function viewCheatInMemory(cheat: CheatDefinition) {
    setMemViewError(null)
    for (const target of cheat.targets) {
      const address = await window.tamper.resolveCheatTargetAddress(target)
      if (address) {
        onViewInMemory(address)
        return
      }
    }
    setMemViewError(
      `Could not resolve a live address for "${cheat.name}" — is the game attached and this target currently resolving?`
    )
  }
  // Runtime state pushed by cheatRuntime for each armed patch — keyed by
  // patch id, same as patchStatuses. Populated only once a patch has been
  // toggled on at least once; patchStatusLabel covers the pre-arm readout.
  const [cheatStates, setCheatStates] = useState<Map<string, CheatStatus>>(new Map())
  // Modules whose on-disk fingerprint no longer matches what was captured
  // against — drives the "this game has updated" banner.
  const [changedModules, setChangedModules] = useState<string[]>([])

  // "Edit…" on a value cheat/patch's ⋮ menu — a scratch copy edited in
  // place (EditCheatModal/EditPatchModal mutate it via onChange) and only
  // written back to the profile + list state on Save, same edit-in-a-copy
  // shape as editingScript below.
  const [editingCheat, setEditingCheat] = useState<CheatDefinition | null>(null)
  const [editingPatch, setEditingPatch] = useState<PatchCheat | null>(null)
  const [editError, setEditError] = useState<string | null>(null)

  const [scripts, setScripts] = useState<ScriptCheat[]>([])
  const [scriptEnabled, setScriptEnabled] = useState<Record<string, boolean>>({})
  const [editingScript, setEditingScript] = useState<ScriptCheat | null>(null)
  const [scriptOutput, setScriptOutput] = useState<string[] | null>(null)
  const [scriptError, setScriptError] = useState<string | null>(null)
  // Same reasoning as cheatsRef/patchesRef above: the mount-once
  // onHotkeyFired effect reads through this ref rather than closing over
  // `scripts`, which would otherwise stay frozen at its mount-time (empty)
  // value.
  scriptsRef.current = scripts

  // The two mini creation forms below Mono Explorer's handoff feeds. Kept
  // as plain per-field state, matching Scanner.tsx's own creation-form
  // style, rather than a shared "new cheat" object — the two forms build
  // different target/cheat shapes and are never open at the same time.
  const [monoValueName, setMonoValueName] = useState('')
  const [monoValueDataType, setMonoValueDataType] = useState<DataType>('float')
  const [monoValueMode, setMonoValueMode] = useState<CheatDefinition['mode']>('freeze')
  const [monoValueValue, setMonoValueValue] = useState('')
  // Whether the field Mono Explorer handed over belongs to an OBJECT
  // (m_godMode lives on a Player instance) rather than being itself a
  // static field. Defaults to true because that's the common, interesting
  // case — most fields worth cheating are per-instance — and getting this
  // wrong silently writes into Mono's OWN field-metadata structure instead
  // of the game object (see resolveMonoTargetAddress's staticFieldName vs
  // instanceFieldName split), not into anything the game reads, which is
  // exactly the bug this replaced: m_godMode saved as a bare staticFieldName
  // installed with no visible effect and no error either.
  const [monoValueIsInstance, setMonoValueIsInstance] = useState(true)
  const [monoValueInstanceHolder, setMonoValueInstanceHolder] = useState('m_localPlayer')
  const [monoAnchorName, setMonoAnchorName] = useState('')
  const [monoAnchorBytes, setMonoAnchorBytes] = useState('')
  const [monoAnchorLength, setMonoAnchorLength] = useState('')
  // immune-only fields, hidden until monoAnchorMode === 'immune'. rcx is the
  // default baseRegister because that's where a Mono-JIT instance method's
  // "this" argument lands under the Windows x64 calling convention — right
  // in the overwhelming majority of cases, but left editable for the rare
  // method that doesn't follow it. armValue is resolved via a button rather
  // than typed, since it's a live pointer value nobody types by hand — it
  // comes from reading a static field (className/fieldName below), not
  // guessing.
  const [monoAnchorMode, setMonoAnchorMode] = useState<'nop' | 'immune'>('nop')
  const [monoAnchorBaseRegister, setMonoAnchorBaseRegister] = useState('rcx')
  const [monoAnchorPlayerClass, setMonoAnchorPlayerClass] = useState('Player')
  const [monoAnchorPlayerField, setMonoAnchorPlayerField] = useState('m_localPlayer')
  const [monoAnchorUseInstanceField, setMonoAnchorUseInstanceField] = useState(false)
  const [monoAnchorPlayerInstanceField, setMonoAnchorPlayerInstanceField] = useState('')
  const [monoAnchorArmValue, setMonoAnchorArmValue] = useState<string | null>(null)
  const [monoAnchorResolvingArm, setMonoAnchorResolvingArm] = useState(false)
  const [monoAnchorArmError, setMonoAnchorArmError] = useState<string | null>(null)
  // A name-only class resolve silently picks whichever loaded assembly's
  // match comes first — the exact failure mode that armed multiple immune
  // patches on the wrong object, for hours, with every symptom pointing
  // everywhere except here. See tamper.d.ts's monoClassLocations comment.
  const [monoAnchorClassAmbiguity, setMonoAnchorClassAmbiguity] = useState<string[] | null>(null)
  // Force a specific value back from the whole method instead of the
  // default bare-0 skip — the shape a getter like Character:GetHealth needs
  // (the real CT table's own second use of this exact guard-and-return
  // primitive), where returning nothing meaningful isn't an option. Reuses
  // PatchCheat's existing value/dataType fields — the same ones `force`
  // mode already means "what to write" — rather than a parallel pair.
  const [monoAnchorUseReturnValue, setMonoAnchorUseReturnValue] = useState(false)
  const [monoAnchorReturnValue, setMonoAnchorReturnValue] = useState('')
  const [monoAnchorReturnDataType, setMonoAnchorReturnDataType] = useState<DataType>('float')
  const [monoAnchorResolvingBytes, setMonoAnchorResolvingBytes] = useState(false)
  const [monoAnchorBytesError, setMonoAnchorBytesError] = useState<string | null>(null)

  const [ctImporting, setCtImporting] = useState(false)
  const [ctImportResult, setCtImportResult] = useState<
    | { importedNames: string[]; skipped: { description: string; reason: string }[] }
    | { error: string }
    | null
  >(null)

  const [ctExporting, setCtExporting] = useState(false)
  const [ctExportResult, setCtExportResult] = useState<{
    exportedNames: string[]
    skipped: { name: string; reason: string }[]
  } | null>(null)

  async function importCheatTable() {
    setCtImporting(true)
    setCtImportResult(null)
    try {
      const result = await window.tamper.importCheatTable(exeName)
      if (result === null) return // user cancelled the file picker
      setCtImportResult(result)
      if ('error' in result) return // size cap or parse-timeout — nothing was saved
      // Saved directly by the main process (see ipc.ts's ct:import) —
      // reload from disk rather than reconstructing PatchCheat objects
      // here, so this stays in sync with whatever the save path actually
      // persisted.
      const all: StoredCheat[] = await window.tamper.loadCheats(exeName)
      setCheats(all.filter((c): c is CheatDefinition => !isPatch(c) && !isScript(c)))
      setPatches(all.filter(isPatch))
      setScripts(all.filter(isScript))
    } finally {
      setCtImporting(false)
    }
  }

  async function exportCheatTable() {
    setCtExporting(true)
    setCtExportResult(null)
    try {
      const result = await window.tamper.exportCheatTable(exeName)
      if (result === null) return // user cancelled the save dialog
      setCtExportResult(result)
    } finally {
      setCtExporting(false)
    }
  }

  // 16 bytes is a generous, fixed snapshot of the method's live entry —
  // there's no need to hit an exact instruction boundary here (unlike nop
  // mode's direct overwrite): this only ever feeds locate()'s byte-for-byte
  // "did something else change this code" check, and every non-nop mode's
  // actual install finds its own real boundary via decodeRun regardless of
  // what length is recorded here.
  const MONO_ANCHOR_SNAPSHOT_LENGTH = 16

  async function resolveMonoAnchorBytes() {
    if (pendingMonoSelection?.kind !== 'anchor') return
    setMonoAnchorBytesError(null)
    setMonoAnchorResolvingBytes(true)
    try {
      const result = await window.tamper.monoResolveMethodBytes(
        pendingMonoSelection.className,
        pendingMonoSelection.methodName,
        MONO_ANCHOR_SNAPSHOT_LENGTH
      )
      if (result === null) {
        setMonoAnchorBytesError(
          `Could not read live bytes for ${pendingMonoSelection.className}.${pendingMonoSelection.methodName} — is the runtime attached and this method compiled yet?`
        )
        return
      }
      setMonoAnchorBytes(result.bytes)
      setMonoAnchorLength(String(result.length))
    } finally {
      setMonoAnchorResolvingBytes(false)
    }
  }

  async function resolveMonoAnchorArmValue() {
    setMonoAnchorArmError(null)
    setMonoAnchorClassAmbiguity(null)
    setMonoAnchorResolvingArm(true)
    try {
      const instanceField = monoAnchorUseInstanceField ? monoAnchorPlayerInstanceField.trim() : undefined
      const [pointer, locations] = await Promise.all([
        window.tamper.monoResolvePlayerPointer(monoAnchorPlayerClass, monoAnchorPlayerField, instanceField),
        window.tamper.monoClassLocations(monoAnchorPlayerClass)
      ])
      if (locations.length > 1) setMonoAnchorClassAmbiguity(locations)
      if (pointer === null) {
        setMonoAnchorArmValue(null)
        setMonoAnchorArmError(
          instanceField
            ? `Could not resolve ${monoAnchorPlayerClass}.${monoAnchorPlayerField} -> .${instanceField} — either the runtime isn't attached yet, ${monoAnchorPlayerClass} has no static field ${monoAnchorPlayerField} or no instance field ${instanceField}, or the local player hasn't loaded this session.`
            : `Could not resolve ${monoAnchorPlayerClass}.${monoAnchorPlayerField} — is the runtime attached and has a local player loaded yet?`
        )
        return
      }
      setMonoAnchorArmValue(pointer)
    } finally {
      setMonoAnchorResolvingArm(false)
    }
  }

  useEffect(() => {
    window.tamper.onCheatState(({ cheatId, status }) => {
      setCheatStates((prev) => new Map(prev).set(cheatId, status))
    })
    window.tamper.onGameState((state) => setChangedModules(state.changedModules))
    void window.tamper.currentGame().then((state) => setChangedModules(state.changedModules))
    // Pull whatever conflicts already happened before this screen existed
    // (registerAll runs synchronously during process:attach and the
    // watcher's auto-attach, both before this screen can have subscribed to
    // the push below). The live onHotkeyConflict push continues to handle
    // conflicts from a save made while already on this screen.
    void window.tamper.getHotkeyConflicts().then((failed) => setHotkeyConflicts(failed))

    // A hotkey fires entirely in the main process while the game (not
    // this window) has focus — this is the renderer's only way to learn
    // it happened, both to play the matching sound and to keep the
    // on-screen toggle from silently disagreeing with the game's actual
    // state (see this feature's design doc for why that gap existed).
    const disposeFired = window.tamper.onHotkeyFired(({ cheatId, outcome, error }) => {
      if (outcome === 'on' || outcome === 'applied') playOn()
      else if (outcome === 'off') playOff()
      else playError()

      const isPatchId = patchesRef.current.some((p) => p.id === cheatId)
      const isScriptId = scriptsRef.current.some((s) => s.id === cheatId)
      if (isPatchId) {
        setPatchEnabled((prev) => {
          if (outcome !== 'on' && outcome !== 'off') return prev
          const next = new Set(prev)
          if (outcome === 'on') next.add(cheatId)
          else next.delete(cheatId)
          return next
        })
      } else if (isScriptId) {
        setScriptEnabled((prev) => {
          if (outcome !== 'on' && outcome !== 'off') return prev
          return { ...prev, [cheatId]: outcome === 'on' }
        })
      } else {
        setEnabled((prev) => {
          if (outcome !== 'on' && outcome !== 'off') return prev
          const next = new Set(prev)
          if (outcome === 'on') next.add(cheatId)
          else next.delete(cheatId)
          return next
        })
      }

      if (outcome === 'on') {
        setDegraded((prev) => {
          const next = new Set(prev)
          next.delete(cheatId)
          return next
        })
      }

      if (outcome === 'error' && error) {
        const found = [...cheatsRef.current, ...patchesRef.current, ...scriptsRef.current].find(
          (c) => c.id === cheatId
        )
        setHotkeyFireError({ cheatName: found?.name ?? cheatId, message: error })
      }
    })
    const disposeConflict = window.tamper.onHotkeyConflict((failed) => {
      setHotkeyConflicts((prev) => [...prev, ...failed])
    })

    return () => {
      disposeFired()
      disposeConflict()
    }
  }, [])

  // Live-captures a hotkey combo while `capturingHotkeyId` is set. A
  // window-level listener (not one scoped to an input) because the whole
  // point is capturing the raw combo, not typing into a text field.
  //
  // Auto-saves the instant a valid combo is pressed — no separate confirm
  // step. The row's ⋮ menu is closed at this point (RowMenu closes itself
  // before its item's onClick fires), so there is nowhere for a "Confirm"
  // button to live without asking the user to reopen the menu after
  // pressing the combo, which is what this replaced. Escape cancels.
  useEffect(() => {
    if (capturingHotkeyId === null) return
    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault()
      if (e.key === 'Escape') {
        setCapturingHotkeyId(null)
        setCapturedHotkey(null)
        setHotkeyError(null)
        return
      }
      const accelerator = buildAccelerator(e)
      if (!accelerator) {
        setHotkeyError(
          'Use a letter, number, or function key with at least one modifier — or a numpad key on its own.'
        )
        return
      }
      setHotkeyError(null)
      setCapturedHotkey(accelerator)
      const target: StoredCheat | undefined =
        cheats.find((c) => c.id === capturingHotkeyId) ??
        patches.find((p) => p.id === capturingHotkeyId) ??
        scripts.find((s) => s.id === capturingHotkeyId)
      if (target) void saveHotkey(target, accelerator)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [capturingHotkeyId, cheats, patches, scripts])

  useEffect(() => {
    async function loadAndRevalidate() {
      const all: StoredCheat[] = await window.tamper.loadCheats(exeName)
      const loaded = all.filter((c): c is CheatDefinition => !isPatch(c) && !isScript(c))
      const loadedPatches = all.filter(isPatch)
      setCheats(loaded)
      setPatches(loadedPatches)
      // Re-derive which value cheats are already running from the freeze
      // loop's own authoritative state, same reasoning as loadedScripts'
      // isScriptEnabled pull just below — CheatList remounts on every
      // visit to this screen (see App.tsx), so without this a cheat
      // toggled on before a tab switch would read back as off.
      const freezeEnabledEntries = await Promise.all(
        loaded.map(async (c) => [c.id, await window.tamper.isFreezeEnabled(c.id)] as const)
      )
      setEnabled(new Set(freezeEnabledEntries.filter(([, on]) => on).map(([id]) => id)))
      const loadedScripts = all.filter(isScript)
      setScripts(loadedScripts)
      const enabledEntries = await Promise.all(
        loadedScripts.map(async (s) => [s.id, await window.tamper.isScriptEnabled(s.id)] as const)
      )
      setScriptEnabled(Object.fromEntries(enabledEntries))

      // A patch's address is only meaningful against the running process, so
      // resolve each one on attach: module+offset for module code, an AOB
      // scan for JIT code. This drives the located / can't-relocate chip.
      for (const patch of loadedPatches) {
        // Held for the same reason as in togglePatch: this may call
        // applyPatch below, and a manual toggle click landing mid-adopt
        // could otherwise interleave with it.
        setPatchBusy((prev) => new Set(prev).add(patch.id))
        try {
          const status = await window.tamper.locatePatch(patch)
          setPatchStatuses((prev) => new Map(prev).set(patch.id, status))
          // Re-attaching to a process we already patched: the NOPs are
          // already there, but PatchEngine's applied-set — the only thing
          // that drives restore — only gets populated by apply(). Call it
          // now so a later toggle-off actually restores. apply() is a
          // recorded no-op write when locate() reports 'applied', so this
          // never touches the game's code.
          if (status.state === 'applied') {
            const result = await window.tamper.applyPatch(patch)
            if (result.ok) {
              setPatchEnabled((prev) => new Set(prev).add(patch.id))
            } else {
              setPatchError((prev) => new Map(prev).set(patch.id, result.error ?? 'Patch failed'))
            }
          }
        } catch {
          // not attached / transient — leave this patch without a readout
        } finally {
          setPatchBusy((prev) => {
            const copy = new Set(prev)
            copy.delete(patch.id)
            return copy
          })
        }
      }
      // Automatic readability check on (re)attach: populate a live "N of M
      // targets" health readout for each cheat, so a cheat now running on
      // only some of its targets (e.g. after a game restart shifted the
      // rest) is visible at a glance. Readability-only, no value filter,
      // and non-destructive — nothing is removed.
      for (const cheat of loaded) {
        try {
          const result = await window.tamper.verifyCheat(cheat, null)
          setStatuses((prev) => new Map(prev).set(cheat.id, result))
        } catch {
          // not attached / transient — leave this cheat without a readout
        }
      }
    }
    loadAndRevalidate()

    window.tamper.onCheatBroken((cheatId) => {
      // Cheat stays enabled (it keeps retrying and can self-heal); just
      // surface the degraded warning.
      setDegraded((prev) => new Set(prev).add(cheatId))
    })
    window.tamper.onCheatRecovered((cheatId) => {
      setDegraded((prev) => {
        const next = new Set(prev)
        next.delete(cheatId)
        return next
      })
    })
  }, [exeName])

  // Poll what the enabled capture patches have recorded. A capture fires
  // when the game next runs the instruction it rides on, which may be
  // seconds or minutes after install — so this has to keep looking rather
  // than read once, or an armed patch looks broken until something happens
  // to touch it.
  useEffect(() => {
    // guard remembers an object too, and seeing which one it locked onto is
    // the only way to tell "armed on the wrong entity" from "not working".
    const captures = patches.filter(
      (p) => (p.mode === 'capture' || p.mode === 'guard') && patchEnabled.has(p.id)
    )
    if (captures.length === 0) return
    let cancelled = false

    async function refresh(): Promise<void> {
      for (const patch of captures) {
        try {
          const info = await window.tamper.patchSlot(patch.id)
          if (cancelled) return
          setPatchSlots((prev) => {
            const next = new Map(prev)
            if (info) next.set(patch.id, info)
            else next.delete(patch.id)
            return next
          })
        } catch {
          // not attached, or the patch went away mid-poll — the next tick
          // picks it up if it comes back
        }
      }
    }

    refresh()
    const timer = setInterval(refresh, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [patches, patchEnabled])

  async function toggle(cheat: CheatDefinition) {
    const next = !enabled.has(cheat.id)

    // A cheat anchored to a capture patch can't resolve unless that patch is
    // installed — the slot it reads through only exists while the injection
    // is live. The patch is ours, not something the user manages, so drive it
    // from here: install it before turning the cheat on, restore it after
    // turning the cheat off. Turning it on FIRST also matters — the capture
    // records the first object the game touches after arming, so the earlier
    // it goes in the better.
    const anchors = cheat.targets.filter(
      (t): t is { kind: 'anchor'; patchId: string; offset: string } =>
        (t as { kind?: string }).kind === 'anchor'
    )
    for (const anchor of anchors) {
      const patch = patches.find((p) => p.id === anchor.patchId)
      if (!patch) {
        setPatchError((prev) =>
          new Map(prev).set(cheat.id, `This cheat's capture patch (${anchor.patchId}) is missing.`)
        )
        return
      }
      if (next) {
        const result = await window.tamper.applyPatch(patch)
        if (!result.ok) {
          setPatchError((prev) =>
            new Map(prev).set(cheat.id, result.error ?? 'Could not install the capture patch.')
          )
          return
        }
        setPatchEnabled((prev) => new Set(prev).add(patch.id))
      }
    }

    await window.tamper.toggleFreeze(cheat, next)

    // Restore only after the writing has stopped, so the last write can't
    // land through a slot that is about to stop being maintained.
    if (!next) {
      for (const anchor of anchors) {
        const patch = patches.find((p) => p.id === anchor.patchId)
        if (!patch) continue
        await window.tamper.restorePatch(patch)
        setPatchEnabled((prev) => {
          const copy = new Set(prev)
          copy.delete(patch.id)
          return copy
        })
      }
    }
    setEnabled((prev) => {
      const copy = new Set(prev)
      if (next) copy.add(cheat.id)
      else copy.delete(cheat.id)
      return copy
    })
    // Re-enabling clears any stale degraded warning; the loop starts fresh.
    if (next) {
      setDegraded((prev) => {
        const copy = new Set(prev)
        copy.delete(cheat.id)
        return copy
      })
    }
  }

  async function remove(cheat: CheatDefinition) {
    if (enabled.has(cheat.id)) await window.tamper.toggleFreeze(cheat, false)
    await window.tamper.deleteCheat(exeName, cheat.id)

    // Take the cheat's own capture patches with it. They are hidden from the
    // list, so anything left behind is invisible and unmanageable — and it
    // would still be installed in the game.
    const anchoredPatchIds = cheat.targets
      .filter((t): t is { kind: 'anchor'; patchId: string; offset: string } =>
        (t as { kind?: string }).kind === 'anchor'
      )
      .map((t) => t.patchId)
    for (const patchId of anchoredPatchIds) {
      const patch = patches.find((p) => p.id === patchId)
      if (!patch?.internal) continue // a patch the user made and manages
      await window.tamper.deleteCheat(exeName, patchId)
      setPatches((prev) => prev.filter((p) => p.id !== patchId))
    }

    setCheats((prev) => prev.filter((c) => c.id !== cheat.id))
    setEnabled((prev) => {
      const copy = new Set(prev)
      copy.delete(cheat.id)
      return copy
    })
  }

  async function togglePatch(patch: PatchCheat) {
    // patch:apply/patch:restore both throw when nothing is attached, and a
    // fast on/off double-click could otherwise interleave an in-flight apply
    // with a restore against an empty applied-set — disable the toggle for
    // the duration so the displayed state can't drift from reality.
    if (patchBusy.has(patch.id)) return
    const next = !patchEnabled.has(patch.id)
    setPatchError((prev) => {
      const copy = new Map(prev)
      copy.delete(patch.id)
      return copy
    })
    setPatchBusy((prev) => new Set(prev).add(patch.id))

    try {
      if (next) {
        const result = await window.tamper.applyPatch(patch)
        if (!result.ok) {
          // Stays off: an un-locatable or mismatched patch is never written.
          setPatchError((prev) => new Map(prev).set(patch.id, result.error ?? 'Patch failed'))
          return
        }
        setPatchEnabled((prev) => new Set(prev).add(patch.id))
      } else {
        const ok = await window.tamper.restorePatch(patch)
        if (!ok) {
          setPatchError((prev) => new Map(prev).set(patch.id, 'Restore failed'))
          return
        }
        setPatchEnabled((prev) => {
          const copy = new Set(prev)
          copy.delete(patch.id)
          return copy
        })
      }

      try {
        const status = await window.tamper.locatePatch(patch)
        setPatchStatuses((prev) => new Map(prev).set(patch.id, status))
      } catch {
        // Readout only — leave the previous status rather than blame the
        // apply/restore that just succeeded.
      }
    } catch (err) {
      // Not attached, or the native scan rejected on a malformed signature:
      // either way nothing was written, so the toggle must stay in its
      // pre-click state (next was never applied).
      setPatchError((prev) =>
        new Map(prev).set(patch.id, err instanceof Error ? err.message : 'Patch operation failed')
      )
    } finally {
      setPatchBusy((prev) => {
        const copy = new Set(prev)
        copy.delete(patch.id)
        return copy
      })
    }
  }

  async function removePatch(patch: PatchCheat) {
    // Main restores an applied patch as part of deletion, so the game's code
    // is clean regardless of the toggle state here.
    await window.tamper.deleteCheat(exeName, patch.id)
    setPatches((prev) => prev.filter((p) => p.id !== patch.id))
    setPatchEnabled((prev) => {
      const copy = new Set(prev)
      copy.delete(patch.id)
      return copy
    })
  }

  async function verify(cheat: CheatDefinition, useValue: boolean) {
    const expected = useValue && verifyValue.trim() !== '' ? Number(verifyValue) : null
    const result = await window.tamper.verifyCheat(cheat, expected)
    setStatuses((prev) => new Map(prev).set(cheat.id, result))
  }

  // Explicit prune (only offered after a value check): drop the targets
  // that didn't match the confirmed value. Unlike automatic revalidation,
  // this is a deliberate user action, so it removes them from the saved
  // cheat rather than just skipping them.
  async function pruneDead(cheat: CheatDefinition) {
    const result = statuses.get(cheat.id)
    if (!result) return
    const keptTargets = cheat.targets.filter((_, i) => result[i]?.alive)
    if (keptTargets.length === 0) return // never leave a cheat with zero targets
    const updated = { ...cheat, targets: keptTargets }
    await window.tamper.saveCheat(exeName, updated)
    setCheats((prev) => prev.map((c) => (c.id === cheat.id ? updated : c)))
    setStatuses((prev) => {
      const next = new Map(prev)
      next.delete(cheat.id)
      return next
    })
  }

  async function renameCheat(cheat: CheatDefinition, name: string) {
    const trimmed = name.trim()
    if (trimmed === '') return
    const updated = { ...cheat, name: trimmed }
    await window.tamper.saveCheat(exeName, updated)
    setCheats((prev) => prev.map((c) => (c.id === cheat.id ? updated : c)))
    setRenamingId(null)
  }

  async function renamePatch(patch: PatchCheat, name: string) {
    const trimmed = name.trim()
    if (trimmed === '') return
    const updated = { ...patch, name: trimmed }
    await window.tamper.saveCheat(exeName, updated)
    setPatches((prev) => prev.map((p) => (p.id === patch.id ? updated : p)))
    setRenamingId(null)
  }

  // MultiplierSlider's own range is fixed at 1x-20x (see its component and
  // EditPatchModal/EditCheatModal's matching validity bounds) — a cheat
  // deliberately tuned past that (e.g. a huge "instant level up" value set
  // directly in games/*.json, not through this UI) would otherwise render
  // a slider that clamps to its own max and silently misrepresents what's
  // actually installed. Falling back to the plain toggle for an
  // out-of-range factor is honest about what the control can and can't
  // show, rather than showing a control that lies.
  function inSliderRange(factor: number): boolean {
    return factor >= 1 && factor <= 20
  }

  // Writes a value cheat back to the profile. If it's enabled, restart the
  // freeze loop on it — targets, dataType, mode, or value may all have just
  // changed, and toggleFreeze(cheat, false) then true keeps a running cheat
  // from writing through a stale definition until it's next manually
  // toggled. Shared by the edit modal's Save and the inline multiplier
  // slider on a cheat's row — both are "the saved definition changed,
  // reassert it if live," just reached from different controls.
  async function persistCheatChange(next: CheatDefinition): Promise<void> {
    const wasEnabled = enabled.has(next.id)
    if (wasEnabled) await window.tamper.toggleFreeze(next, false)
    await window.tamper.saveCheat(exeName, next)
    setCheats((prev) => prev.map((c) => (c.id === next.id ? next : c)))
    if (wasEnabled) await window.tamper.toggleFreeze(next, true)
  }

  async function saveEditedCheat() {
    if (!editingCheat) return
    setEditError(null)
    try {
      await persistCheatChange(editingCheat)
      setEditingCheat(null)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    }
  }

  // A dedicated inline row control for a freeze cheat with multiplierBaseline
  // set — see EditCheatModal's own slider for why this exists at all.
  // Errors surface the same way saveEditedCheat's do, just without a modal
  // to close.
  async function commitMultiplier(cheat: CheatDefinition, factor: number) {
    if (cheat.multiplierBaseline === undefined) return
    try {
      await persistCheatChange({ ...cheat, value: factor * cheat.multiplierBaseline })
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    }
  }

  // Patch counterpart to persistCheatChange. Unlike a value cheat, an
  // enabled patch's install IS its value — force/scale mode encode `value`
  // straight into the installed bytes/cave slot (see cave_ops.cc's
  // encodeStore/EncodeScale) — so a live-toggled patch must be restored and
  // reapplied for a new value to actually take effect, not just have its
  // saved definition updated underneath it.
  async function persistPatchChange(next: PatchCheat): Promise<void> {
    const wasEnabled = patchEnabled.has(next.id)
    if (wasEnabled) await window.tamper.restorePatch(next)
    await window.tamper.saveCheat(exeName, next)
    setPatches((prev) => prev.map((p) => (p.id === next.id ? next : p)))
    if (wasEnabled) {
      const result = await window.tamper.applyPatch(next)
      if (!result.ok) {
        setPatchError((prev) => new Map(prev).set(next.id, result.error ?? 'Reapply after edit failed'))
      }
    }
  }

  async function saveEditedPatch() {
    if (!editingPatch) return
    setEditError(null)
    try {
      await persistPatchChange(editingPatch)
      setEditingPatch(null)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    }
  }

  // scale mode's `value` IS the multiplier directly (no baseline division
  // needed the way a freeze cheat's multiplierBaseline requires) — see
  // EditPatchModal's own slider.
  async function commitScaleFactor(patch: PatchCheat, factor: number) {
    try {
      await persistPatchChange({ ...patch, value: factor })
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    }
  }

// Only a restricted, unambiguous key set is accepted — see this feature's
// design doc for why (avoids needing a full browser-KeyEvent-to-Electron-
// accelerator mapping table for punctuation/media keys nobody's asking
// for). Returns null for a key not in that set.
// Electron's accelerator syntax for the numpad ("num0"-"num9", "numadd",
// "numsub", "nummult", "numdiv", "numdec") is a distinct set of key
// tokens from the top-row digits — binding one never collides with the
// other.
const NUMPAD_OPERATORS: Record<string, string> = {
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec'
}

function acceleratorKeyFor(e: KeyboardEvent): string | null {
  // e.code reports the physical key regardless of Shift/AltGr/layout —
  // e.key does not (e.g. Shift+1 on a US layout reports e.key "!", which
  // fails an [A-Za-z0-9] test even though the spec promises 0-9 work with
  // any modifier combination including Shift).
  const letter = e.code.match(/^Key([A-Z])$/)
  if (letter) return letter[1]
  const digit = e.code.match(/^Digit(\d)$/)
  if (digit) return digit[1]
  const fkey = e.code.match(/^F([1-9]|1[0-2])$/)
  if (fkey) return `F${fkey[1]}`
  const numpadDigit = e.code.match(/^Numpad(\d)$/)
  if (numpadDigit) return `num${numpadDigit[1]}`
  if (e.code in NUMPAD_OPERATORS) return NUMPAD_OPERATORS[e.code]
  return null
}

function buildAccelerator(e: KeyboardEvent): string | null {
  const key = acceleratorKeyFor(e)
  if (!key) return null
  const modifiers: string[] = []
  if (e.ctrlKey) modifiers.push('CommandOrControl')
  if (e.altKey) modifiers.push('Alt')
  if (e.shiftKey) modifiers.push('Shift')
  if (e.metaKey && !e.ctrlKey) modifiers.push('CommandOrControl') // Meta and Ctrl both map to the one cross-platform modifier
  // Numpad keys rarely overlap with normal game controls (unlike letters,
  // top-row digits, and F-keys, which commonly ARE game keybinds), so a
  // bare numpad key — no modifier required — is allowed, matching how
  // trainers like Cheat Engine/WeMod conventionally use the numpad.
  // acceleratorKeyFor's numpad keys are the only ones it returns starting
  // with "num" (num0-num9, numadd, numsub, nummult, numdiv, numdec).
  const isNumpadKey = key.startsWith('num')
  if (modifiers.length === 0 && !isNumpadKey) return null
  return modifiers.length === 0 ? key : [...new Set(modifiers)].join('+') + '+' + key
}

function startCapturingHotkey(id: string): void {
  setCapturingHotkeyId(id)
  setCapturedHotkey(null)
  setHotkeyError(null)
}

async function saveHotkey(cheat: StoredCheat, hotkey: string | null) {
  const conflict = hotkey
    ? [...cheats, ...patches].find((c) => c.id !== cheat.id && c.hotkey === hotkey)
    : undefined
  if (conflict) {
    setHotkeyError(`Hotkey already used by "${conflict.name}" — pick a different combo.`)
    return
  }
  try {
    const updated = { ...cheat, hotkey: hotkey ?? undefined }
    await window.tamper.saveCheat(exeName, updated)
    if (isPatch(updated)) {
      setPatches((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
    } else if (isScript(updated)) {
      setScripts((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
    } else {
      setCheats((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
    }
    setCapturingHotkeyId(null)
    setHotkeyError(null)
  } catch (err) {
    // An IPC rejection's message looks like `Error invoking remote method
    // 'cheats:save': Error: Hotkey already used by "X"...` — strip the
    // wrapper before showing it.
    const raw = (err as Error).message
    const cleaned = raw
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^Error:\s*/, '')
    setHotkeyError(cleaned)
  }
}

  function liveCount(cheat: CheatDefinition): number | null {
    const result = statuses.get(cheat.id)
    if (!result) return null
    return result.filter((s) => s.alive).length
  }

  // Saves a value cheat that reads through Mono metadata by name instead of
  // a scanned chain. Two shapes, both on store.ts's MonoTarget: a plain
  // static field (no instanceFieldName — the field Explorer resolved IS the
  // target) or, more commonly, an instance field reached via a static field
  // that holds the owning object (the [LocalPlayer]+Player.m_godMode shape:
  // instanceFieldName set, and staticFieldName names whatever static field
  // holds that object — className must own BOTH fields, since
  // resolveMonoTargetAddress resolves them against the same classHandle).
  async function saveMonoValueCheat() {
    if (pendingMonoSelection?.kind !== 'value' || !monoValueName) return
    if (monoValueIsInstance && !monoValueInstanceHolder.trim()) return
    const cheat: CheatDefinition = {
      id: monoValueName.toLowerCase().replace(/\s+/g, '-'),
      name: monoValueName,
      dataType: monoValueDataType,
      mode: monoValueMode,
      targets: [
        monoValueIsInstance
          ? {
              kind: 'mono',
              className: pendingMonoSelection.className,
              staticFieldName: monoValueInstanceHolder.trim(),
              instanceFieldName: pendingMonoSelection.fieldName
            }
          : {
              kind: 'mono',
              className: pendingMonoSelection.className,
              staticFieldName: pendingMonoSelection.fieldName
            }
      ],
      value: Number(monoValueValue)
    }
    await window.tamper.saveCheat(exeName, cheat)
    setCheats((prev) => [...prev.filter((c) => c.id !== cheat.id), cheat])
    setMonoValueName('')
    setMonoValueValue('')
    onConsumePendingMonoSelection?.()
  }

  // Saves a code patch anchored to a Mono class+method instead of a
  // module+RVA or an AOB signature (see anchor.ts's Path 0). Mono Explorer
  // resolves the method's compiled entry address by name, but never
  // captures the instruction bytes there is to NOP — that only happens via
  // Scanner's find-what-writes capture — so originalBytes/length are
  // manual/advanced entry here rather than pre-filled, in both modes this
  // form supports: locate() verifies them against live memory regardless of
  // mode (see patchEngine.ts's locate — the mismatch check isn't nop-only).
  // 'immune' additionally needs baseRegister and armValue — the live player
  // pointer resolved above — since immune has no self-arming moment to fall
  // back to (see PatchCheat.armValue's comment). force/capture/guard still
  // have no path here: they need a captured object address this screen has
  // no way to supply outside of Scanner's find-what-writes flow.
  async function saveMonoAnchorPatch() {
    if (pendingMonoSelection?.kind !== 'anchor' || !monoAnchorName) return
    const length = Number(monoAnchorLength)
    if (!Number.isInteger(length) || length <= 0 || monoAnchorBytes.trim() === '') return
    if (monoAnchorMode === 'immune' && !monoAnchorArmValue) return
    if (
      monoAnchorMode === 'immune' &&
      monoAnchorUseReturnValue &&
      (monoAnchorReturnValue.trim() === '' || !Number.isFinite(Number(monoAnchorReturnValue)))
    )
      return
    const patch: PatchCheat = {
      kind: 'patch',
      mode: monoAnchorMode,
      id: `patch-${monoAnchorName.toLowerCase().replace(/\s+/g, '-')}`,
      name: monoAnchorName,
      originalBytes: monoAnchorBytes.trim().toLowerCase(),
      length,
      signature: '',
      moduleName: null,
      moduleOffset: null,
      monoClass: pendingMonoSelection.className,
      monoMethod: pendingMonoSelection.methodName,
      ...(monoAnchorMode === 'immune'
        ? {
            baseRegister: monoAnchorBaseRegister.trim().toLowerCase(),
            // armValue is this session's resolved snapshot — kept as a
            // fallback for a future install attempt that can't re-resolve.
            // armPointerClassName/armPointerFieldName are the SOURCE
            // (Player.m_localPlayer, not the resolved value), so the
            // engine can re-resolve a fresh pointer on every install —
            // required after a game restart, when armValue alone would be
            // a dead pointer from the previous process instance.
            armValue: monoAnchorArmValue as string,
            armPointerClassName: monoAnchorPlayerClass.trim(),
            armPointerFieldName: monoAnchorPlayerField.trim(),
            ...(monoAnchorUseInstanceField && monoAnchorPlayerInstanceField.trim()
              ? { armPointerInstanceFieldName: monoAnchorPlayerInstanceField.trim() }
              : {}),
            ...(monoAnchorUseReturnValue
              ? { value: Number(monoAnchorReturnValue), dataType: monoAnchorReturnDataType }
              : {})
          }
        : {})
    }
    await window.tamper.saveCheat(exeName, patch)
    setPatches((prev) => [...prev.filter((p) => p.id !== patch.id), patch])
    setMonoAnchorName('')
    setMonoAnchorBytes('')
    setMonoAnchorLength('')
    setMonoAnchorMode('nop')
    setMonoAnchorArmValue(null)
    setMonoAnchorArmError(null)
    setMonoAnchorClassAmbiguity(null)
    setMonoAnchorUseInstanceField(false)
    setMonoAnchorPlayerInstanceField('')
    setMonoAnchorUseReturnValue(false)
    setMonoAnchorReturnValue('')
    onConsumePendingMonoSelection?.()
  }

  async function toggleScript(script: ScriptCheat, enabled: boolean) {
    setScriptError(null)
    // Routed through ScriptRuntime (scripts:toggle), not a raw scripts:run
    // call — this keeps the enable->disable `state` handoff and the
    // enabled-flag correct regardless of whether this cheat was last
    // toggled by a click or a hotkey (see this plan's Task 7).
    const result = await window.tamper.toggleScript(script, enabled)
    if (!result.ok) {
      setScriptError(result.error ?? 'Script failed.')
      return
    }
    setScriptEnabled((prev) => ({ ...prev, [script.id]: enabled }))
  }

  // Mirrors removePatch: main clears the runtime state as part of deletion
  // (cheats:delete calls scriptRuntime.clear), so the enabled flag here is
  // safe to drop regardless of the checkbox's state.
  async function removeScript(script: ScriptCheat) {
    await window.tamper.deleteCheat(exeName, script.id)
    setScripts((prev) => prev.filter((s) => s.id !== script.id))
    setScriptEnabled((prev) => {
      const copy = { ...prev }
      delete copy[script.id]
      return copy
    })
  }

  // saveCheat rejects on a hotkey conflict; without this the failure would
  // be an unhandled rejection and the dialog would just sit there.
  async function saveScript(script: ScriptCheat) {
    setScriptError(null)
    try {
      await window.tamper.saveCheat(exeName, script)
      setEditingScript(null)
      const all = await window.tamper.loadCheats(exeName)
      setScripts(all.filter(isScript))
    } catch (e) {
      setScriptError(e instanceof Error ? e.message : String(e))
    }
  }

  async function testScript(source: string) {
    setScriptError(null)
    // Deliberately the raw scripts:run call (not toggleScript) — this is
    // ScriptEditor's ad-hoc test button, running against a throwaway state,
    // possibly against a script that hasn't been saved yet at all.
    //
    // scripts:run THROWS when nothing is attached (unlike scripts:toggle,
    // which resolves {ok:false}), which is the likeliest first-use case of
    // all: without this catch the button did visibly nothing at all.
    try {
      const result = await window.tamper.runScript(source, {})
      if (!result.success) setScriptError(result.error ?? 'Script failed.')
      setScriptOutput(result.output)
    } catch (e) {
      setScriptError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <h2>{exeName}</h2>
      {changedModules.length > 0 && (
        <div className="banner">
          This game has updated since these cheats were captured
          ({changedModules.join(', ')}). They&apos;ll be verified against the new
          build when you turn them on.
        </div>
      )}
      <button onClick={importCheatTable} disabled={ctImporting}>
        {ctImporting ? 'Importing…' : 'Import Cheat Table (.CT)'}
      </button>
      <button onClick={exportCheatTable} disabled={ctExporting}>
        {ctExporting ? 'Exporting…' : 'Export to Cheat Table (.CT)'}
      </button>
      {ctImportResult && 'error' in ctImportResult && (
        <div className="banner" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>{ctImportResult.error}</p>
        </div>
      )}
      {ctImportResult && !('error' in ctImportResult) && (
        <div className="banner" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>
            Imported {ctImportResult.importedNames.length} cheat
            {ctImportResult.importedNames.length === 1 ? '' : 's'}
            {ctImportResult.skipped.length > 0
              ? `, skipped ${ctImportResult.skipped.length} (not the simple "replace one write with a fixed value" shape this importer supports).`
              : '.'}
          </p>
          {ctImportResult.importedNames.length > 0 && (
            <ul style={{ flexBasis: '100%' }}>
              {ctImportResult.importedNames.map((name) => (
                <li key={name}>✓ {name}</li>
              ))}
            </ul>
          )}
          {ctImportResult.skipped.length > 0 && (
            <ul style={{ flexBasis: '100%' }}>
              {ctImportResult.skipped.map((s, i) => (
                <li key={`${s.description}-${i}`} className="muted">
                  {s.description} — {s.reason}
                </li>
              ))}
            </ul>
          )}
          <button onClick={() => setCtImportResult(null)}>Dismiss</button>
        </div>
      )}

      {ctExportResult && (
        <div className="banner" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>
            {ctExportResult.exportedNames.length === 0 && ctExportResult.skipped.length === 0 ? (
              'No force-mode patches to export.'
            ) : (
              <>
                Exported {ctExportResult.exportedNames.length} cheat
                {ctExportResult.exportedNames.length === 1 ? '' : 's'}
                {ctExportResult.skipped.length > 0
                  ? `, skipped ${ctExportResult.skipped.length} (only 'force'-mode patches can be exported).`
                  : '.'}
              </>
            )}
          </p>
          {ctExportResult.exportedNames.length > 0 && (
            <ul style={{ flexBasis: '100%' }}>
              {ctExportResult.exportedNames.map((name) => (
                <li key={name}>✓ {name}</li>
              ))}
            </ul>
          )}
          {ctExportResult.skipped.length > 0 && (
            <ul style={{ flexBasis: '100%' }}>
              {ctExportResult.skipped.map((s, i) => (
                <li key={`${s.name}-${i}`} className="muted">
                  {s.name} — {s.reason}
                </li>
              ))}
            </ul>
          )}
          <button onClick={() => setCtExportResult(null)}>Dismiss</button>
        </div>
      )}

      {hotkeyConflicts.length > 0 && (
        <div className="banner" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>
            {hotkeyConflicts.length} hotkey{hotkeyConflicts.length === 1 ? '' : 's'} could not be
            registered — already in use by another app:
          </p>
          <ul style={{ flexBasis: '100%' }}>
            {hotkeyConflicts.map((c, i) => (
              <li key={`${c.name}-${i}`} className="muted">
                {c.name} ({c.hotkey})
              </li>
            ))}
          </ul>
          <button onClick={() => setHotkeyConflicts([])}>Dismiss</button>
        </div>
      )}

      {hotkeyFireError && (
        <div className="banner" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>
            Hotkey for "{hotkeyFireError.cheatName}" failed: {hotkeyFireError.message}
          </p>
          <button onClick={() => setHotkeyFireError(null)}>Dismiss</button>
        </div>
      )}

      {editError && (
        <div className="banner banner-error" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>Couldn't save the edit: {editError}</p>
          <button onClick={() => setEditError(null)}>Dismiss</button>
        </div>
      )}

      {memViewError && (
        <div className="banner banner-error" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>{memViewError}</p>
          <button onClick={() => setMemViewError(null)}>Dismiss</button>
        </div>
      )}

      {pendingMonoSelection?.kind === 'value' && (
        <div className="banner" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>
            From Mono Explorer: {pendingMonoSelection.className}.{pendingMonoSelection.fieldName}
          </p>
          <input
            placeholder="Cheat name"
            value={monoValueName}
            onChange={(e) => setMonoValueName(e.target.value)}
          />
          <select
            value={monoValueDataType}
            onChange={(e) => setMonoValueDataType(e.target.value as DataType)}
          >
            <option value="float">Float</option>
            <option value="double">Double</option>
            <option value="int32">Whole number (4 bytes)</option>
            <option value="int16">Whole number (2 bytes)</option>
            <option value="int64">Whole number (8 bytes)</option>
            <option value="int8">Byte (bool, e.g. a Mono bool field)</option>
          </select>
          <select
            value={monoValueMode}
            onChange={(e) => setMonoValueMode(e.target.value as CheatDefinition['mode'])}
          >
            <option value="freeze">Freeze (continuous)</option>
            <option value="oneshot">One-shot</option>
          </select>
          <input
            placeholder="Value"
            value={monoValueValue}
            onChange={(e) => setMonoValueValue(e.target.value)}
          />
          <label style={{ flexBasis: '100%' }}>
            <input
              type="checkbox"
              checked={monoValueIsInstance}
              onChange={(e) => setMonoValueIsInstance(e.target.checked)}
            />{' '}
            This field belongs to an object (e.g. the local player), not itself static
          </label>
          {monoValueIsInstance && (
            <input
              placeholder="Static field holding that object, e.g. m_localPlayer"
              value={monoValueInstanceHolder}
              onChange={(e) => setMonoValueInstanceHolder(e.target.value)}
            />
          )}
          <button
            onClick={saveMonoValueCheat}
            disabled={!monoValueName || (monoValueIsInstance && !monoValueInstanceHolder.trim())}
          >
            Save
          </button>
          <button onClick={() => onConsumePendingMonoSelection?.()}>Dismiss</button>
        </div>
      )}

      {pendingMonoSelection?.kind === 'anchor' && (
        <div className="banner" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>
            From Mono Explorer: {pendingMonoSelection.className}.{pendingMonoSelection.methodName} —
            manual entry, since Mono Explorer doesn&apos;t capture instruction bytes (only
            Scanner&apos;s find-what-writes does). Creates a patch anchored to this class+method
            instead of a module or a signature.
          </p>
          <p style={{ flexBasis: '100%' }}>
            These bytes only need to match what&apos;s actually there right now — they&apos;re a
            snapshot used to detect &quot;something else changed this code&quot; before installing,
            not the bytes that get overwritten. Click Read to fill them in from the method&apos;s
            live entry instead of guessing.
          </p>
          <button
            onClick={resolveMonoAnchorBytes}
            disabled={monoAnchorResolvingBytes}
            style={{ flexBasis: '100%' }}
          >
            {monoAnchorResolvingBytes ? 'Reading…' : `Read current bytes (${MONO_ANCHOR_SNAPSHOT_LENGTH})`}
          </button>
          {monoAnchorBytesError && (
            <p style={{ flexBasis: '100%', color: 'var(--error)' }}>{monoAnchorBytesError}</p>
          )}
          {monoAnchorMode === 'nop' && (
            <p style={{ flexBasis: '100%', color: 'var(--error)', fontWeight: 'bold' }}>
              ⚠ NOP mode overwrites exactly Length bytes at the method&apos;s ENTRY point with 0x90,
              which runs on every call. If Length doesn&apos;t span exactly whole instructions,
              installing writes over part of the next instruction — nothing here catches that, and
              it will corrupt the method every time it runs. The auto-filled snapshot above is
              NOT instruction-aligned; only use it as a starting point, and trim Length to a real
              instruction boundary yourself (e.g. with an external disassembler) before saving a
              NOP patch.
            </p>
          )}
          <input
            placeholder="Patch name"
            value={monoAnchorName}
            onChange={(e) => setMonoAnchorName(e.target.value)}
          />
          <input
            placeholder="Original bytes (unspaced hex, e.g. 894110)"
            value={monoAnchorBytes}
            onChange={(e) => setMonoAnchorBytes(e.target.value)}
          />
          <input
            placeholder="Length (bytes)"
            value={monoAnchorLength}
            onChange={(e) => setMonoAnchorLength(e.target.value)}
          />
          <select
            value={monoAnchorMode}
            onChange={(e) => setMonoAnchorMode(e.target.value as 'nop' | 'immune')}
          >
            <option value="nop">NOP (disable this instruction)</option>
            <option value="immune">Immune (skip the whole method for one object)</option>
          </select>
          {monoAnchorMode === 'immune' && (
            <>
              <p style={{ flexBasis: '100%' }}>
                Immune returns from the whole method immediately whenever it&apos;s called with a
                specific object as <code>this</code> — e.g. the local player, so damage aimed at
                you never applies. It needs the register holding <code>this</code> at entry, and
                that object&apos;s live pointer.
              </p>
              <input
                placeholder="This register (usually rcx)"
                value={monoAnchorBaseRegister}
                onChange={(e) => setMonoAnchorBaseRegister(e.target.value)}
              />
              <input
                placeholder="Class holding the static field, e.g. Player"
                value={monoAnchorPlayerClass}
                onChange={(e) => {
                  setMonoAnchorPlayerClass(e.target.value)
                  setMonoAnchorArmValue(null)
                  setMonoAnchorClassAmbiguity(null)
                }}
              />
              <input
                placeholder="Static field, e.g. m_localPlayer"
                value={monoAnchorPlayerField}
                onChange={(e) => {
                  setMonoAnchorPlayerField(e.target.value)
                  setMonoAnchorArmValue(null)
                }}
              />
              <label style={{ flexBasis: '100%' }}>
                <input
                  type="checkbox"
                  checked={monoAnchorUseInstanceField}
                  onChange={(e) => {
                    setMonoAnchorUseInstanceField(e.target.checked)
                    setMonoAnchorArmValue(null)
                  }}
                />{' '}
                Reached through an instance field on that object (e.g. the local player&apos;s own
                Skills, not the player itself)
              </label>
              {monoAnchorUseInstanceField && (
                <input
                  placeholder="Instance field on that same class, e.g. m_skills"
                  value={monoAnchorPlayerInstanceField}
                  onChange={(e) => {
                    setMonoAnchorPlayerInstanceField(e.target.value)
                    setMonoAnchorArmValue(null)
                  }}
                />
              )}
              <label style={{ flexBasis: '100%' }}>
                <input
                  type="checkbox"
                  checked={monoAnchorUseReturnValue}
                  onChange={(e) => setMonoAnchorUseReturnValue(e.target.checked)}
                />{' '}
                Force a specific value back from the matched call, instead of skipping it
                entirely (for a getter like GetHealth, where returning nothing isn&apos;t an
                option)
              </label>
              {monoAnchorUseReturnValue && (
                <>
                  <input
                    placeholder={`Value to return (${monoAnchorReturnDataType})`}
                    value={monoAnchorReturnValue}
                    onChange={(e) => setMonoAnchorReturnValue(e.target.value)}
                  />
                  <select
                    value={monoAnchorReturnDataType}
                    onChange={(e) => setMonoAnchorReturnDataType(e.target.value as DataType)}
                  >
                    <option value="float">float</option>
                    <option value="int32">int32</option>
                  </select>
                </>
              )}
              <button
                onClick={resolveMonoAnchorArmValue}
                disabled={
                  !monoAnchorPlayerClass ||
                  !monoAnchorPlayerField ||
                  (monoAnchorUseInstanceField && !monoAnchorPlayerInstanceField.trim()) ||
                  monoAnchorResolvingArm
                }
              >
                {monoAnchorResolvingArm ? 'Resolving…' : 'Resolve player pointer'}
              </button>
              {monoAnchorArmValue && (
                <p style={{ flexBasis: '100%' }}>
                  Resolved: <AddressChip label={monoAnchorArmValue} pulsing={false} />
                </p>
              )}
              {monoAnchorArmError && (
                <p style={{ flexBasis: '100%', color: 'var(--error)' }}>{monoAnchorArmError}</p>
              )}
              {monoAnchorClassAmbiguity && (
                <p style={{ flexBasis: '100%', color: 'var(--error)', fontWeight: 'bold' }}>
                  ⚠ &quot;{monoAnchorPlayerClass}&quot; exists in {monoAnchorClassAmbiguity.length}{' '}
                  loaded assemblies: {monoAnchorClassAmbiguity.join(', ')}. The pointer above was
                  resolved from whichever one came first — if that&apos;s not{' '}
                  {monoAnchorClassAmbiguity[0]} on purpose, check it against a value you already
                  trust (e.g. Mono Explorer&apos;s live-value watch on a field you know) before
                  arming a patch on it.
                </p>
              )}
            </>
          )}
          <button
            onClick={saveMonoAnchorPatch}
            disabled={
              !monoAnchorName ||
              !monoAnchorBytes ||
              !monoAnchorLength ||
              (monoAnchorMode === 'immune' && !monoAnchorArmValue) ||
              (monoAnchorMode === 'immune' &&
                monoAnchorUseReturnValue &&
                (monoAnchorReturnValue.trim() === '' || !Number.isFinite(Number(monoAnchorReturnValue))))
            }
          >
            Save
          </button>
          <button onClick={() => onConsumePendingMonoSelection?.()}>Dismiss</button>
        </div>
      )}

      {cheats.length > 0 && (
        <>
          <div className="section-head">
            <h3>Cheats</h3>
          </div>
          <div className="cheat-table">
            <div className="cheat-table-head">
              <span>Name</span>
              <span>Hotkey</span>
              <span>Target</span>
              <span>Mode</span>
              <span>Status</span>
              <span />
              <span />
            </div>
            {cheats.map((cheat) => {
              const live = liveCount(cheat)
              const result = statuses.get(cheat.id)
              const deadCount = result ? result.length - result.filter((s) => s.alive).length : 0
              const isEnabled = enabled.has(cheat.id)
              const isDegraded = degraded.has(cheat.id)
              const isRenaming = renamingId === cheat.id
              const isCapturingHotkey = capturingHotkeyId === cheat.id
              const isVerifying = verifyOpen === cheat.id

              const railState: RailState = isDegraded
                ? 'failed'
                : isEnabled && live === 0
                  ? 'failed'
                  : isEnabled
                    ? 'active'
                    : 'idle'

              const status: CheatRowVM['status'] = isDegraded
                ? { text: 'Not resolving — retrying, will resume if it comes back', tone: 'failed' }
                : live !== null
                  ? { text: `${live}/${cheat.targets.length} live`, tone: live === 0 ? 'failed' : 'muted' }
                  : { text: isEnabled ? 'enabled' : 'ready', tone: 'muted' }

              const subrowContent = (
                <>
                  {hotkeyError && isCapturingHotkey && (
                    <p style={{ color: 'var(--error)', margin: '0 0 8px' }}>{hotkeyError}</p>
                  )}
                  {isVerifying && (
                    <div>
                      <button onClick={() => verify(cheat, false)}>Check readability</button>
                      <input
                        placeholder="Current in-game value"
                        value={verifyValue}
                        onChange={(e) => setVerifyValue(e.target.value)}
                        style={{ marginLeft: 8 }}
                      />
                      <button onClick={() => verify(cheat, true)}>Verify against value</button>
                      {result && (
                        <>
                          <ul>
                            {cheat.targets.map((t, i) => (
                              <li key={targetKey(t, i)}>
                                <span className="address-chip">{targetLabel(t)}</span>
                                <span
                                  style={{
                                    color: result[i]?.alive ? 'var(--active)' : 'var(--error)'
                                  }}
                                >
                                  {result[i]?.alive
                                    ? `✓ ${result[i]?.value}`
                                    : result[i]?.value === null
                                      ? '✗ not resolving'
                                      : `✗ ${result[i]?.value} (mismatch)`}
                                </span>
                                {!isAnchor(t) && !isMono(t) && 'offsets' in t && t.offsets.length === 0 && (
                                  <button
                                    onClick={async () => {
                                      // t.baseOffset is module-relative, never an
                                      // absolute address on its own — resolve it
                                      // against the attached process's actual
                                      // module base before navigating, or this
                                      // jumps to a bogus address (see
                                      // ipc.ts's memory:resolveTargetAddress).
                                      const resolved = await window.tamper.resolveTargetAddress(
                                        t.moduleName,
                                        t.baseOffset
                                      )
                                      if (resolved === null) {
                                        console.warn(
                                          `Could not resolve ${t.moduleName}+${t.baseOffset} — is the module loaded?`
                                        )
                                        return
                                      }
                                      onViewInMemory(resolved)
                                    }}
                                  >
                                    View in Memory
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                          {deadCount > 0 && (live ?? 0) > 0 && (
                            <button onClick={() => pruneDead(cheat)}>
                              Remove {deadCount} non-matching target(s)
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </>
              )

              const vm: CheatRowVM = {
                id: cheat.id,
                name: cheat.name,
                hotkey: cheat.hotkey,
                targetLabel:
                  cheat.targets.length === 1
                    ? targetLabel(cheat.targets[0])
                    : `${cheat.targets.length} targets`,
                mode: cheat.mode,
                status,
                railState,
                control:
                  cheat.mode === 'freeze' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Toggle enabled={isEnabled} onChange={() => toggle(cheat)} />
                      {cheat.multiplierBaseline !== undefined &&
                        inSliderRange(cheat.value / cheat.multiplierBaseline) && (
                          <MultiplierSlider
                            factor={cheat.value / cheat.multiplierBaseline}
                            onCommit={(factor) => void commitMultiplier(cheat, factor)}
                          />
                        )}
                    </div>
                  ) : (
                    <button className="btn-sm" onClick={() => window.tamper.oneShot(cheat)}>
                      Apply
                    </button>
                  ),
                menuItems: [
                  { label: 'Edit…', onClick: () => setEditingCheat(cheat) },
                  {
                    label: 'Rename',
                    onClick: () => {
                      setRenamingId(cheat.id)
                      setRenameValue(cheat.name)
                    }
                  },
                  {
                    label: cheat.hotkey ? 'Change hotkey' : 'Set hotkey',
                    onClick: () => startCapturingHotkey(cheat.id)
                  },
                  ...(cheat.hotkey
                    ? [{ label: 'Clear hotkey', onClick: () => saveHotkey(cheat, null) }]
                    : []),
                  {
                    label: isVerifying ? 'Hide verify' : 'Verify…',
                    onClick: () => setVerifyOpen(isVerifying ? null : cheat.id)
                  },
                  { label: 'View in Memory', onClick: () => viewCheatInMemory(cheat) },
                  { label: 'Delete', danger: true, onClick: () => remove(cheat) }
                ],
                subrow: hotkeyError && isCapturingHotkey ? subrowContent : isVerifying ? subrowContent : undefined,
                renaming: isRenaming
                  ? {
                      value: renameValue,
                      onChange: setRenameValue,
                      onCommit: () => renameCheat(cheat, renameValue),
                      onCancel: () => setRenamingId(null)
                    }
                  : undefined,
                hotkeyCapturing: isCapturingHotkey
                  ? { value: capturedHotkey, onCancel: () => setCapturingHotkeyId(null) }
                  : undefined,
                onStartHotkeyCapture: () => startCapturingHotkey(cheat.id)
              }

              return <CheatRow key={cheat.id} vm={vm} />
            })}
          </div>
        </>
      )}

      {patches.filter((p) => !p.internal).length > 0 && (
        <>
          <div className="section-head">
            <h3>Code patches</h3>
          </div>
          <div className="cheat-table">
            <div className="cheat-table-head">
              <span>Name</span>
              <span>Hotkey</span>
              <span>Target</span>
              <span>Mode</span>
              <span>Status</span>
              <span />
              <span />
            </div>
            {/* Capture patches created to anchor a value cheat are plumbing,
                not something to toggle: the cheat they belong to drives them.
                Showing them would put two rows in the list for one cheat. */}
            {patches.filter((p) => !p.internal).map((patch) => {
              const status = patchStatuses.get(patch.id)
              const runtimeStatus = cheatStates.get(patch.id)
              const error = patchError.get(patch.id)
              const slotInfo = patchSlots.get(patch.id)
              const isEnabled = patchEnabled.has(patch.id)
              const isRenaming = renamingId === patch.id
              const isCapturingHotkey = capturingHotkeyId === patch.id

              const railState: RailState = runtimeStatus
                ? runtimeStatus.state === 'failed' || runtimeStatus.state === 'degraded'
                  ? 'failed'
                  : runtimeStatus.state === 'arming'
                    ? 'arming'
                    : runtimeStatus.state === 'active'
                      ? runtimeStatus.unverified
                        ? 'stale'
                        : 'active'
                      : 'idle'
                : error
                  ? 'failed'
                  : isEnabled
                    ? 'active'
                    : 'idle'

              const rowStatus: CheatRowVM['status'] = runtimeStatus
                ? {
                    text: cheatStateLabel(runtimeStatus),
                    tone:
                      runtimeStatus.state === 'failed' || runtimeStatus.state === 'degraded'
                        ? 'failed'
                        : runtimeStatus.state === 'active'
                          ? 'active'
                          : 'muted'
                  }
                : status
                  ? { text: patchStatusLabel(status), tone: status.applicable ? 'muted' : 'failed' }
                  : { text: isEnabled ? 'enabled' : 'ready', tone: 'muted' }

              const captureLabel =
                (patch.mode === 'capture' || patch.mode === 'guard') && isEnabled
                  ? slotInfo?.pointer
                    ? `${patch.mode === 'guard' ? 'protecting' : 'captured'} ${slotInfo.pointer}`
                    : 'waiting for the game to run this code'
                  : null

              const targetLbl = patch.moduleName
                ? `${patch.moduleName}+${patch.moduleOffset}`
                : `AOB ${patch.length}b`

              const vm: CheatRowVM = {
                id: patch.id,
                name: patch.name,
                hotkey: patch.hotkey,
                targetLabel: captureLabel ? `${targetLbl} — ${captureLabel}` : targetLbl,
                // Every real mode gets its own label — a ternary chain that
                // falls through to 'nop' for anything it doesn't explicitly
                // list silently mislabels every mode added after it was
                // written (immune/copy/scale all did, before this).
                mode: patch.mode ?? 'nop',
                status: rowStatus,
                railState,
                control: (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Toggle
                      enabled={isEnabled}
                      onChange={() => togglePatch(patch)}
                      disabled={patchBusy.has(patch.id)}
                    />
                    {patch.mode === 'scale' && inSliderRange(patch.value ?? 1) && (
                      <MultiplierSlider
                        factor={patch.value ?? 1}
                        onCommit={(factor) => void commitScaleFactor(patch, factor)}
                      />
                    )}
                  </div>
                ),
                menuItems: [
                  // Only force/immune/scale patches carry a value/dataType
                  // of their own to retune — nop has neither, and
                  // capture/guard's value lives on the anchored value cheat
                  // instead (edit that cheat's "Edit…" to change it). scale
                  // also has the inline slider above now, but the modal
                  // stays reachable too — e.g. to see/set dataType, or on a
                  // platform where dragging a tiny row slider is awkward.
                  ...((patch.mode ?? 'nop') === 'force' || patch.mode === 'immune' || patch.mode === 'scale'
                    ? [{ label: 'Edit…', onClick: () => setEditingPatch(patch) }]
                    : []),
                  {
                    label: 'Rename',
                    onClick: () => {
                      setRenamingId(patch.id)
                      setRenameValue(patch.name)
                    }
                  },
                  {
                    label: patch.hotkey ? 'Change hotkey' : 'Set hotkey',
                    onClick: () => startCapturingHotkey(patch.id)
                  },
                  ...(patch.hotkey
                    ? [{ label: 'Clear hotkey', onClick: () => saveHotkey(patch, null) }]
                    : []),
                  // status.address is already resolved (locatePatch ran on
                  // attach/toggle) — no fresh IPC round-trip needed, unlike
                  // a value cheat's viewCheatInMemory above. Absent when
                  // the patch hasn't located at all (module not loaded, no
                  // signature match) — nothing to navigate to yet.
                  ...(status?.address
                    ? [{ label: 'View in Memory', onClick: () => onViewInMemory(status.address as string) }]
                    : []),
                  { label: 'Delete', danger: true, onClick: () => removePatch(patch) }
                ],
                subrow:
                  error || (hotkeyError && isCapturingHotkey) ? (
                    <>
                      {hotkeyError && isCapturingHotkey && (
                        <p style={{ color: 'var(--error)', margin: 0 }}>{hotkeyError}</p>
                      )}
                      {error && <p style={{ color: 'var(--error)', margin: 0 }}>{error}</p>}
                    </>
                  ) : undefined,
                renaming: isRenaming
                  ? {
                      value: renameValue,
                      onChange: setRenameValue,
                      onCommit: () => renamePatch(patch, renameValue),
                      onCancel: () => setRenamingId(null)
                    }
                  : undefined,
                hotkeyCapturing: isCapturingHotkey
                  ? { value: capturedHotkey, onCancel: () => setCapturingHotkeyId(null) }
                  : undefined,
                onStartHotkeyCapture: () => startCapturingHotkey(patch.id)
              }

              return <CheatRow key={patch.id} vm={vm} />
            })}
          </div>
        </>
      )}

      <div className="section-head">
        <h3>Scripts</h3>
      </div>
      <div className="cheat-table">
        <div className="cheat-table-head">
          <span>Name</span>
          <span>Hotkey</span>
          <span>Target</span>
          <span>Mode</span>
          <span>Status</span>
          <span />
          <span />
        </div>
        {scripts.map((script) => {
          const isEnabled = scriptEnabled[script.id] ?? false
          const isRenaming = renamingId === script.id
          const isCapturingHotkey = capturingHotkeyId === script.id
          const vm: CheatRowVM = {
            id: script.id,
            name: script.name,
            hotkey: script.hotkey,
            targetLabel: '—',
            mode: 'script',
            status: { text: isEnabled ? 'enabled' : 'ready', tone: 'muted' },
            railState: isEnabled ? 'active' : 'idle',
            control: (
              <input
                type="checkbox"
                checked={isEnabled}
                onChange={(e) => void toggleScript(script, e.target.checked)}
              />
            ),
            menuItems: [
              { label: 'Edit script…', onClick: () => setEditingScript(script) },
              {
                label: isRenaming ? 'Renaming…' : 'Rename',
                disabled: isRenaming,
                onClick: () => {
                  setRenamingId(script.id)
                  setRenameValue(script.name)
                }
              },
              {
                label: script.hotkey ? 'Change hotkey' : 'Set hotkey',
                onClick: () => startCapturingHotkey(script.id)
              },
              ...(script.hotkey
                ? [{ label: 'Clear hotkey', onClick: () => saveHotkey(script, null) }]
                : []),
              { label: 'Delete', danger: true, onClick: () => removeScript(script) }
            ],
            subrow:
              hotkeyError && isCapturingHotkey ? (
                <p style={{ color: 'var(--error)', margin: 0 }}>{hotkeyError}</p>
              ) : undefined,
            renaming: isRenaming
              ? {
                  value: renameValue,
                  onChange: setRenameValue,
                  onCommit: () => {
                    const trimmed = renameValue.trim()
                    if (trimmed === '') {
                      setRenamingId(null)
                      return
                    }
                    void saveScript({ ...script, name: trimmed }).then(() => setRenamingId(null))
                  },
                  onCancel: () => setRenamingId(null)
                }
              : undefined,
            hotkeyCapturing: isCapturingHotkey
              ? { value: capturedHotkey, onCancel: () => setCapturingHotkeyId(null) }
              : undefined,
            onStartHotkeyCapture: () => startCapturingHotkey(script.id)
          }
          return (
            <div key={script.id} onDoubleClick={() => setEditingScript(script)}>
              <CheatRow vm={vm} />
            </div>
          )
        })}
        <div className="toolbar" style={{ padding: '8px 12px' }}>
          <button
            onClick={() =>
              setEditingScript({
                kind: 'script',
                id: `script-${Date.now()}`,
                name: 'New Script',
                enableScript: '',
                disableScript: ''
              })
            }
          >
            + New Script
          </button>
        </div>
      </div>

      {editingCheat && (
        <EditCheatModal
          cheat={editingCheat}
          onChange={setEditingCheat}
          onSave={() => void saveEditedCheat()}
          onClose={() => {
            setEditingCheat(null)
            setEditError(null)
          }}
        />
      )}

      {editingPatch && (
        <EditPatchModal
          patch={editingPatch}
          onChange={setEditingPatch}
          onSave={() => void saveEditedPatch()}
          onClose={() => {
            setEditingPatch(null)
            setEditError(null)
          }}
        />
      )}

      {editingScript && (
        <ScriptEditor
          script={editingScript}
          onChange={setEditingScript}
          onSave={() => void saveScript(editingScript)}
          onClose={() => setEditingScript(null)}
          onRun={(source) => void testScript(source)}
          output={scriptOutput}
          error={scriptError}
        />
      )}

      {cheats.length === 0 && patches.length === 0 && scripts.length === 0 && (
        <p>No cheats yet for {exeName}. Scan for one to get started.</p>
      )}
    </div>
  )
}
