import type { CheatDefinition } from './store'

// What turning a freeze cheat off does to the game's value.
//   'capture': write back what each target read the moment the cheat was enabled (captureStore.ts)
//   'value':   write the cheat's fixed offValue
//   'none':    stop writing and leave whatever is there
//
// Restoring is the default. A freeze that only stops re-asserting its value used to be the rule, which left a frozen godmode flag, carry
// weight or stamina in place after the cheat showed as off, for any field the game does not rewrite on its own.
// `keepOnDisable` is the explicit opt-out for the rare cheat where leaving the value is the point.
export type RestoreKind = 'capture' | 'value' | 'none'

export function restoreKind(cheat: CheatDefinition): RestoreKind {
  if (cheat.mode !== 'freeze') return 'none'
  if (cheat.keepOnDisable === true) return 'none'
  if (cheat.captureOriginal) return 'capture'
  if (cheat.offValue !== undefined) return 'value'
  return 'capture'
}
