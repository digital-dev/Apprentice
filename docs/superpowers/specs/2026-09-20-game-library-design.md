# Game library — design

A Wand-style home for Apprentice: your installed games detected and listed with
their cover art, a game page with the cheats, and a sidebar of "My Games".
Layout ideas only; no branding or assets are copied.

## Goals

- Detect the user's Steam games automatically, wherever Steam and its library
  folders live (the user's are on `C:` and `D:\SteamLibrary`, and the location
  is not fixed).
- Show each game with its real cover art.
- Make the game the unit of navigation: pick a game, see its cheats, launch it.

## Non-goals

- Non-Steam launchers (Epic, GOG, Xbox). The scanner is written so a second
  source can be added, but none is built.
- Any network access. The README promises the app does not phone home, so cover
  art comes only from Steam's own on-disk cache; there is no CDN fallback.
  A game with no cached art gets a generated placeholder.

## Detection (main process, `steamLibrary.ts`)

Facts verified on the target machine, not assumed:

1. **Steam root**: registry `HKCU\Software\Valve\Steam\SteamPath` (also
   `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath`), then the default
   `Program Files (x86)\Steam`. Each candidate must exist on disk.
2. **Libraries**: `<root>\steamapps\libraryfolders.vdf` lists every library
   path (Valve KeyValues text); the root is always one of them.
3. **Installed games**: each library's `steamapps\appmanifest_<appid>.acf`
   gives `appid`, `name`, `installdir`. A game counts only if
   `steamapps\common\<installdir>` exists (manifests linger after uninstall).
4. **Executables**: `.exe` files up to two levels under the install dir,
   minus known non-game helpers (crash handlers, uninstallers, redistributables).
5. **Cover art**: `<root>\appcache\librarycache\<appid>\<hash>\` holds
   `library_600x900.jpg` (portrait), `library_hero.jpg`, `library_header.jpg`,
   `logo.png`. Found by name, not by hash, since the hash folder varies.

The registry read and the file system are injected, so the scanner is tested
against temp-dir fixtures in the real formats.

## Matching games to cheat profiles

A profile is `games/<exe>.json` with an `exe` field. A game matches a profile
when one of its executables equals that `exe` (case-insensitive, `.exe`
optional). This handles Elden Ring, whose profile is named for its
`start_protected_game.exe`. Running detection is the same match against the
process list, and works for games with no profile too.

## IPC

- `library:list` -> games with `{appId, name, installDir, exe, cheatCount, running}`.
- `library:art(appId, kind)` -> data URL or null. Data URLs, because the
  renderer has no CSP and the art is small; fetched lazily per tile and cached.
- `library:launch(appId)` -> `steam://rungameid/<appid>`; the id is validated
  as digits only before it goes near the shell.
- `game:get` -> the current `{exe, pid}` so a fresh window knows what is attached.

## Renderer

- **Sidebar**: Library, then "My Games" (supported games first, each with a
  small cover, name, and a dot when running), then a Tools group holding the
  existing Scanner, Mono, UE, Memory and Attach screens unchanged.
- **Library home**: a grid of portrait covers; supported games show a cheat
  count, unsupported ones are dimmed.
- **Game page**: header with cover, name, "Installed on Steam", cheat count,
  running state and a Play button, above the existing cheat list. The cheat list
  needs an attached process, so: running and supported -> attach (or reuse the
  auto-attach) and show it; not running -> a clear "launch the game" state that
  switches on its own when auto-attach fires; running but unsupported -> say so.
- The existing screens and the auto-attach watcher are not changed.

## Testing

Unit tests for the VDF parser, root/library/game/exe/art discovery and profile
matching. The renderer is checked by building it and looking at it.
