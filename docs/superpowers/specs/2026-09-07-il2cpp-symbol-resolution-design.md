# IL2CPP symbol resolution via generic remote-call primitives

## Problem

The Mono resolver (`2026-07-30-mono-resolver-design.md`) gives Tamper and
the `game-memory` MCP server a way to resolve a class/field/method by NAME
against a live **Mono** runtime — but it explicitly scoped IL2CPP out:
"a structurally different resolution mechanism (static metadata files plus
a separate C++ ABI, no live reflection API to call into)."

That gap was real the first time it was hit (Schedule I, IL2CPP,
2026-09-07 session): the CT reference table for the game names every hook
site as a bare `ScheduleOne.Namespace.Class.Method` symbol with NO AOB
signature (Cheat Engine resolved these once, live, off its own symbol
database, and doesn't persist how). Only 3 of ~30 entries in that table
carried real `aobscanmodule` patterns, and even those had gone stale
(binary rebuilt since the table was authored) or weren't unique anymore.
Blind byte-pattern porting could not carry the rest of the table forward.

## Finding: IL2CPP is not reflection-free — it just needs a different call

IL2CPP builds still expose a live, callable API from the game's own
`GameAssembly.dll` — `il2cpp_domain_get`, `il2cpp_class_from_name`,
`il2cpp_class_get_methods`, etc. — it is simply a different export table
than Mono's, not absent. **No IL2CPP-specific bridge needed to be written.**
The Mono bridge's own `RunRemoteCall` primitive (`mono_call.cc`) was
already fully generic — "call any address in the target with up to 4
pointer args, on a throwaway remote thread" has nothing Mono-specific in
it. It just wasn't exposed as an MCP tool before this session. Six thin
tools now expose it directly:

- `resolve_export(handle, moduleBase, name)` — find any exported
  function's address (already-compiled `platform::ResolveExport`, now
  wired up).
- `alloc_scratch(handle, near)` / `write_scratch(handle, address, hex)` /
  `free_scratch(handle, address)` — a small RWX buffer for a string
  argument (namespace/class/method names are plain C strings).
- `call_remote_function(handle, functionAddress, args[])` /
  `call_remote_function_float(...)` — run it, read RAX (or XMM0 for a
  float-returning function).

See `mcp-server/src/tools/remote.ts`. This is the "repeatable method" —
these six primitives are reusable for ANY IL2CPP (or indeed any native)
game, not just Schedule I.

## The recipe

1. **Resolve exports once** (all in `GameAssembly.dll`, same base as
   `list_modules` reports):
   `il2cpp_domain_get`, `il2cpp_domain_assembly_open`,
   `il2cpp_assembly_get_image`, `il2cpp_class_from_name`,
   `il2cpp_class_get_methods`.

2. **Get the domain**: `call_remote_function(domainGet, [])` → domain
   pointer.

3. **Jump straight to the game's own assembly by name** — don't enumerate
   all loaded assemblies (a real Unity game has 100+; brute-forcing them
   to find "Assembly-CSharp" by trial is slow and burns remote-thread
   calls for nothing). `il2cpp_domain_assembly_open(domain, "Assembly-
   CSharp")` (write the name via `alloc_scratch`+`write_scratch` first)
   resolves it in one call.

4. **Assembly → image**: `il2cpp_assembly_get_image(assembly)`.

5. **Resolve the class**: write the namespace and class name as two
   separate scratch strings, `il2cpp_class_from_name(image, ns, name)`.

