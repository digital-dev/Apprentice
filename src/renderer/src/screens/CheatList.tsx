import { useEffect, useRef, useState } from 'react'
import type { CheatDefinition, StoredCheat, PatchCheat, CheatTarget, DataType } from '../../../main/store'
import type { TargetStatus, PatchStatus, CheatStatus } from '../tamper.d'
import type { PendingMonoSelection } from '../App'
import Toggle from '../components/Toggle'
import AddressChip from '../components/AddressChip'
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
  // Runtime state pushed by cheatRuntime for each armed patch — keyed by
  // patch id, same as patchStatuses. Populated only once a patch has been
  // toggled on at least once; patchStatusLabel covers the pre-arm readout.
  const [cheatStates, setCheatStates] = useState<Map<string, CheatStatus>>(new Map())
  // Modules whose on-disk fingerprint no longer matches what was captured
  // against — drives the "this game has updated" banner.
  const [changedModules, setChangedModules] = useState<string[]>([])

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
  const [ctImportResult, setCtImportResult] = useState<{
    importedNames: string[]
    skipped: { description: string; reason: string }[]
  } | null>(null)

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
      // Saved directly by the main process (see ipc.ts's ct:import) —
      // reload from disk rather than reconstructing PatchCheat objects
      // here, so this stays in sync with whatever the save path actually
      // persisted.
      const all: StoredCheat[] = await window.tamper.loadCheats(exeName)
      setCheats(all.filter((c): c is CheatDefinition => !isPatch(c)))
      setPatches(all.filter(isPatch))
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
      if (isPatchId) {
        setPatchEnabled((prev) => {
          if (outcome !== 'on' && outcome !== 'off') return prev
          const next = new Set(prev)
          if (outcome === 'on') next.add(cheatId)
          else next.delete(cheatId)
          return next
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
        const found = [...cheatsRef.current, ...patchesRef.current].find((c) => c.id === cheatId)
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
  useEffect(() => {
    if (capturingHotkeyId === null) return
    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault()
      const accelerator = buildAccelerator(e)
      if (!accelerator) {
        setHotkeyError(
          'Use a letter, number, or function key with at least one modifier — or a numpad key on its own.'
        )
        return
      }
      setHotkeyError(null)
      setCapturedHotkey(accelerator)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [capturingHotkeyId])

  useEffect(() => {
    async function loadAndRevalidate() {
      const all: StoredCheat[] = await window.tamper.loadCheats(exeName)
      const loaded = all.filter((c): c is CheatDefinition => !isPatch(c))
      const loadedPatches = all.filter(isPatch)
      setCheats(loaded)
      setPatches(loadedPatches)

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

      {ctImportResult && (
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

      <ul>
        {cheats.map((cheat) => {
          const live = liveCount(cheat)
          const result = statuses.get(cheat.id)
          const deadCount = result ? result.length - result.filter((s) => s.alive).length : 0
          return (
            <li key={cheat.id} style={{ flexWrap: 'wrap' }}>
              {renamingId === cheat.id ? (
                <>
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    style={{ maxWidth: 200 }}
                  />
                  <button
                    onClick={() => renameCheat(cheat, renameValue)}
                    disabled={renameValue.trim() === ''}
                  >
                    Save
                  </button>
                  <button onClick={() => setRenamingId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span>{cheat.name}</span>
                  <button
                    onClick={() => {
                      setRenamingId(cheat.id)
                      setRenameValue(cheat.name)
                    }}
                  >
                    Rename
                  </button>
                </>
              )}
              {capturingHotkeyId === cheat.id ? (
                <>
                  <span className="address-chip">{capturedHotkey ?? 'Press keys…'}</span>
                  <button
                    onClick={() => saveHotkey(cheat, capturedHotkey)}
                    disabled={capturedHotkey === null}
                  >
                    Save
                  </button>
                  <button onClick={() => setCapturingHotkeyId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  {cheat.hotkey && <span className="address-chip">{cheat.hotkey}</span>}
                  <button onClick={() => startCapturingHotkey(cheat.id)}>
                    {cheat.hotkey ? 'Change hotkey' : 'Set hotkey'}
                  </button>
                  {cheat.hotkey && (
                    <button onClick={() => saveHotkey(cheat, null)}>Clear hotkey</button>
                  )}
                </>
              )}
              {hotkeyError && capturingHotkeyId === cheat.id && (
                <span style={{ color: 'var(--error)', flexBasis: '100%' }}>{hotkeyError}</span>
              )}
              <AddressChip
                label={
                  cheat.targets.length === 1
                    ? targetLabel(cheat.targets[0])
                    : `${cheat.targets.length} targets`
                }
                pulsing={enabled.has(cheat.id) && !degraded.has(cheat.id)}
              />
              {live !== null && (
                <span
                  className="address-chip"
                  style={{ color: live === 0 ? 'var(--error)' : 'var(--muted)' }}
                >
                  {live}/{cheat.targets.length} live
                </span>
              )}
              {degraded.has(cheat.id) && (
                <span style={{ color: 'var(--error)' }}>
                  Not resolving — retrying, will resume if it comes back
                </span>
              )}
              {cheat.mode === 'freeze' ? (
                <Toggle enabled={enabled.has(cheat.id)} onChange={() => toggle(cheat)} />
              ) : (
                <button onClick={() => window.tamper.oneShot(cheat)}>Apply</button>
              )}
              <button onClick={() => setVerifyOpen(verifyOpen === cheat.id ? null : cheat.id)}>
                Verify
              </button>
              <button onClick={() => remove(cheat)}>Delete</button>

              {verifyOpen === cheat.id && (
                <div style={{ flexBasis: '100%', marginTop: 8, paddingLeft: 12 }}>
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
                              style={{ color: result[i]?.alive ? 'var(--active)' : 'var(--error)' }}
                            >
                              {result[i]?.alive
                                ? `✓ ${result[i]?.value}`
                                : result[i]?.value === null
                                  ? '✗ not resolving'
                                  : `✗ ${result[i]?.value} (mismatch)`}
                            </span>
                            {!isAnchor(t) && !isMono(t) && 'offsets' in t && t.offsets.length === 0 && (
                              <button onClick={() => onViewInMemory(t.baseOffset)}>
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
            </li>
          )
        })}
      </ul>
      {patches.length > 0 && (
        <ul>
          {/* Capture patches created to anchor a value cheat are plumbing,
              not something to toggle: the cheat they belong to drives them.
              Showing them would put two rows in the list for one cheat. */}
          {patches.filter((p) => !p.internal).map((patch) => {
            const status = patchStatuses.get(patch.id)
            const runtimeStatus = cheatStates.get(patch.id)
            const error = patchError.get(patch.id)
            const slotInfo = patchSlots.get(patch.id)
            return (
              <li key={patch.id} style={{ flexWrap: 'wrap' }}>
                {renamingId === patch.id ? (
                  <>
                    <input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      style={{ maxWidth: 200 }}
                    />
                    <button
                      onClick={() => renamePatch(patch, renameValue)}
                      disabled={renameValue.trim() === ''}
                    >
                      Save
                    </button>
                    <button onClick={() => setRenamingId(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span>{patch.name}</span>
                    <button
                      onClick={() => {
                        setRenamingId(patch.id)
                        setRenameValue(patch.name)
                      }}
                    >
                      Rename
                    </button>
                  </>
                )}
                {capturingHotkeyId === patch.id ? (
                  <>
                    <span className="address-chip">{capturedHotkey ?? 'Press keys…'}</span>
                    <button
                      onClick={() => saveHotkey(patch, capturedHotkey)}
                      disabled={capturedHotkey === null}
                    >
                      Save
                    </button>
                    <button onClick={() => setCapturingHotkeyId(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    {patch.hotkey && <span className="address-chip">{patch.hotkey}</span>}
                    <button onClick={() => startCapturingHotkey(patch.id)}>
                      {patch.hotkey ? 'Change hotkey' : 'Set hotkey'}
                    </button>
                    {patch.hotkey && (
                      <button onClick={() => saveHotkey(patch, null)}>Clear hotkey</button>
                    )}
                  </>
                )}
                {hotkeyError && capturingHotkeyId === patch.id && (
                  <span style={{ color: 'var(--error)', flexBasis: '100%' }}>{hotkeyError}</span>
                )}
                <AddressChip
                  label={
                    patch.moduleName
                      ? `${patch.moduleName}+${patch.moduleOffset}`
                      : `AOB ${patch.length}b`
                  }
                  pulsing={patchEnabled.has(patch.id)}
                />
                <span className="address-chip">
                  {patch.mode === 'capture'
                    ? 'capture'
                    : patch.mode === 'force'
                      ? 'force'
                      : patch.mode === 'guard'
                        ? 'guard'
                        : 'code patch'}
                </span>
                {(patch.mode === 'capture' || patch.mode === 'guard') &&
                  patchEnabled.has(patch.id) && (
                  // The address an anchored cheat resolves through. Shown so
                  // authoring one doesn't mean inferring the object's address
                  // from a pair of value scans and some subtraction.
                  <span className="address-chip" title="Use this patch's id as an anchor patchId">
                    {slotInfo?.pointer
                      ? `${patch.mode === 'guard' ? 'protecting' : 'captured'} ${slotInfo.pointer}`
                      : 'waiting for the game to run this code'}
                  </span>
                  )}
                {runtimeStatus ? (
                  // Once a patch has been toggled on at least once, the
                  // runtime's state machine is the more informative readout
                  // — it covers what patchStatusLabel can't: arming/backoff,
                  // degraded-after-active, and "active but the game build
                  // changed since capture".
                  <span
                    className="address-chip"
                    style={{
                      color:
                        runtimeStatus.state === 'failed' || runtimeStatus.state === 'degraded'
                          ? 'var(--error)'
                          : runtimeStatus.state === 'active'
                            ? 'var(--active)'
                            : 'var(--muted)'
                    }}
                  >
                    {cheatStateLabel(runtimeStatus)}
                  </span>
                ) : (
                  status && (
                    <span
                      className="address-chip"
                      style={{ color: status.applicable ? 'var(--muted)' : 'var(--error)' }}
                    >
                      {patchStatusLabel(status)}
                    </span>
                  )
                )}
                <Toggle
                  enabled={patchEnabled.has(patch.id)}
                  onChange={() => togglePatch(patch)}
                  disabled={patchBusy.has(patch.id)}
                />
                <button onClick={() => removePatch(patch)}>Delete</button>
                {error && (
                  <span style={{ color: 'var(--error)', flexBasis: '100%' }}>{error}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {cheats.length === 0 && patches.length === 0 && (
        <p>No cheats yet for {exeName}. Scan for one to get started.</p>
      )}
    </div>
  )
}
