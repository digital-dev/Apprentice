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
        {screen === 'cheats' && exeName && (
          <CheatList exeName={exeName} onOpenScanner={() => setScreen('scanner')} />
        )}
        {screen === 'scanner' && exeName && (
          <Scanner exeName={exeName} onSaved={() => setScreen('cheats')} />
        )}
      </div>
    </div>
  )
}
