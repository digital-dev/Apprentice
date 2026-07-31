# Mono Runtime Symbol Resolution (#9) — Design

## Purpose

Give Tamper a way to find a value or a hook point by *name* — `Player.m_godMode`,
`Character.ApplyDamage` — instead of by scanning bytes.

The Valheim health investigation (#8's follow-up session) hit a wall that
byte-level scanning cannot cross: the write that moves displayed health is a
shared, index-addressed array element, and there is no fixed byte pattern
that distinguishes "the player's slot" from any other entity's. A reference
Cheat Engine table for the same game solves this cleanly — not by scanning,
but by asking the game's own Mono runtime, live, "where is the field named
`m_godMode` on the class named `Player`" and "where is the method
`Character.ApplyDamage` compiled." Mono's own metadata already answers both
questions unambiguously; Tamper's scanner and write-watch tools were never
going to.

Two things follow from reading that CT table closely:

- **A field resolved by name reaches value cheats that byte-scanning cannot
  reach at all** — `m_godMode` is a boolean nothing writes to repeatedly, so
  there is no write to watch and no changing value to scan for. Only naming
  it works.
- **A method's entry point is a materially better hook site than a
  downstream shared write.** `Character.ApplyDamage`'s first argument is
  unambiguously "the character taking damage" — a real `this` pointer, not
  an opaque array index. The CT table's damage-immunity cheat is a plain
  `this == LocalPlayer` compare at the method's entry, sidestepping the
  entire shared-array problem the Valheim session got stuck on.

This sub-project gets both onto solid ground in Tamper: resolve a class,
field, or method by name against the target's live Mono runtime, and use
that resolution as a new kind of value-cheat target and a new kind of patch
anchor.

## Scope

**In scope:**

- A native "remote call" primitive: make the target process execute a call
  into one of its own exported functions, on a throwaway thread, and report
  the return value back. Built once, generically — every Mono operation
  below is one instance of this primitive.
- A Mono bridge built from that primitive: attach a new thread to Mono's
  runtime, resolve a class by namespace+name, enumerate a class's fields
  and methods, read a field's offset, and compile a method to get its
  JIT-compiled entry address (`mono_compile_method`).
- `MonoTarget`, a new `CheatTarget` kind: a static field, optionally
  dereferenced through to an instance field — reads/writes through the
  *existing* offset-walking machinery once the base address is resolved.
- A third patch-anchor strategy in `anchor.ts`: resolve by class+method name
  (with an optional parameter-type signature to disambiguate an overload)
  instead of module+RVA or AOB scan.
- A new patch mode, `immune`: hook a method's entry, compare its `this`
  argument against a resolved player pointer, and skip the method body only
  for that match — the ApplyDamage pattern, generalized.
- A renderer "Mono Explorer" screen: search/drill assemblies → classes →
  fields/methods, resolve a selection into a cheat target.
- Lazy, drill-down metadata enumeration (class-name index eager, field/
  method detail on demand, method compilation only on explicit selection).
- A minimal fake-Mono-host test DLL, so the remote-call primitive and
  bridge logic are provable without a real game.

**Out of scope:**

- IL2CPP. A structurally different resolution mechanism (static metadata
  files plus a separate C++ ABI, no live reflection API to call into) —
  planned as a direct follow-on sub-project, not part of this one.
- Calling arbitrary game methods with arbitrary arguments. The remote-call
  primitive is capable of it; every call site this sub-project ships is
  fixed to Mono's own introspection functions, never a game method.
- Eager/full metadata enumeration. Classes and fields are walked on demand,
  not dumped wholesale at attach time.
- Hijacking an existing thread to make the remote call. A throwaway
  `CreateRemoteThread` only.
- Arbitrary calling-convention support (floating point / vector arguments).
  Every Mono function this sub-project calls takes pointer or integer
  arguments; the generic primitive can be widened later if a real need for
  float/double arguments shows up.

## Global constraints

- x86-64, Windows first, Linux-capable by construction: the remote-call
  primitive and the Mono bridge go through `native/src/platform/platform.h`
  the same way #7 and #8's native additions did — a Windows implementation
  now, a Linux stub that refuses cleanly.
- No network calls anywhere in the stack.
- Every existing safety rule stands, extended rather than replaced (see
  Safety, below). Nothing here loosens byte verification, thread
  suspension during a write, or the restore-on-exit guarantees #7 and #8
  built.
- Resolution failures reuse `cheatRuntime.ts`'s existing arming/retry state
  machine — no parallel lifecycle system.

## Architecture

```
renderer: Mono Explorer  ──resolve──▶  ipc.ts
                                          │
                                          ▼
                                  monoResolver.ts (main)
                                          │
                                          ▼
                              native: mono_bridge.cc
                     (attach-to-runtime, class/field/method lookup,
                      compile-method — each built on remote_call.cc)
                                          │
                                          ▼
                              native: remote_call.cc
                (generic: call function X with args, on a throwaway
                 thread inside the target, report the return value)
                                          │
                                          ▼
                                   target process (Mono runtime)
```

Two new integration seams into existing code:

```
MonoTarget (store.ts) ──▶ resolved base address ──▶ existing offset-walk
                                                       (readValue/writeValue)

anchor.ts's resolvePatchAddress ──▶ third path: class+method ──▶
    mono_compile_method ──▶ same byte-verify / cave-inject / restore
    machinery every other patch already uses
```

### The remote-call primitive

Everything Tamper has injected so far redirects the game's *own*
instructions through a trampoline — the game was always going to execute
that code path anyway; the cave just adds to it. This is a different kind
of operation: the game was **not** going to call
`mono_class_from_name("Player", "m_godMode")` on its own. Tamper has to
make it.

The primitive is generic and built once: given a function address inside
the target and up to four pointer/integer arguments, allocate a small cave
holding a stub that loads the arguments into the Windows x64 calling
convention's registers, calls the function, writes the return value to a
scratch slot in the same cave, and returns. `CreateRemoteThread` runs the
stub; Tamper waits for the thread to exit (with a timeout — a hung remote
call must not hang Tamper), reads the scratch slot, and the cave is freed
once the thread has genuinely exited (never while it could still be
running, mirroring the existing never-free-a-live-cave rule).

Every Mono operation below is this primitive called with a different
function pointer and argument set. No second code path is built for any
individual Mono call.

### The Mono bridge

Layered on the primitive:

- **Locate `mono.dll`** in the target's module list — already available
  from #8's `listModules`.
- **Resolve the handful of exports this sub-project needs** by reading
  `mono.dll`'s own PE export directory in the target process (the same PE-
  parsing competence #8's fingerprinting already required, applied to an
  export table instead of headers): `mono_get_root_domain`,
  `mono_thread_attach`, `mono_thread_detach`, `mono_assembly_foreach`,
  `mono_assembly_get_image`, `mono_class_from_name`, `mono_class_get_fields`,
  `mono_field_get_name`, `mono_field_get_offset`, `mono_class_get_methods`,
  `mono_method_get_name`, `mono_method_signature`, `mono_compile_method`.
