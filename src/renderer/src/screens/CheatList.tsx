import { useEffect, useState } from 'react'
import type { CheatDefinition, StoredCheat, PatchCheat, CheatTarget, DataType } from '../../../main/store'
import type { TargetStatus, PatchStatus, CheatStatus } from '../tamper.d'
import type { PendingMonoSelection } from '../App'
import Toggle from '../components/Toggle'
import AddressChip from '../components/AddressChip'

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
  onOpenScanner,
  onOpenMonoExplorer,
  pendingMonoSelection,
  onConsumePendingMonoSelection
}: {
  exeName: string
  onOpenScanner: () => void
  onOpenMonoExplorer?: () => void
  // A selection handed over from Mono Explorer, if the user just came from
  // there ("use as value target" / "use as patch anchor"). Pre-fills the
  // matching mini creation form below; onConsumePendingMonoSelection clears
  // it once saved or dismissed so it doesn't linger into a later, unrelated
  // visit to this screen.
  pendingMonoSelection?: PendingMonoSelection | null
  onConsumePendingMonoSelection?: () => void
}) {
  const [cheats, setCheats] = useState<CheatDefinition[]>([])
  const [patches, setPatches] = useState<PatchCheat[]>([])
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
  const [monoAnchorName, setMonoAnchorName] = useState('')
  const [monoAnchorBytes, setMonoAnchorBytes] = useState('')
  const [monoAnchorLength, setMonoAnchorLength] = useState('')

  useEffect(() => {
    window.tamper.onCheatState(({ cheatId, status }) => {
      setCheatStates((prev) => new Map(prev).set(cheatId, status))
    })
    window.tamper.onGameState((state) => setChangedModules(state.changedModules))
    void window.tamper.currentGame().then((state) => setChangedModules(state.changedModules))
  }, [])

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

  function liveCount(cheat: CheatDefinition): number | null {
    const result = statuses.get(cheat.id)
    if (!result) return null
    return result.filter((s) => s.alive).length
  }

  // Saves a value cheat that reads through Mono metadata by name instead of
  // a scanned chain — the [ClassName].[staticFieldName] shape a plain
  // static field resolves to on its own (no instanceFieldName: see
  // store.ts's MonoTarget doc). This is the "existing cheat-creation form"
  // Mono Explorer's "use as value target" hands its selection to; there was
  // no such form for a Mono target before this screen existed, so this is
  // new but deliberately as small as Scanner's own save().
  async function saveMonoValueCheat() {
    if (pendingMonoSelection?.kind !== 'value' || !monoValueName) return
    const cheat: CheatDefinition = {
      id: monoValueName.toLowerCase().replace(/\s+/g, '-'),
      name: monoValueName,
      dataType: monoValueDataType,
      mode: monoValueMode,
      targets: [
        {
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
  // manual/advanced entry here rather than pre-filled. Deliberately scoped
  // to mode 'nop' (needs nothing beyond the bytes to NOP); force/capture/
  // guard need a base register and a captured object address that this
  // screen has no way to supply.
  async function saveMonoAnchorPatch() {
    if (pendingMonoSelection?.kind !== 'anchor' || !monoAnchorName) return
    const length = Number(monoAnchorLength)
    if (!Number.isInteger(length) || length <= 0 || monoAnchorBytes.trim() === '') return
    const patch: PatchCheat = {
      kind: 'patch',
      mode: 'nop',
      id: `patch-${monoAnchorName.toLowerCase().replace(/\s+/g, '-')}`,
      name: monoAnchorName,
      originalBytes: monoAnchorBytes.trim().toLowerCase(),
      length,
      signature: '',
      moduleName: null,
      moduleOffset: null,
      monoClass: pendingMonoSelection.className,
      monoMethod: pendingMonoSelection.methodName
    }
    await window.tamper.saveCheat(exeName, patch)
    setPatches((prev) => [...prev.filter((p) => p.id !== patch.id), patch])
    setMonoAnchorName('')
    setMonoAnchorBytes('')
    setMonoAnchorLength('')
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
      <button onClick={onOpenScanner}>+ New cheat</button>
      {onOpenMonoExplorer && <button onClick={onOpenMonoExplorer}>Mono Explorer</button>}

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
            <option value="int32">Whole number</option>
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
          <button onClick={saveMonoValueCheat} disabled={!monoValueName}>
            Save
          </button>
          <button onClick={() => onConsumePendingMonoSelection?.()}>Dismiss</button>
        </div>
      )}

      {pendingMonoSelection?.kind === 'anchor' && (
        <div className="banner" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>
            From Mono Explorer: {pendingMonoSelection.className}.{pendingMonoSelection.methodName} —
            manual entry, since Mono Explorer doesn't capture instruction bytes (only
            Scanner&apos;s find-what-writes does). Creates a NOP patch anchored to this class+method
            instead of a module or a signature.
          </p>
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
          <button
            onClick={saveMonoAnchorPatch}
            disabled={!monoAnchorName || !monoAnchorBytes || !monoAnchorLength}
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
              <span>{cheat.name}</span>
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
                <span>{patch.name}</span>
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
