// Types and small pure rules for the game library screens.

export type LibraryGame = Awaited<ReturnType<typeof window.tamper.listLibrary>>[number]

export const exeStem = (name: string): string => name.replace(/\.exe$/i, '').toLowerCase()

// The library game a process name belongs to, if any: the one whose cheat
// profile is named for that exe.
export function gameForExe(games: readonly LibraryGame[], exeName: string | null): LibraryGame | null {
  if (exeName === null) return null
  const stem = exeStem(exeName)
  return games.find((g) => g.exe !== null && exeStem(g.exe) === stem) ?? null
}

export type GamePageState =
  // Attached to this game: show its cheats.
  | 'attached'
  // Running with cheats, but not attached yet: attach now.
  | 'attach'
  // Has cheats, not running: offer Play and wait for it to start.
  | 'waiting'
  // No cheats for this game.
  | 'unsupported'

export function gamePageState(game: LibraryGame, attachedExe: string | null): GamePageState {
  if (game.exe === null) return 'unsupported'
  if (attachedExe !== null && exeStem(attachedExe) === exeStem(game.exe)) return 'attached'
  return game.running ? 'attach' : 'waiting'
}