- **Attach the throwaway thread to Mono's runtime first**, always. Mono
  doesn't know about a thread it didn't create, and most of its API asserts
  on that — every remote call this bridge makes begins with
  `mono_thread_attach(root_domain)` and ends with `mono_thread_detach`,
  owned by the bridge so no individual call site can forget the pairing.
- **Simple lookups** (`mono_class_from_name`, `mono_compile_method`) are one
  remote call: pass the arguments, get one pointer back.
- **Enumeration** (assemblies, a class's fields, a class's methods) is
  harder — Mono's own enumeration APIs work by calling back into
  caller-supplied code per item, not by returning an array. The bridge
  injects a small collector stub alongside the enumeration call: each
  callback invocation appends one entry (a name plus its associated handle)
  into a growable buffer in the cave; once the top-level call returns,
  Tamper reads the whole buffer back out in one pass. (This is very likely
  what the reference CT table's own `LaunchMonoDataCollector` is doing
  internally — the same problem, independently arrived at.)

### `MonoTarget` and value cheats

```ts
export interface MonoTarget {
  kind: 'mono'
  className: string
  staticFieldName: string
  instanceFieldName?: string
}
```

Resolution: find the class, find the static field, read its address (a
static field's storage is part of the class's own static data — the
address itself, not its current value, unless `instanceFieldName` is
absent, in which case the field's *value* is what's read/written directly).
When `instanceFieldName` is present, dereference the static field's value
to get an object pointer, then add the instance field's offset — exactly
`[LocalPlayer]+Player.m_godMode`'s two-step shape. From there, the
*existing* `readValue`/`writeValue` offset-walking machinery does the rest;
nothing about how a resolved base address is used changes.

`CheatTarget` becomes `ChainTarget | AnchorTarget | MonoTarget`.

### The third anchor path, and `immune` mode

`PatchCheat` gains an alternative to `moduleName`/`moduleOffset`:

```ts
monoClass?: string
monoMethod?: string
monoMethodSignature?: string // disambiguates an overload
```

`anchor.ts`'s `resolvePatchAddress` gains a third path: when a patch names
a Mono class+method and no module, resolve via `mono_compile_method`
instead of arithmetic or AOB scan. This is a **deliberate, explicit**
operation — compiling an uncompiled method is a real side effect on the
target — never triggered automatically or speculatively; it happens only
when a patch that names one is actually being located. Once resolved, the
address is byte-read and treated identically to every other resolved
address: nothing downstream of "here is an address" changes.

`immune` is a new patch mode alongside `nop`/`force`/`capture`/`guard`:
hook a method's entry, compare its `this` argument (the first integer
argument per the calling convention Mono JIT code uses — confirmed against
the CT table's own `cmp rax,rcx` pattern) against a resolved player
pointer, and return immediately — skipping the method body entirely — only
for that match. Every other call proceeds untouched. This needs one new
cave-encoder alongside the existing `encodeGuardedSkip`; it goes through
the exact same `decodeRun` safety refusals (no displacing a RIP-relative
instruction, a relative branch, or a flow terminator) as every other
injection, with no special-casing for being at a method's entry rather than
mid-function.

