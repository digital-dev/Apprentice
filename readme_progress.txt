  1. Anchor by module, not by scanning all executable memory.
  Most of "thousands of games" are native/IL2CPP/UE — code sits in a loaded module at a fixed RVA. Needed:
  - record moduleName + RVA + module fingerprint (size, timestamp, PE checksum) at capture;
  - on locate: try RVA first, verify bytes against signature, only scan if mismatch;
  - scan restricted to that module's exec sections (faster, far fewer false matches).
  This alone converts most games from "hope the AOB is unique" to arithmetic.

  2. Game build identity.
  Key profiles by exe + module hash/version, not valheim.json. Game updates → mark every cheat needs-reverify instead of silently patching wrong bytes. Without
  this, patch-after-update is the top corruption source at scale.

  3. Signature engine v2. Current: fixed 48 bytes, backward extension, wildcard imm64 only. Three heuristic patches already (doc says a fourth means rewrite).
  Needed:
  - uniqueness-driven length — grow until scan returns exactly 1, verify at capture time and store the match count. Fixed constants can't be right for both an
  11-byte CT pattern and a JIT method.
  - semantic wildcarding via Zydis operand info — wildcard any RIP-rel disp32, any rel32 branch target, any absolute imm, not just imm64. Generic; kills the
  class of bugs the imm64 fix handled one instance of.
  - function-relative anchor: signature the function prologue, store byte offset into it. More stable than an instruction-local window and matches how CE
  tables are written.
  - multiple/fallback signatures + best-effort fuzzy locate requiring user confirm, instead of a hard "re-capture it".

  4. Runtime-specific resolvers — the biggest multiplier. AOB is the fallback, not the plan, for managed engines:
  - Mono: attach to mono.dll, resolve image → class → field by name; field offsets and static field addresses come from the runtime. Survives restarts and
  often updates. This is CE's Mono dissector and it's the correct answer for Valheim health.
  - IL2CPP: parse global-metadata.dat + GameAssembly.dll for the same name→offset map.
  - Unreal: GNames/GObjects/UObject walk.
  Engine detection at attach (UnityPlayer.dll, GameAssembly.dll, mono-2.0-bdwgc.dll, UE markers) picks the resolver. Native games fall back to AOB+RVA.

  5. Pointer-path persistence loop. CE's real workhorse: pointer scan → restart game → rescan-with-new-address to filter chains that still resolve. Needs:
  pointer map generation, multi-level scan with offset bounds, disk-persisted candidate sets, and a "validate against previous session" pass. pointer.cc has
  the resolve half only.

  6. Lifecycle: auto-attach + retry. Already flagged as highest-value in the Valheim doc and still true. Cheats must be declarative: watch for exe launch →
  load profile → per-cheat state machine (pending → located → applied → degraded) → background retry on module-load and on failed locate (Mono JIT only exists
  after first call). Without it every restart is manual, which is what "persists restarts" actually means to the user.

  7. Generality of the patch itself. Four hardcoded modes (nop/force/capture/guard) won't cover thousands of games. Needed: an assembler (Zydis is decode-only
  — add zydis-encoder or asmjit) and a CE-style AA script layer, so a cheat body is user-authored asm with alloc/label/registersymbol semantics. Also gives you
  a target to compile CE tables into.

  8. Import Cheat Engine .CT. XML: addresses, pointer paths, AOB scripts. Bootstrapping from the existing public corpus is the only realistic route to
  thousands of games. Export too.

  9. Finding tools you don't have. Health failed because of missing discovery, not missing patching: read-watch ("what accesses"), struct dissect + compare two
  entities to isolate a player-unique field, unknown-initial-value / changed-value scans, group scan, string/double/byte-array types.

  10. 32-bit games. Encoders and cave logic are x64-only. Lots of the long tail is x86 — WOW64 read/write, 32-bit decode/encode paths.

  11. Test strategy that scales. harness.exe is static MSVC; the doc already admits nearly every real defect was invisible there. Need recorded fixtures: dump
  exec regions + capture metadata from real games, replay signature-build and locate offline. That's how you regression-test signature heuristics against N
  games without owning N games.