import { useEffect, useRef, useState, type ReactNode } from 'react'
import GameCover from '../components/GameCover'
import { useArt } from '../gameArt'
import { gamePageState, type LibraryGame } from '../library'

// One game: a header (cover, name, state, Play) above whatever the state calls
// for. The cheat list itself is passed in as `children` and is only shown once
// Apprentice is attached to this game, since it needs a live process.
export default function GamePage({
  game,
  exeName,
  onAttached,
  children
}: {
  game: LibraryGame | null
  exeName: string | null
  onAttached: (exeName: string) => void
  children: ReactNode
}) {
  // A process attached by hand that belongs to no library game (a non-Steam
  // game, say): keep the plain cheat list, with a minimal header.
  if (game === null) {
    return (
      <div className="game-page">
        <div className="game-head game-head-plain">
          <div className="game-head-main">
            <h2>{exeName ?? 'Game'}</h2>
            <span className="game-head-sub">Attached process</span>
          </div>
        </div>
        {children}
      </div>
    )
  }
  return (
    <ConnectedGamePage game={game} exeName={exeName} onAttached={onAttached}>
      {children}
    </ConnectedGamePage>
  )
}

function ConnectedGamePage({
  game,
  exeName,
  onAttached,
  children
}: {
  game: LibraryGame
  exeName: string | null
  onAttached: (exeName: string) => void
  children: ReactNode
}) {
  const state = gamePageState(game, exeName)
  const hero = useArt(game.appId, 'hero')
  const [error, setError] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  // Bumped by "Try again" so the attach effect runs again.
  const [attachTry, setAttachTry] = useState(0)
  // Attach once per "started running": without this a failed attach would retry
  // on every library poll.
  const attempted = useRef<string | null>(null)

  useEffect(() => {
    if (state !== 'attach') {
      if (state === 'waiting') attempted.current = null
      return
    }
    if (attempted.current === game.appId || game.exe === null) return
    attempted.current = game.appId
    setError(null)
    window.tamper
      .attachToGame(game.exe)
      .then((name) => {
        if (name === null) setError(`${game.name} is running, but Apprentice could not attach to it.`)
        else onAttached(name)
      })
      .catch(() => setError(`Could not attach to ${game.name}. Access may have been denied.`))
  }, [state, game.appId, game.exe, game.name, onAttached, attachTry])

  useEffect(() => {
    if (game.running) setLaunching(false)
  }, [game.running])

  async function play() {
    setLaunching(true)
    const ok = await window.tamper.launchGame(game.appId)
    if (!ok) setLaunching(false)
    // Steam takes a while to start a game; stop showing "Launching" if it never does.
    window.setTimeout(() => setLaunching(false), 30000)
  }

  function retry() {
    attempted.current = null
    setError(null)
    setAttachTry((n) => n + 1)
  }

  const running = game.running
  return (
    <div className="game-page">
      <div className="game-head" style={hero ? { backgroundImage: `url(${hero})` } : undefined}>
        <div className="game-head-shade" />
        <GameCover appId={game.appId} name={game.name} className="cover-head" />
        <div className="game-head-main">
          <h2>{game.name}</h2>
          <div className="game-head-meta">
            <span className="chip">Installed on Steam</span>
            {game.exe !== null && <span className="chip chip-accent">{game.cheatCount} cheats</span>}
            {running && (
              <span className="chip chip-live">
                <span className="run-dot" /> Running
              </span>
            )}
          </div>
        </div>
        <div className="game-head-actions">
          <button className="btn-primary btn-play" disabled={running || launching} onClick={play}>
            {running ? 'Running' : launching ? 'Launching…' : '▶ Play'}
          </button>
        </div>
      </div>

      {state === 'attached' && children}

      {state === 'attach' && (
        <div className="state-panel">
          {error ? (
            <>
              <h3>Couldn’t attach</h3>
              <p>{error}</p>
              <button onClick={retry}>Try again</button>
            </>
          ) : (
            <>
              <h3>Attaching to {game.name}…</h3>
              <p>The cheat list appears as soon as Apprentice is connected.</p>
            </>
          )}
        </div>
      )}

      {state === 'waiting' && (
        <div className="state-panel">
          <h3>{game.name} isn’t running</h3>
          <p>
            Start it with Play (or from Steam). Apprentice connects automatically when the game opens, and its{' '}
            {game.cheatCount} cheats appear here. Nothing is changed in the game until you switch a cheat on.
          </p>
        </div>
      )}

      {state === 'unsupported' && (
        <div className="state-panel">
          <h3>No cheats for {game.name} yet</h3>
          <p>
            Apprentice does not have a cheat set for this game. You can still attach to it while it runs from{' '}
            <strong>Tools → Attach to process</strong> and use the scanner to find values yourself.
          </p>
        </div>
      )}
    </div>
  )
}
