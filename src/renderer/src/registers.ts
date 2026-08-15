export interface ThreadInfo {
  tid: number
}

// Which thread the Registers panel's dropdown should have selected, given
// a freshly refreshed thread list. Keeps the current selection if it's
// still present (a live game's thread list churns constantly — resetting
// the selection on every refresh would make the panel useless to watch);
// otherwise falls back to the first thread in the list, or null if the
// list is empty. Never silently points at a tid that just disappeared —
// that would resolve to "thread exited" on the very next register poll.
export function pickThread(currentTid: number | null, threads: ThreadInfo[]): number | null {
  if (currentTid !== null && threads.some((t) => t.tid === currentTid)) return currentTid
  return threads.length > 0 ? threads[0].tid : null
}
