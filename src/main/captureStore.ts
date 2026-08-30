// Runtime record of "what was this cheat's target actually reading right
// before we started freezing it" — the captureOriginal counterpart to
// CheatDefinition.offValue (see its doc in store.ts). ipc.ts populates an
// entry the instant a captureOriginal cheat is enabled (before the freeze
// loop starts overwriting the field) and consumes it the instant that same
// cheat is disabled, on every disable path: a manual toggle off, a delete,
// or the quit/process-switch restore sweep. One entry per cheat id, values
// parallel to that cheat's targets array at capture time — a target that
// was unreadable at capture (game mid-transition) captures `null` there
// rather than dropping the whole entry, so the other targets still restore.
export class CaptureStore {
  private captures = new Map<string, (number | null)[]>()

  capture(cheatId: string, values: (number | null)[]): void {
    this.captures.set(cheatId, values)
  }

  // Removes the entry as it returns it — a cheat's capture is single-use:
  // the next enable captures a fresh one, and leaving a stale entry behind
  // would let a later disable (of a cheat id reused after delete, or a
  // re-enable/disable cycle) restore values from a completely different
  // moment.
  take(cheatId: string): (number | null)[] | undefined {
    const values = this.captures.get(cheatId)
    this.captures.delete(cheatId)
    return values
  }

  // Drops a pending capture without restoring it — for a delete where the
  // caller has already decided (or attempted) the restore through some
  // other path, and just needs the id to stop existing here so a later
  // reused id doesn't inherit it.
  clear(cheatId: string): void {
    this.captures.delete(cheatId)
  }
}
