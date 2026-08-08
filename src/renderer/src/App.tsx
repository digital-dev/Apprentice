import { useState } from 'react'
import './theme.css'
import Sidebar from './components/Sidebar'
import ProcessPicker from './screens/ProcessPicker'
import CheatList from './screens/CheatList'
import Scanner from './screens/Scanner'
import MonoExplorer from './screens/MonoExplorer'

export type Screen = 'picker' | 'cheats' | 'scanner' | 'mono'

// A resolved Mono Explorer selection, handed from that screen to the cheat
// list's creation forms. There is no routing/context layer in this
// renderer — this is the same lifted-useState-plus-prop pattern App.tsx
// already uses for exeName/screen, just for a second, smaller piece of
// cross-screen data. Cleared by CheatList once it's been consumed (saved or
// dismissed) so it doesn't linger into a later, unrelated visit to the
// cheat list.
export type PendingMonoSelection =
  | { kind: 'value'; className: string; fieldName: string }
  | { kind: 'anchor'; className: string; methodName: string }

export default function App() {
  const [exeName, setExeName] = useState<string | null>(null)
  const [screen, setScreen] = useState<Screen>('picker')
  const [pendingMonoSelection, setPendingMonoSelection] = useState<PendingMonoSelection | null>(
    null
  )

  return (
    <div className="layout">
      <Sidebar screen={screen} exeName={exeName} onNavigate={setScreen} />
      <div className="main">
        {screen === 'picker' && (
          <ProcessPicker
            onAttached={(name) => {
              setExeName(name)
              setScreen('cheats')
            }}
          />
        )}
        {/* The cheat list is mounted per visit on purpose: mounting is what
            reloads the saved cheats and re-checks every patch's status
            against the running game. */}
        {screen === 'cheats' && exeName && (
          <CheatList
            exeName={exeName}
            pendingMonoSelection={pendingMonoSelection}
            onConsumePendingMonoSelection={() => setPendingMonoSelection(null)}
          />
        )}
        {screen === 'mono' && exeName && (
          <MonoExplorer
            onUseAsValueTarget={(className, fieldName) => {
              setPendingMonoSelection({ kind: 'value', className, fieldName })
              setScreen('cheats')
            }}
            onUseAsPatchAnchor={(className, methodName) => {
              setPendingMonoSelection({ kind: 'anchor', className, methodName })
              setScreen('cheats')
            }}
            onDone={() => setScreen('cheats')}
          />
        )}
        {/* The scanner is the opposite: it stays mounted and is merely
            hidden, because its state is expensive to rebuild. A scan plus a
            find-what-writes capture can take minutes of triggering the value
            in-game, and trying several caught writers in turn means leaving
            for the cheat list and coming back between attempts. Unmounting
            here sent every one of those round trips back to a blank screen.
            "Clear scan" is how you throw it away deliberately. */}
        {exeName && (
          <div style={{ display: screen === 'scanner' ? 'block' : 'none' }}>
            <Scanner key={exeName} exeName={exeName} onDone={() => setScreen('cheats')} />
          </div>
        )}
      </div>
    </div>
  )
}