6. **Enumerate methods without trusting `il2cpp_method_get_name`** — see
   the landmine below. Instead:
   - Call `il2cpp_class_get_methods(classHandle, iterAddr)` once
     (`iterAddr` a zeroed scratch qword) to get the first `MethodInfo*`.
   - **The MethodInfo array is contiguous** (fixed stride, empirically
     `0x58` bytes on Unity 2022.3.62's IL2CPP ABI) — after getting the
     first pointer, read the whole run in ONE `read_bytes` call instead of
     calling the iterator function once per method. This is the single
     biggest cost saving in the whole recipe: an N-method class costs one
     `call_remote_function` (first entry) + one `read_bytes` (the rest),
     not N remote calls.
   - Per `MethodInfo` record (offsets confirmed live against this build —
     re-verify per-engine-version, don't assume portable to a different
     Unity/IL2CPP version without a spot check):
     - `+0x00`: `methodPointer` — the actual compiled function address.
       **This is the address a Tamper patch's `moduleOffset` wants**
       (`methodPointer - GameAssembly.dll base`).
     - `+0x18`: `name` — a `const char*`, read directly with `read_bytes`
       (do not call `il2cpp_method_get_name` — see below).
     - `+0x20`: `klass` — sanity-check this equals the class handle you
       resolved, as a free cross-check that the stride/offsets are right.
   - Match the method you want by decoding each record's name.

7. **Read the resolved method's live original bytes** with `read_bytes`
   before writing a patch's `originalBytes` — a build's compiled prologue
   is not the same as whatever an old reference CT table recorded.

## Landmine: identical-code folding (ICF) makes some exports lie about their signature

Several `il2cpp_*` exports resolved to the SAME address as each other in
this build: `il2cpp_assembly_get_image` / `il2cpp_field_get_offset` /
`il2cpp_image_get_name` / `il2cpp_image_get_filename` all shared one
address; separately, `il2cpp_method_get_name` / `il2cpp_class_get_fields`
/ `il2cpp_class_get_namespace` shared a different one. This is the
compiler/linker's Identical Code Folding (`/OPT:ICF`): when two exported
wrapper functions compile down to byte-identical machine code (most
commonly "return the struct's first pointer-sized field" — true for
`Il2CppAssembly.image` at offset 0 and `Il2CppImage.name` at offset 0,
which is why those two folded together and calling either address on
EITHER kind of pointer harmlessly does the right thing for both), the
linker merges them into one physical function with multiple export
names — **and a build with reflection-heavy APIs stripped (common;
Unity's managed-code-stripping removes unused reflection surface) folds
several genuinely-different, no-longer-implemented getters into a shared
dead stub that returns nothing useful for either.** The
`il2cpp_method_get_name` cluster behaved exactly like the latter in this
session — it is why this recipe reads `MethodInfo.name` directly from the
struct instead of calling the "official" getter.

**Practical rule going forward**: don't trust that a resolved export
address does what its name says. If two names resolve to the same
address, at least one is a folded/stripped stub — verify with a real,
valid pointer before depending on it for anything real, and prefer
reading struct fields directly (once the layout is confirmed by getting
one sane result, like a real method name string) over calling a
by-name accessor whose behavior you haven't independently confirmed.

## Landmine: a bad pointer argument crashes the game, not just the call

Mid-session, passing a mistyped (one-digit-off) pointer as an argument to
a resolved export **crashed the game outright** (process died, Unity's own
crash handler launched, game relaunched as a new PID). This is expected —
`call_remote_function` really does execute `call rax` on a throwaway
thread with whatever bytes you handed it; a garbage pointer dereferenced
inside the target is a real access violation in the game process, with no
sandboxing. Rules that follow from this:

- **Always get pointer values from a tool result or a `read_bytes`/
  `read_value` decode — never retype a long hex value by hand** across
  messages. A transcription slip is indistinguishable from a real bug
  until it crashes something.
- Verify with a cheap, side-effect-free call first (e.g.
  `il2cpp_domain_get()`, no args) before trusting the whole chain.
- A `call_remote_function` timeout/failure result already leaks a thread
  in the target (see `mono_call.cc`'s own comment on this) — a burst of
  those, or one against truly-bad state, is what actually killed the
  process here. Don't retry the same failing call hoping it was transient;
  diagnose why the pointer was wrong first.
- After ANY crash-suspicious result, `list_modules` on the same handle
  before continuing — an empty result means the process (and your attach
  handle) are gone; re-`attach` to the new PID (the module base can land
  in the same place again by chance, as it did here, but never assume it
  without checking `list_modules`).

## Where this leaves the Schedule I table

With this recipe, every `ScheduleOne.X.Y.Z`-named CT entry is resolvable
to a real, current-build address in a handful of remote calls — no live
in-game triggering required for the ADDRESS half of the work (field
offsets embedded in a hook's injected code still benefit from a live
sanity check, since struct layout can shift between builds independently
of method addresses). This is the piece that was missing before this
session; porting the remaining table entries is now mechanical per entry
(resolve class+method → read live prologue bytes → build the same
capture/strip/force shape the CT script already shows), not a research
problem per entry.
