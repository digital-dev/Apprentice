# Far Cry 5 (FarCry5.exe)

Dunia engine, native, no reflection. `fingerprint_process` says `native-unknown`. The game code lives in the
`FC_m64` module (`FarCry5.exe` is a small stub), and its sections have obfuscated names, so anything that compares or
scans code should select sections by their executable flag, not by name.

**Status: nothing here has been run in-game through Tamper.** Every patch was built against the clean on-disk bytes
of the game module and its signature confirmed to match exactly once there. Test each cheat on a freshly started
game.

## Findings that were not obvious

- A write watch on a health float caught one write and then the game died on detach (same family as Palworld). Use
  read-only sampling and offline disassembly on this game.
- Signatures must come from the clean bytes of the module on disk, never from live memory: anything that patches the
  running game leaves jumps at the sites, and those bytes will not match a clean install.

## Stat objects

A generic stat class (vtable at module offset `+0x1ede9c8`): `+0x18` current, `+0x1c` max, `+0x20` 100. Hung off the
player entity at fixed slots, verified live (all 100/100):

| Entity slot | Stat |
|---|---|
| `+0x48` | health |
| `+0x428` | stamina |
| `+0x468` | oxygen |
| `+0x50` | unknown, reads 50/50 (not shipped) |

Module offset `+0x9bea61d` is a player-only function (`rcx` = entity, reads `[rcx+0x48]` and `[rcx+0x50]`); the captured
pointer stayed fixed across a play session. Tamper's capture there feeds the three freeze cheats.

Health setter: `+0x108e340`, `[rcx+0x18] = min([rcx+0x1c], xmm1)`, store at `+0x108e365`. Blocking a decrease there
when `rcx` is the player's health object would be stronger than a 100 ms freeze, but needs the player pointer at
install time, which Tamper cannot take from a capture patch.

## Cheats in FarCry5.json

| Cheat | Mechanism (module offsets) | Mode |
|---|---|---|
| Unlimited Health / Stamina / Oxygen | freeze `[stat+0x18]` at 100 via the player capture | freeze |
| Ghost Mode | `+0x2c6428f` `jz` -> `jmp` (same target) | replace |
| Unlimited Buff Duration | `+0x239f67a`, `+0xe2411fd` skip the `subss` timer countdown | nop x2 |
| Freeze Timer | `+0x6071440` `subss xmm0,[rcx]; ret` returns 0 | replace |
| No Weapon Overheat | `+0x1db4de6` `addss` -> `xorps`; `+0xdcd1660` writes 0 to `[rcx+0x1f0]` | replace + strip |
| Super Accuracy | `+0x1e277d0` stores 0 to `[rax+0x408]` | force |
| No Recoil | six stores into `[rbx+0x118..0x130]` at `+0xdcb2a68`..`+0xdcb2a93` replaced by zero stores | force x6 |
| No Reload / Unlimited Magazine | `+0xdc2ea35` writes 99 to `[rcx+0x188]` before `cmp [rcx+0x188],0` | strip |
| Unlimited Fishing Line | `+0x2125512` writes 1.0 to `[rsi+0x27c]` | strip |
| Easy Craft | `+0x24ee9c0` writes 0 to `[rdi+0x10]` | strip |
| Unlimited Perk Points | `+0xc0e7dad` affordability check: writes 999 to `[rdi+0xe8]` before `cmp [rdi+0xe8],ecx` | strip |
| Unlimited Missiles / Bombs | `+0x1d2d0d9`, `+0xcbaf0ba`: count read as 9 (`push 9; pop r8`) | replace |

## Not built, and why

- **Stack counts for ammo reserve, grenades, throwables, general items and money.** One game function
  (`+0xe1c8d97`, `mov eax,[rbx+0xc]`) reads every item stack count, with the item hash in `esi` / `[rsp+0x60]`.
  Overwriting the count there works, but needs a per-hash choice of value (99 for ammo, 9 for grenades and throwables,
  9,999,999 for the currency hashes `0x239E3150` / `0x1825D994`). Tamper has no hash compare, and an ungated strip would
  overwrite the stored currency with 99. Ammo while firing is covered by No Reload.
- **Making enemies unable to fire.** Zeroing `[rbx+0x188]` at `+0xdb6734a` for every weapon except the player's needs the
  player's weapon pointer from another patch's capture. Tamper's guard/immune accept only `armValue` or a static chain.
- **Gated god mode** has the same limit. There is no static chain to the player either: every holder of the entity
  pointer is a heap object.
- **Speed multiplier.** A game-heap float (laid out `[1.0f][value]` just before a vtable-area pointer) tracked a
  speed multiplier when it was changed, but nothing in the game's code reads it in a way I traced, there is no
  static chain, and I never confirmed it changes movement.
- **Armor and Game Speed:** nothing found. Far Cry 5 has no armor stat; entity slot `+0x50` (50/50) is a candidate for
  something else.
- **The second perk-point check at `+0x245c419`** (`mov ebx,[rax]` on a value returned by a global lookup, then
  `cmp ebx,[rbp-0x0D]`). Overwriting `[rax]` there affects whatever any caller looks up, and I could not tell how far
  that reaches, so only the first check (`+0xc0e7dad`) is patched. If a perk purchase still fails, look here.

## Sharp edges

- Freeze Timer, Buff Duration and No Weapon Overheat patch shared helpers (a timer-array loop, an elapsed-time
  function, an accumulate-and-compare). Each can stop more than its name says.
- Easy Craft zeroes a requirement field that is probably a shared data row; it persists after switching off until the
  game reloads the row. Test it against more than one recipe.
- Unlimited Missiles/Bombs change what is read, not the stored count, so on-screen numbers may differ.
- Unlimited Health is a 100 ms freeze: burst damage can still kill between ticks.
