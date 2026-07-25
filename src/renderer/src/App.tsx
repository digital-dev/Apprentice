import { useState } from 'react'
import './theme.css'
import Sidebar from './components/Sidebar'
import ProcessPicker from './screens/ProcessPicker'

export default function App() {
  const [exeName, setExeName] = useState<string | null>(null)

  return (
    <div className="layout">
      <Sidebar />
      <div className="main">
        {!exeName ? (
          <ProcessPicker onAttached={setExeName} />
        ) : (
          <h2>Attached to {exeName}</h2>
        )}
      </div>
    </div>
  )
}
