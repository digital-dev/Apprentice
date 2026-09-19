import fs from 'node:fs'
import path from 'node:path'

// Drafts never overwrite the live profile: they go beside it as
// <profile>.draft.json for a human to promote after the in-game pass.

export function draftPathFor(profilePath: string): string {
  return profilePath.replace(/\.json$/i, '') + '.draft.json'
}

export function exeFor(profilePath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as { exe?: string }
    if (typeof parsed.exe === 'string') return parsed.exe
  } catch {
    // no readable profile yet -- fall through to the filename
  }
  return path.basename(profilePath).replace(/\.json$/i, '')
}

export type ProfileModules = Record<string, { size: number; timestamp: number; version: string | null }>

export function writeDraft(profilePath: string, cheats: unknown[], modules: ProfileModules = {}): string {
  const draftPath = draftPathFor(profilePath)
  fs.writeFileSync(draftPath, JSON.stringify({ schema: 2, exe: exeFor(profilePath), modules, cheats }, null, 2))
  return draftPath
}
