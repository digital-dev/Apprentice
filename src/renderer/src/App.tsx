import { useState } from 'react'
import './theme.css'
import Sidebar from './components/Sidebar'
import ProcessPicker from './screens/ProcessPicker'
import CheatList from './screens/CheatList'
import Scanner from './screens/Scanner'

type Screen = 'picker' | 'cheats' | 'scanner'

export default function App() {
  const [exeName, setExeName] = useState<string | null>(null)
  const [screen, setScreen] = useState<Screen>('picker')

  return (
    <div className="layout">
      <Sidebar />
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
          <CheatList exeName={exeName} onOpenScanner={() => setScreen('scanner')} />
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
            <Scanner exeName={exeName} onDone={() => setScreen('cheats')} />
          </div>
        )}
      </div>
    </div>
  )
}
