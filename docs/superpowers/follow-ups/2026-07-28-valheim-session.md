# Real-game session against Valheim (2026-07-27/28)

Everything below came out of running #7 against the actual game after the
branch merged. The automated suite passed throughout; none of these were
findable without a real JIT and a real shared codebase.

## Fixed during the session

Each of these was a genuine defect the harness could not expose. All are
committed with tests.

- **The injected effect ran last**, after the displaced instructions, so it
  depended on the base register surviving code it has no control over. It
  frequently doesn't: a 4-byte `movss [rax], xmm5` drags in the following
  `mov eax, 1` to reach the 5 bytes a jump needs, and writing `eax`
  zero-extends across `rax`. The injected store then faulted on address
  `0x1`. The effect now runs first; force mode also stops replaying the
  captured store, since that store is the write it replaces.
- **`decodeRun` accepted a displaced run containing `ret`** — neither
  RIP-relative nor a relative branch, so the position-dependence check
  missed it. A cave replaying a `ret` returns before the effect runs: a
  cheat that installs successfully and silently does nothing.
- **`platform::SuspendAll` failed whenever a thread vanished** between the
  snapshot and `OpenThread`. Games churn threads constantly, and install
  refuses on failed suspension, so this surfaced as cheats intermittently
  refusing to apply.
- **`FindWriteInstruction` preferred a coincidental shorter decode** whose
  bytes are the real store's tail. Shipped in #6.
- **Signatures baked in absolute addresses.** A 64-bit immediate is how
  x86-64 embeds one, and JIT allocations move every launch — the same
  instruction captured twice gave signatures identical but for a
  `movabs r11, imm64` operand. Now wildcarded.
- **Signatures ran off the end of short methods** into padding, JIT
  metadata and a neighbouring method's prologue — none of it stable. They
  now cover the enclosing method, extending *backward* with
  decode-alignment validation, clamped at the memory region and at padding
  runs, rejecting chains that decode opcode `0x00`.
- **`locate()` re-scanned for patches it had installed.** An injection
  replaces the instruction with a jump, so the original signature matches
  nothing — reported as "no signature match" the instant any cheat was
  enabled. Read as a broken relocation; was the patch working.
- **A damaged `games/*.json` silently disabled saving.** `saveCheat` reads
  before writing, so an empty file made every save throw with no message.
  Cost a session's saved patches.

## What works, proven in-game

Stamina: capture the write, force a constant, survives a Valheim restart.
That is the sub-project's goal and it is met.

**Mono JIT caveat:** a patch cannot relocate until the game has actually
executed the method — Mono compiles on first call, so a scan immediately
after a restart correctly finds nothing. The message ("may have been
re-compiled — re-capture it") is actively misleading here. A background
retry on a failed locate would remove the ordering requirement entirely and
is the single highest-value follow-up.

## Valheim health: unsolved, and why

Not a missing feature — we never found the right instruction.

- Health has **at least three mirrored copies** that track identically.
- The write that actually moves health is `movss [rax], xmm5`, where `rax`
  comes from `lea rax,[rax+rcx*4+0x20]` — a **bounds-checked array element**,
  not a field. It is shared: forcing it gave enemies and destructibles the
  player's value; NOPing it stopped damage for every entity.
- **NOPing it corrupts game state.** Enemies began dealing ~8.1e9 damage,
  which means the instruction feeds a calculation others read back, not a
  simple health store. Guarding it would corrupt the protected entity the
  same way.
- A second writer, `movss [rsi+0x3c]` (a real per-object field on a tiny
  setter method), has no visible effect when forced — it writes a copy.
- `valheimV3.CT` has no health cheat either: stamina, carry weight,
  durability, coins, looting, hammer, food timer, cooldowns. Its stamina
  script uses the same instruction we found and the same trampoline idea,
  replaying-then-forcing (which is what our effect-first ordering fixes).

**Where to resume:** upward from the array write — what calls it, and where
the value it reads is updated. That is Valheim reverse-engineering rather
than trainer work, and probably wants the pointer scanner rather than
write-watch.

## Guard mode: built, unproven

"Stop this value from changing — for this object only" injects a compare
against a remembered pointer and skips the write for that object alone,
replaying it for everyone else. Self-arming took whichever entity the game
touched first (never the player at a site that runs for every creature), so
it is now seeded at install with the register value the capture recorded
while writing the watched address.

Deterministic within a session; **the seed is a runtime address, so it does
not survive a restart.** Persistence needs the slot filled from a capture on
a player-specific site — the stamina write is one, and that path already
works.

It has never been confirmed working in-game: every observation so far was a
NOP patch (the mode selector defaults to NOP and the row read `code patch`).
Verify the row says `guard` before drawing conclusions from it.

## Smaller things left open

- `decodeRun` still reports `clobbers`, unused since the effect-first change
  made the hazard structurally impossible. Dead API surface; delete it.
- The write-watch emits **duplicate rows** for one instruction — two
  byte-identical candidates appeared for the same site.
- `kMinSigBytes = 48`, `kLookBack = 64`, `kPadRun = 4` are tuned from one
  game's evidence. The CT table's 11-byte AOB suggests 48 is conservative.
- Backward extension has needed three heuristic fixes (region clamp,
  padding runs, opcode `0x00`). If a fourth is needed, replace the approach:
  decode forward once from the padding boundary and accept whatever
  alignment that yields.
