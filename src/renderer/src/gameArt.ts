import { useEffect, useState } from 'react'

export type ArtKind = 'portrait' | 'hero' | 'header' | 'logo'

// Art is asked for per tile, lazily, and never changes while the app runs, so
// each (game, kind) is fetched once and shared: the sidebar thumbnail, the
// library tile and the game page header all reuse one request.
const cache = new Map<string, Promise<string | null>>()

export function loadArt(appId: string, kind: ArtKind): Promise<string | null> {
  const key = `${appId}:${kind}`
  let hit = cache.get(key)
  if (!hit) {
    hit = window.tamper.libraryArt(appId, kind).catch(() => null)
    cache.set(key, hit)
  }
  return hit
}

// Steam may cache art it had not yet when we first asked (a game just opened in
// its library); a manual refresh drops what we remembered.
export function clearArtCache(): void {
  cache.clear()
}

// undefined while loading, null when Steam has none cached, else a data URL.
export function useArt(appId: string | null, kind: ArtKind): string | null | undefined {
  const [art, setArt] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (appId === null) {
      setArt(null)
      return
    }
    let cancelled = false
    setArt(undefined)
    loadArt(appId, kind).then((a) => {
      if (!cancelled) setArt(a)
    })
    return () => {
      cancelled = true
    }
  }, [appId, kind])
  return art
}

// A stand-in for a game with no cached art: a colour taken from the app id, so
// the same game always looks the same, and its initials. Not random, and not a
// network fetch.
export function placeholder(appId: string, name: string): { background: string; initials: string } {
  let hash = 0
  for (let i = 0; i < appId.length; i++) hash = (hash * 31 + appId.charCodeAt(i)) >>> 0
  const hue = hash % 360
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const initials = (words.length === 1 ? words[0].slice(0, 2) : words.slice(0, 2).map((w) => w[0]).join('')).toUpperCase()
  return {
    background: `linear-gradient(160deg, hsl(${hue} 42% 30%), hsl(${(hue + 40) % 360} 48% 13%))`,
    initials: initials || '?'
  }
}
