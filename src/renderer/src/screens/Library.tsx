import { useState } from 'react'
import GameCover from '../components/GameCover'
import type { LibraryGame } from '../library'

// The home screen: every installed Steam game as a cover tile. Games Apprentice
// has cheats for come first; the rest are dimmed but still open, so it is clear
// what is and is not supported rather than hiding half the library.
export default function Library({
  games,
  loaded,
  onSelectGame,
  onRefresh
}: {
  games: LibraryGame[]
  loaded: boolean
  onSelectGame: (game: LibraryGame) => void
  onRefresh: () => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = games.filter((g) => g.name.toLowerCase().includes(q))
  const supported = shown.filter((g) => g.exe !== null)
  const others = shown.filter((g) => g.exe === null)

  const tile = (game: LibraryGame) => (
    <button key={game.appId} className={`tile${game.exe === null ? ' unsupported' : ''}`} onClick={() => onSelectGame(game)}>
      <div className="tile-art">
        <GameCover appId={game.appId} name={game.name} className="cover-tile" />
        {game.running && <span className="tile-badge tile-running">RUNNING</span>}
        {game.exe !== null && <span className="tile-badge tile-cheats">{game.cheatCount} cheats</span>}
      </div>
      <span className="tile-name">{game.name}</span>
    </button>
  )

  return (
    <div className="screen library">
      <div className="library-head">
        <h2>
          My Games <span className="side-count">{games.length}</span>
        </h2>
        <div className="library-tools">
          <input placeholder="Search games" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn-quiet" onClick={onRefresh} title="Rescan Steam libraries">
            Refresh
          </button>
        </div>
      </div>

      {loaded && games.length === 0 && (
        <div className="empty-state">
          <h3>No Steam games found</h3>
          <p>
            Apprentice looks for Steam in the registry and the usual install folders, then reads every library folder
            Steam lists. If your games are elsewhere, or you play from another launcher, you can still attach to any
            running game from <strong>Tools → Attach to process</strong>.
          </p>
        </div>
      )}

      {supported.length > 0 && (
        <>
          <h3 className="section-title">With cheats</h3>
          <div className="tile-grid">{supported.map(tile)}</div>
        </>
      )}
      {others.length > 0 && (
        <>
          <h3 className="section-title">Other installed games</h3>
          <div className="tile-grid">{others.map(tile)}</div>
        </>
      )}
      {loaded && games.length > 0 && shown.length === 0 && <p className="muted">No game matches “{query}”.</p>}
    </div>
  )
}
