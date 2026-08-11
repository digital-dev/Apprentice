// Fire-time feedback for a global hotkey: the game (not Apprentice) has
// focus when a hotkey fires, so a sound cue is the only way to know it
// worked without alt-tabbing back. Generated tones via the Web Audio API
// rather than bundled audio files — no assets, no licensing, and it's a
// handful of lines either way.
//
// One shared AudioContext, created lazily on first use: constructing one
// eagerly at module load can warn/fail in Chromium before any user
// gesture has occurred on the page, and every renderer screen in this app
// is reached through at least one prior click (attaching to a process),
// so by the time a hotkey can plausibly fire, a gesture has already
// happened.
let ctx: AudioContext | null = null

function getContext(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

// Plays `frequencies` as a short sequence of pure tones, each `stepMs`
// long, back to back.
function playTones(frequencies: number[], stepMs: number): void {
  const audioCtx = getContext()
  const stepSec = stepMs / 1000
  frequencies.forEach((freq, i) => {
    const start = audioCtx.currentTime + i * stepSec
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, start)
    // A short linear fade-out avoids an audible click at each tone's end.
    gain.gain.setValueAtTime(0.2, start)
    gain.gain.linearRampToValueAtTime(0, start + stepSec)
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start(start)
    osc.stop(start + stepSec)
  })
}

// Rising two-note chime — a cheat turned on, or a one-shot applied.
export function playOn(): void {
  playTones([660, 990], 80)
}

// Falling two-note chime — deliberately a different shape from playOn's
// reverse (990→660 would sound too similar at a glance-free listen), not
// just its mirror, so the two are easy to tell apart by ear.
export function playOff(): void {
  playTones([523, 392], 90)
}

// Low double-beep — a hotkey action failed (e.g. a dead pointer chain, a
// patch that couldn't apply).
export function playError(): void {
  playTones([220, 220], 100)
}
