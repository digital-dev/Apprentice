import './theme.css'
import Sidebar from './components/Sidebar'

export default function App() {
  return (
    <div className="layout">
      <Sidebar />
      <div className="main">
        <h2>Select a process to begin</h2>
      </div>
    </div>
  )
}
