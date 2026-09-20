import type { Screen } from '../App'
import type { LibraryGame } from '../library'
import GameCover from './GameCover'

const TOOLS: { screen: Screen; label: string }[] = [
  { screen: 'scanner', label: 'Scanner' },
  { screen: 'mono', label: 'Mono Explorer' },
  { screen: 'ue', label: 'UE Explorer' },
  { screen: 'memory', label: 'Memory Viewer' },
  { screen: 'picker', label: 'Attach to process' }
]

export default function Sidebar({
  screen,
  exeName,
  games,
  selectedAppId,
  onNavigate,
  onSelectGame
}: {
  screen: Screen
  exeName: string | null
  games: LibraryGame[]
  selectedAppId: string | null
  onNavigate: (screen: Screen) => void
  onSelectGame: (game: LibraryGame) => void
}) {
  return (
    <div className="sidebar">
      <h1>APPRENTICE</h1>

      <nav className="nav-list">
        <button
          className={`nav-item${screen === 'library' ? ' active' : ''}`}
          onClick={() => onNavigate('library')}
        >
          Library
        </button>
      </nav>

      <div className="side-heading">
        <span>MY GAMES</span>
        <span className="side-count">{games.length}</span>
      </div>
      <div className="game-list">
        {games.map((game) => (
          <button
            key={game.appId}
            className={`game-item${screen === 'cheats' && selectedAppId === game.appId ? ' active' : ''}${
              game.exe === null ? ' unsupported' : ''
            }`}
            onClick={() => onSelectGame(game)}
            title={game.exe === null ? `${game.name}: no cheats yet` : `${game.name}: ${game.cheatCount} cheats`}
          >
            <GameCover appId={game.appId} name={game.name} className="cover-xs" />
            <span className="game-item-name">{game.name}</span>
            {game.running && <span className="run-dot" aria-label="running" />}
          </button>
        ))}
        {games.length === 0 && <p className="muted side-empty">No games found yet.</p>}
      </div>

      <div className="side-heading">
        <span>TOOLS</span>
        <span className="exe-badge">
          {exeName ? (
            <>
              <span className="pulse-dot" />
              <span>{exeName}</span>
            </>
          ) : (
            <span className="muted">Not attached</span>
          )}
        </span>
      </div>
      <nav className="nav-list tools">
        {TOOLS.map((item) => {
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
