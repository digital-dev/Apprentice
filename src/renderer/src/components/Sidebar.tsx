import type { Screen } from '../App'

const NAV_ITEMS: { screen: Screen; label: string }[] = [
  { screen: 'picker', label: 'Attach' },
  { screen: 'cheats', label: 'Cheats' },
  { screen: 'scanner', label: 'Scanner' },
  { screen: 'mono', label: 'Mono Explorer' }
]

export default function Sidebar({
  screen,
  exeName,
  onNavigate
}: {
  screen: Screen
  exeName: string | null
  onNavigate: (screen: Screen) => void
}) {
  return (
    <div className="sidebar">
      <h1>APPRENTICE</h1>
      <div className="exe-badge">
        {exeName ? (
          <>
            <span className="pulse-dot" />
            <span>{exeName}</span>
          </>
        ) : (
          <span className="muted">Not attached</span>
        )}
      </div>
      <nav className="nav-list">
        {NAV_ITEMS.map((item) => {
          const disabled = item.screen !== 'picker' && !exeName
          return (
            <button
              key={item.screen}
              className={`nav-item${screen === item.screen ? ' active' : ''}`}
              disabled={disabled}
              onClick={() => onNavigate(item.screen)}
            >
              {item.label}
            </button>
          )
        })}
      </nav>
    </div>
  )
}
