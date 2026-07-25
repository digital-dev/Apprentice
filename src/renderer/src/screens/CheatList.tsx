import { useEffect, useState } from 'react'
import type { CheatDefinition } from '../../../main/store'
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
  const [broken, setBroken] = useState<Set<string>>(new Set())

  useEffect(() => {
    window.tamper.loadCheats(exeName).then(setCheats)
    window.tamper.onCheatBroken((cheatId) => {
      setEnabled((prev) => {
        const next = new Set(prev)
        next.delete(cheatId)
        return next
      })
      setBroken((prev) => new Set(prev).add(cheatId))
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

  return (
    <div>
      <h2>{exeName}</h2>
      <button onClick={onOpenScanner}>+ New cheat</button>
      <ul>
        {cheats.map((cheat) => (
          <li key={cheat.id}>
            <span>{cheat.name}</span>
            <AddressChip
              label={
                cheat.targets.length === 1
                  ? cheat.targets[0].baseOffset
                  : `${cheat.targets.length} targets`
              }
              pulsing={enabled.has(cheat.id)}
            />
            {broken.has(cheat.id) && (
              <span style={{ color: 'var(--error)' }}>Broken — offsets no longer resolve</span>
            )}
            {cheat.mode === 'freeze' ? (
              <Toggle enabled={enabled.has(cheat.id)} onChange={() => toggle(cheat)} />
            ) : (
              <button onClick={() => window.tamper.oneShot(cheat)}>Apply</button>
            )}
            <button onClick={() => remove(cheat)}>Delete</button>
          </li>
        ))}
      </ul>
      {cheats.length === 0 && <p>No cheats yet for {exeName}. Scan for one to get started.</p>}
    </div>
  )
}
