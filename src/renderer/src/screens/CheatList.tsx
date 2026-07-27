import { useEffect, useState } from 'react'
import type { CheatDefinition, StoredCheat, PatchCheat, CheatTarget } from '../../../main/store'
import type { TargetStatus, PatchStatus } from '../tamper.d'
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

function targetLabel(target: CheatTarget): string {
  return isAnchor(target) ? `${target.patchId} +${target.offset}` : target.baseOffset
}

function targetKey(target: CheatTarget, index: number): string {
  return isAnchor(target)
    ? `anchor-${target.patchId}-${index}`
    : `${target.moduleName}-${target.baseOffset}-${index}`
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

export default function CheatList({
  exeName,
  onOpenScanner
}: {
  exeName: string
  onOpenScanner: () => void
}) {
  const [cheats, setCheats] = useState<CheatDefinition[]>([])
  const [patches, setPatches] = useState<PatchCheat[]>([])
  // Where each patch currently sits and whether it's safe to toggle on.
  // Checked once on attach and refreshed after each toggle.
  const [patchStatuses, setPatchStatuses] = useState<Map<string, PatchStatus>>(new Map())
  const [patchEnabled, setPatchEnabled] = useState<Set<string>>(new Set())
  const [patchError, setPatchError] = useState<Map<string, string>>(new Map())
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

  async function toggle(cheat: CheatDefinition) {
    const next = !enabled.has(cheat.id)
    await window.tamper.toggleFreeze(cheat, next)
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

  return (
    <div>
      <h2>{exeName}</h2>
      <button onClick={onOpenScanner}>+ New cheat</button>
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
          {patches.map((patch) => {
            const status = patchStatuses.get(patch.id)
            const error = patchError.get(patch.id)
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
                <span className="address-chip">code patch</span>
                {status && (
                  <span
                    className="address-chip"
                    style={{ color: status.applicable ? 'var(--muted)' : 'var(--error)' }}
                  >
                    {patchStatusLabel(status)}
                  </span>
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
