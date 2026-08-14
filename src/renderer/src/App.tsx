import { useState } from 'react'
import './theme.css'
import Sidebar from './components/Sidebar'
import ProcessPicker from './screens/ProcessPicker'
import CheatList from './screens/CheatList'
import Scanner from './screens/Scanner'
import MonoExplorer from './screens/MonoExplorer'
import MemoryViewer from './screens/MemoryViewer'
import ErrorBoundary from './components/ErrorBoundary'

export type Screen = 'picker' | 'cheats' | 'scanner' | 'mono' | 'memory'

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
  const [jumpToAddress, setJumpToAddress] = useState<string | null>(null)

  function onViewInMemory(address: string) {
    setJumpToAddress(address)
    setScreen('memory')
  }

  return (
    <div className="layout">
      <Sidebar screen={screen} exeName={exeName} onNavigate={setScreen} />
      <div className="main">
        {/* Keyed by screen: this boundary intentionally remounts on every
            navigation, so a crash on one screen auto-recovers the moment the
            user picks a different one from the sidebar, with no extra click
            needed on the fallback's "Try again" button. */}
        <ErrorBoundary key={screen}>
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
              onViewInMemory={onViewInMemory}
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
          {screen === 'memory' && exeName && (
            <MemoryViewer
              initialAddress={jumpToAddress ?? undefined}
              onDone={() => setScreen('cheats')}
              onConsumeJumpToAddress={() => setJumpToAddress(null)}
            />
          )}
        </ErrorBoundary>
        {/* The scanner is the opposite: it stays mounted and is merely
            hidden, because its state is expensive to rebuild. A scan plus a
            find-what-writes capture can take minutes of triggering the value
            in-game, and trying several caught writers in turn means leaving
            for the cheat list and coming back between attempts. Unmounting
            here sent every one of those round trips back to a blank screen.
            "Clear scan" is how you throw it away deliberately. It gets its
            own, unkeyed error boundary rather than sharing the one above:
            keying by `screen` would remount (and drop) this persisted state
            every time the user merely navigated away and back. */}
        {exeName && (
          <div style={{ display: screen === 'scanner' ? 'block' : 'none' }}>
            <ErrorBoundary>
              <Scanner
                key={exeName}
                exeName={exeName}
                onDone={() => setScreen('cheats')}
                onViewInMemory={onViewInMemory}
              />
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  )
}
