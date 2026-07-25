import type { CheatDefinition } from './store'

export type WriteFn = (cheat: CheatDefinition) => boolean

export class FreezeLoop {
  private writeFn: WriteFn
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private active = new Map<string, CheatDefinition>()
  private brokenCb: ((cheatId: string) => void) | null = null

  constructor(writeFn: WriteFn, intervalMs = 100) {
    this.writeFn = writeFn
    this.intervalMs = intervalMs
  }

  enable(cheat: CheatDefinition): void {
    this.active.set(cheat.id, cheat)
  }

  disable(cheatId: string): void {
    this.active.delete(cheatId)
  }

  onBroken(cb: (cheatId: string) => void): void {
    this.brokenCb = cb
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    for (const cheat of Array.from(this.active.values())) {
      const ok = this.writeFn(cheat)
      if (!ok) {
        this.active.delete(cheat.id)
        this.brokenCb?.(cheat.id)
      }
    }
  }
}