### Lifecycle

Mono resolution failures become new retryable `AnchorReason` values,
handled by `cheatRuntime.ts`'s existing state machine exactly like
`not-yet-compiled` and `module-missing` already are:

- `mono-not-loaded` — `mono.dll` isn't in the target's module list yet.
- `mono-assembly-not-loaded` — the runtime is up but the named class's
  assembly hasn't loaded (a scene not yet entered, a DLC/mod not yet
  active).

Neither is an error; both back off and retry exactly like the JIT-timing
case #8 solved. `mono_compile_method` staying behind an explicit user
action (never automatic, never part of a retry loop) is unrelated to this
retry mechanism and unaffected by it — a patch that names a method retries
resolution generally, but the *compile* call inside that resolution is the
same deliberate operation every time it fires, not a background action
Tamper takes on its own initiative.

### Explorer UI

A new renderer screen: search box over the eager class-name index (built
once per attach, cheap — namespace+class name only); selecting a class
triggers a live field/method enumeration for just that class; selecting a
field or method offers "use as value target" / "use as patch anchor"
respectively, pre-filling the corresponding `MonoTarget` or `PatchCheat`
fields for the existing cheat-creation flow. No new creation flow — this
screen's whole job is producing a resolved name for flows that already
exist, matching the plain-React, no-component-library convention the rest
of the renderer follows.

## Safety

Every existing rule stands. New rules specific to this sub-project:

- **Verify a resolved function address before calling it.** Before the
  remote-call primitive is pointed at any address, confirm it falls inside
  `mono.dll`'s own mapped range (from the same module list used to find
  `mono.dll` in the first place). A lookup that returns garbage must never
  be called — the failure surfaces as a resolution error, never a
  best-effort call with a different argument.
- **`mono_thread_attach` is always paired with `mono_thread_detach`**,
  owned by the bridge layer, not by individual call sites. A leaked
  Mono-internal thread record is the same class of hazard as the leaked
  debug-register state that took Valheim down in the write-watch incident
  #7's history records — the fix here is structural (one place owns the
  pairing) rather than relying on every call site remembering it.
- **A remote call that doesn't return within a timeout is abandoned, not
  waited on indefinitely.** The thread and its cave are not freed while
  the thread could still be running (mirrors the existing never-free-a-
  live-cave rule); Tamper reports the resolution as failed and leaves the
  orphaned thread to Windows' own cleanup on process exit, rather than
  guessing at its state.
- **`immune` mode is subject to the same install refusals as `guard`**:
  never installs on an ambiguous or zero-match resolution, suspends all
  threads while writing the site, restores on disable/detach/exit.
- **No general call-arbitrary-method feature, restated as a hard boundary
  rather than a preference**: every call the bridge makes is to one of the
  fixed Mono introspection functions listed above. The explorer UI cannot
  construct a call to an arbitrary address or an arbitrary game method —
  the only user-supplied input reaching the remote-call primitive is a
  name string, looked up against Mono's own metadata.

## Testing

The existing harness (a static MSVC binary) cannot host a real Mono
runtime, so this sub-project needs its own fixture: a minimal **fake Mono
host** DLL, extending #8's probe-DLL pattern, exporting stand-ins for the
handful of `mono_*` functions the bridge calls, backed by small,
hand-built fake metadata (a couple of fake classes with a couple of fake
fields and methods each). This proves the remote-call primitive and the
bridge's call sequencing (attach-before-call, detach-after, argument
marshalling, callback-based enumeration) correctly, without needing
Valheim or any real Mono build.

The Valheim CT table's own known symbols — `Player.m_godMode`,
`Character.ApplyDamage`, `Player.UseStamina` — are this sub-project's
**acceptance test**, the same role Valheim itself played for #7 and #8:
resolve each by name against the real running game, confirm the resolved
address/offset matches what the CT table already proved correct, and (for
`ApplyDamage`) confirm the `immune` hook actually blocks damage for the
player while leaving every other entity's damage untouched.

## Success criteria

1. `Player.m_godMode` resolves to a real, byte-verified address via class
   and static-field name lookup alone — no scanning, no write-watch.
2. `Character.ApplyDamage` resolves to a real, JIT-compiled entry address
   via `mono_compile_method`, and an `immune` patch installed there blocks
   damage for the player specifically while a nearby creature's health
   still changes normally from combat.
3. Killing Tamper mid-session (or a failed remote call) never leaves a
   Mono-internal thread record or an orphaned cave behind that a
   subsequent attach can't clean up.
4. The fake-Mono-host tests pass without a real game; the Valheim
   acceptance checks above are run and recorded, the same way #8's
   Valheim session was.
5. `npx vitest run`, `npx tsc --noEmit`, and `npm run build` all pass.
