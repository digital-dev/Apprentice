import { useEffect, useState } from 'react'
import type { CheatDefinition } from '../../../main/store'
import type { TargetStatus } from '../tamper.d'
import Toggle from '../components/Toggle'
import AddressChip from '../components/AddressChip'

export default function CheatList({
  exeName,
  onOpenScanner
}: {
  exeName: string
  onOpenScanner: () => void
}) {
  const [cheats, setCheats] = useState<CheatDefinition[]>([])
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
      const loaded = await window.tamper.loadCheats(exeName)
      setCheats(loaded)
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
                    ? cheat.targets[0].baseOffset
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
                          <li key={`${t.moduleName}-${t.baseOffset}-${i}`}>
                            <span className="address-chip">
                              {t.moduleName} {t.baseOffset}
                            </span>
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
      {cheats.length === 0 && <p>No cheats yet for {exeName}. Scan for one to get started.</p>}
    </div>
  )
}
