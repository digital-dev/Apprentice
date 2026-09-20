import { useCallback, useEffect, useState } from 'react'
import './theme.css'
import Sidebar from './components/Sidebar'
import ProcessPicker from './screens/ProcessPicker'
import Library from './screens/Library'
import GamePage from './screens/GamePage'
import { clearArtCache } from './gameArt'
import { gameForExe, type LibraryGame } from './library'
import CheatList from './screens/CheatList'
import Scanner from './screens/Scanner'
import MonoExplorer from './screens/MonoExplorer'
import UEExplorer from './screens/UEExplorer'
import MemoryViewer from './screens/MemoryViewer'
import ErrorBoundary from './components/ErrorBoundary'

export type Screen = 'library' | 'picker' | 'cheats' | 'scanner' | 'mono' | 'ue' | 'memory'

// Screens that work on an attached process; with nothing attached there is
// nothing for them to show.
const NEEDS_ATTACH: readonly Screen[] = ['scanner', 'mono', 'ue', 'memory']

// How often the library re-reads running state, so a game that was just
// launched (or closed) shows up without a manual refresh.
const LIBRARY_POLL_MS = 4000

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

// Same lifted-state hand-off as PendingMonoSelection, for UE Explorer's
// "Use as UE target" button. A separate type (not folded into
// PendingMonoSelection) since a UeTarget additionally needs an existing
// capture-mode patch picked in CheatList (its instanceAnchorPatchId) --
// see docs/superpowers/specs/2026-09-17-ue-target-wiring-design.md for why
// reflection alone can't reach a live instance without one.
export type PendingUeSelection = { className: string; fieldName: string }

export default function App() {
  const [exeName, setExeName] = useState<string | null>(null)
  const [screen, setScreen] = useState<Screen>('library')
  const [games, setGames] = useState<LibraryGame[]>([])
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
  const [pendingMonoSelection, setPendingMonoSelection] = useState<PendingMonoSelection | null>(
    null
  )
  const [pendingUeSelection, setPendingUeSelection] = useState<PendingUeSelection | null>(null)
  const [jumpToAddress, setJumpToAddress] = useState<string | null>(null)

  const refreshLibrary = useCallback(async (force = false) => {
    try {
      if (force) clearArtCache()
      setGames(await window.tamper.listLibrary(force))
    } catch {
      // a failed scan leaves the last list on screen
    } finally {
      setLibraryLoaded(true)
    }
  }, [])

  useEffect(() => {
    refreshLibrary()
    const timer = setInterval(() => refreshLibrary(), LIBRARY_POLL_MS)
    return () => clearInterval(timer)
  }, [refreshLibrary])

  // The main process attaches on its own when a game with cheats starts and
  // detaches when it closes; follow it, and pick up whatever is already attached.
  useEffect(() => {
    window.tamper.currentGame().then((s) => setExeName(s.exe))
    window.tamper.onGameState((s) => setExeName(s.exe))
  }, [])

  // A tool screen with nothing attached has nothing to show: go home.
  useEffect(() => {
    if (!exeName && NEEDS_ATTACH.includes(screen)) setScreen('library')
  }, [exeName, screen])

  const selectedGame =
    games.find((g) => g.appId === selectedAppId) ?? gameForExe(games, exeName)

  function selectGame(game: LibraryGame) {
    setSelectedAppId(game.appId)
    setScreen('cheats')
  }

  function onViewInMemory(address: string) {
    setJumpToAddress(address)
    setScreen('memory')
  }

  return (
    <div className="layout">
      <Sidebar
        screen={screen}
        exeName={exeName}
        games={games}
        selectedAppId={selectedGame?.appId ?? null}
        onNavigate={setScreen}
        onSelectGame={selectGame}
      />
      <div className="main">
        {/* Keyed by screen: this boundary intentionally remounts on every
            navigation, so a crash on one screen auto-recovers the moment the
            user picks a different one from the sidebar, with no extra click
            needed on the fallback's "Try again" button. */}
        <ErrorBoundary key={screen}>
          {screen === 'library' && (
            <Library
              games={games}
              loaded={libraryLoaded}
              onSelectGame={selectGame}
              onRefresh={() => refreshLibrary(true)}
            />
          )}
          {screen === 'picker' && (
            <ProcessPicker
              onAttached={(name) => {
                setExeName(name)
                // Show the game that was attached, not one picked earlier.
                setSelectedAppId(null)
                setScreen('cheats')
              }}
            />
          )}
          {/* The cheat list is mounted per visit on purpose: mounting is what
              reloads the saved cheats and re-checks every patch's status
              against the running game. */}
          {screen === 'cheats' && (selectedGame !== null || exeName) && (
            <GamePage game={selectedGame} exeName={exeName} onAttached={setExeName}>
              {exeName && (
                <CheatList
                  exeName={exeName}
                  pendingMonoSelection={pendingMonoSelection}
                  onConsumePendingMonoSelection={() => setPendingMonoSelection(null)}
                  pendingUeSelection={pendingUeSelection}
                  onConsumePendingUeSelection={() => setPendingUeSelection(null)}
                  onViewInMemory={onViewInMemory}
                />
              )}
            </GamePage>
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
          {screen === 'ue' && exeName && (
            <UEExplorer
              onUseAsUeTarget={(className, fieldName) => {
                setPendingUeSelection({ className, fieldName })
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
