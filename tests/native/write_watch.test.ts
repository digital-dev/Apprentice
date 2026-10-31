import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnHarness } from '../helpers/spawnHarness'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams
let handle: number

function send(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    harness.stdout.once('data', (d) => resolve(d.toString().trim()))
    harness.stdin.write(cmd + '\n')
  })
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  harness = spawnHarness()
  await new Promise((r) => harness.stdout.once('data', r))
  handle = (addon as any).attach(harness.pid).handle
})

afterAll(() => {
  try { (addon as any).stopWriteWatch() } catch { /* ignore */ }
  harness.stdin.write('q\n')
  harness.kill()
})

// Resolve the address of g_player.stamina by scanning for its 77.0 value,
// narrowed to one via the setp command.
//
// Cached because the scan only works once: it keys off the field's INITIAL
// 77.0, and the first test to run overwrites that. The address itself stays
// valid for the harness's lifetime, so later tests reuse it rather than
// re-deriving it from a value that is no longer there.
let cachedStaminaAddress: string | null = null

async function staminaAddress(): Promise<string> {
  if (cachedStaminaAddress) return cachedStaminaAddress
  cachedStaminaAddress = await resolveStaminaAddress()
  return cachedStaminaAddress
}

async function resolveStaminaAddress(): Promise<string> {
  let candidates = await (addon as any).scanFirst(handle, 'float', 77.0)
  await send('setp 33')
  candidates = await (addon as any).scanNext(handle, candidates, 'float', { mode: 'exact', value: 33 })
  expect(candidates.length).toBe(1)
  return candidates[0].address
}

// Resolve the address of g_player.shield (offset 4 inside PlayerComponent) —
// the field a single 16-byte SSE store (`shieldloop`) covers without
// starting at it. Same once-only-scan caveat as staminaAddress: the scan
// keys off the field's INITIAL 55.0, which the first test to run overwrites.
let cachedShieldAddress: string | null = null

async function shieldAddress(): Promise<string> {
  if (cachedShieldAddress) return cachedShieldAddress
  cachedShieldAddress = await resolveShieldAddress()
  return cachedShieldAddress
}

async function resolveShieldAddress(): Promise<string> {
  let candidates = await (addon as any).scanFirst(handle, 'float', 55.0)
  await send('setshield 66')
  candidates = await (addon as any).scanNext(handle, candidates, 'float', { mode: 'exact', value: 66 })
  expect(candidates.length).toBe(1)
  return candidates[0].address
}

describe('write watch — capture', () => {
  it('catches a write instruction and detaches cleanly', async () => {
    const address = await staminaAddress()

    ;(addon as any).startWriteWatch(harness.pid, address)
    await send('watchloop')

    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = (addon as any).pollWriteWatch()
    }
    await send('stoploop')
    const final = (addon as any).stopWriteWatch()

    expect(list.length).toBeGreaterThan(0)
    expect(final.length).toBe(1)

    const insn = final[0]
    expect(insn.baseRegister.length).toBeGreaterThan(0)
    expect(insn.baseRegister).not.toBe('rip') // object write goes through a GPR
    // base register held g_player; displacement is the stamina field offset (16).
    // displacement is a signed decimal string (see the write-watch fix for
    // why), not hex — parse it as such.
    expect(parseInt(insn.displacement, 10)).toBe(16)
    const base = BigInt(insn.baseAddress)
    const disp = BigInt(insn.displacement)
    expect('0x' + (base + disp).toString(16)).toBe(address)
    // The writing instruction lives in the harness module.
    expect(insn.moduleName === null || typeof insn.moduleName === 'string').toBe(true)
    // Signature is space-separated hex byte tokens, each 2 hex chars or '??'.
    expect(insn.signature.length).toBeGreaterThan(0)
    for (const tok of insn.signature.split(' ')) {
      expect(tok === '??' || /^[0-9a-f]{2}$/.test(tok)).toBe(true)
    }

    // Full GPR snapshot and stack-top read at trap time (added for caller
    // recovery — see write_watch.cc's Caught struct comment: stackTop[0] is
    // a real return address only for a leaf function with no prologue push
    // before the watched write, which this harness command doesn't promise,
    // so this only checks shape, not that stackTop[0] resolves to anything).
    expect(insn.registers).not.toBeNull()
    for (const reg of ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp',
                        'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15']) {
      expect(typeof insn.registers[reg]).toBe('string')
      expect(insn.registers[reg].startsWith('0x')).toBe(true)
    }
    expect(Array.isArray(insn.stackTop)).toBe(true)
    expect(insn.stackTop.length).toBeGreaterThan(0)
    for (const s of insn.stackTop) expect(s.startsWith('0x')).toBe(true)

    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true)
  }, 15000)
})

describe('write watch — covering write (single SSE store)', () => {
  // `shieldloop` writes `g_player.shield` (offset 4) via a single 16-byte
  // `movups [reg], xmm` whose effective address is the struct base (offset
  // 0) — unlike wideloop's block copy, this is one instruction with a
  // static destination register that never advances, so it stays
  // attributable at the trap. This is the shape the covering-write
  // relaxation in FindWriteInstruction actually exists for (a SIMD/struct
  // field write, not a memcpy-style loop), and it must decode with
  // effectiveAddress strictly before the watched address — proving the
  // match is a genuine COVERING match, not an exact one in disguise.
  //
  // Runs BEFORE the wideloop test below: wideloop's block copy overwrites
  // g_player.shield too (it rewrites the whole struct), which would corrupt
  // the 55.0 initial value this test's scan keys off before it ever gets a
  // chance to resolve the address.
  it('decodes the covering SSE store and reports effectiveAddress before the watched field', async () => {
    const address = await shieldAddress()

    ;(addon as any).startWriteWatch(harness.pid, address)
    await send('shieldloop')

    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = (addon as any).pollWriteWatch()
    }
    await send('stopshield')
    const final = (addon as any).stopWriteWatch()

    expect(list.length).toBeGreaterThan(0)
    expect(final.length).toBeGreaterThan(0)

    const insn = final[0]
    expect(insn.length).toBeGreaterThan(0)
    expect(insn.baseRegister.length).toBeGreaterThan(0)
    expect(insn.indexed).toBe(false) // plain [reg] addressing, no index register involved

    const watched = BigInt(address)
    const effective = BigInt(insn.effectiveAddress)
    const accessBytes = BigInt(insn.accessBytes)
    expect(effective <= watched).toBe(true)
    expect(watched < effective + accessBytes).toBe(true)
    // The defining property of a COVERING (not exact) match: the store's
    // effective address is the struct base, strictly before `shield` at
    // offset 4 inside it.
    expect(effective !== watched).toBe(true)

    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true)
  }, 15000)
})

describe('write watch — covering write (wide store)', () => {
  // `wideloop` writes the whole PlayerComponent in one store rather than
  // just the stamina field — the covering-write relaxation in
  // FindWriteInstruction exists for exactly this shape (a struct copy /
  // SIMD store whose effective address is the start of a block containing
  // the watched field), and until now nothing in the suite drove it; it was
  // exercised only by manual testing against a real game.
  // Not run on Linux: this pins a Windows/MSVC-specific codegen shape. The
  // gcc -O0 ELF harness's wide_write does NOT compile the 20-byte struct
  // copy to a movs-style block copy at all (confirmed via objdump) — it
  // emits three independent fixed-destination-register mov instructions
  // (offsets 0-7, 8-15, 16-19 of PlayerComponent), so the one covering the
  // watched `stamina` field (offset 16) is a perfectly ordinary, decodable
  // `mov %eax,0x10(%rcx)`. FindWriteInstruction correctly decodes it
  // (length 3, baseRegister 'rcx'), which is NOT a bug — there is simply no
  // undecodable block copy on this build to reproduce the "documented
  // limitation" against. Root-caused while bringing this file up on Linux
  // (Task 15); not a DebugSession/ptrace issue.
  it.skipIf(process.platform === 'linux')('catches the wide store but leaves it undecoded (documented limitation)', async () => {
    const address = await staminaAddress()

    ;(addon as any).startWriteWatch(harness.pid, address)
    await send('wideloop')

    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = (addon as any).pollWriteWatch()
    }
    await send('stopwide')
    const final = (addon as any).stopWriteWatch()

    expect(list.length).toBeGreaterThan(0)
    expect(final.length).toBeGreaterThan(0)

    // This pins a documented limitation, not a success path — see
    // docs/superpowers/follow-ups/2026-07-25-code-patch-cheats.md ("A
    // `movs`-style block copy still cannot be attributed to a field").
    // `wide_write`'s `*p = v` compiles to a movs-style block copy whose
    // destination register auto-advances as it runs, so by the time the
    // #DB trap lands, post-trap register state no longer points at the
    // watched address — the row is caught (it exists, hence
    // final.length > 0 above) but FindWriteInstruction cannot attribute it
    // to any decoded instruction, hence length === 0 and baseRegister === ''
    // below. This must fail equally if the block copy became decodable
    // (regression toward guessing) or if the row stopped being caught at
    // all (regression in capture itself) — unlike the previous version of
    // this test, there is no branch that swallows either direction.
    const insn = final[0]
    expect(insn.length).toBe(0)
    expect(insn.baseRegister).toBe('')

    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true) // target still alive after the undecoded catch
  }, 15000)
})

describe('write watch — negative displacement', () => {
  // `write_negdisp` stores through a base pointer that lands PAST the
  // watched field (`&g_negdisp_value + 1`, i.e. `*(end - 1) = v`), so the
  // caught instruction's base register holds an address AHEAD of the
  // watched address and out.displacement (watched - base) is negative.
  // This is exactly the shape that exposed the signed-vs-unsigned
  // serialization bug: casting a negative int64_t through uintptr_t before
  // hex-formatting turned e.g. -4 into "0xfffffffffffffffc", a huge
  // positive number once BigInt(...)'d on the JS side.
  // Not run on Linux: another Windows/MSVC-specific codegen shape (confirmed
  // via objdump). gcc -O0 compiles `*(end - 1) = v` by materializing `end -
  // 1` into rax with its own `sub $0x4,%rax` FIRST, then stores through rax
  // with a plain, zero-displacement `movss %xmm0,(%rax)` — the pointer
  // arithmetic never appears as a displacement embedded in the store
  // instruction itself (unlike MSVC's apparent `movss [rax-4], xmm0`), so
  // the captured instruction's displacement is correctly 0, not negative.
  // There is no negative-displacement store to find on this build; this is
  // a codegen difference, not a sign-handling regression in write_watch.cc
  // (the bug this test guards was fixed ahead of this exact test on
  // Windows and is unaffected by not running here). Root-caused while
  // bringing this file up on Linux (Task 15); not a DebugSession issue.
  it.skipIf(process.platform === 'linux')('reports a negative displacement as a signed value, not a huge unsigned one', async () => {
    let candidates = await (addon as any).scanFirst(handle, 'float', 44.0)
    await send('setnegdisp 91')
    candidates = await (addon as any).scanNext(handle, candidates, 'float', { mode: 'exact', value: 91 })
    expect(candidates.length).toBe(1)
    const address = candidates[0].address

    ;(addon as any).startWriteWatch(harness.pid, address)
    await send('negdisploop')

    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = (addon as any).pollWriteWatch()
    }
    await send('stopnegdisp')
    const final = (addon as any).stopWriteWatch()

    expect(list.length).toBeGreaterThan(0)
    expect(final.length).toBeGreaterThan(0)

    const insn = final[0]
    expect(insn.baseRegister.length).toBeGreaterThan(0)
    // Not hex — a signed decimal string. Confirms the fix: the old
    // ToHex((uintptr_t)displacement) would have produced a huge unsigned
    // hex value here instead.
    expect(insn.displacement).toMatch(/^-\d+$/)
    expect(BigInt(insn.displacement)).toBeLessThan(0n)
    const base = BigInt(insn.baseAddress)
    const disp = BigInt(insn.displacement)
    expect('0x' + (base + disp).toString(16)).toBe(address)

    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true)
  }, 15000)
})

describe('write watch — DLL load/unload during a session', () => {
  // A live game loading assemblies is hard to simulate deterministically in
  // a unit test; this instead confirms the LOAD_DLL_DEBUG_EVENT branch
  // exists and compiles/dispatches correctly by driving an actual DLL
  // load/unload while a watch session is armed (loaddll/unloaddll load
  // test-harness/probe.dll, already used by mono_call.test.ts's own
  // scenarios) and confirming the session completes cleanly — no hang, no
  // crash, and a normal stop still returns an array. Node has no portable
  // per-process handle-count API to assert the leak directly from a Vitest
  // test, so this guards against a regression in the debug-event dispatch's
  // control flow rather than asserting a handle count.
  it('does not hang or crash a session that sees a DLL load and unload', async () => {
    const address = await staminaAddress()

    ;(addon as any).startWriteWatch(harness.pid, address)
    await send('loaddll')
    await send('unloaddll')
    await send('watchloop')

    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = (addon as any).pollWriteWatch()
    }
    await send('stoploop')
    const final = (addon as any).stopWriteWatch()

    expect(Array.isArray(final)).toBe(true)
    expect(list.length).toBeGreaterThan(0)

    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true)
  }, 15000)
})

describe('write watch — detaching while the target is still writing', () => {
  it('leaves the target alive when the watch stops mid-write', async () => {
    const address = await staminaAddress()

    ;(addon as any).startWriteWatch(harness.pid, address)
    await send('watchloop')

    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = (addon as any).pollWriteWatch()
    }
    expect(list.length).toBeGreaterThan(0)

    // Deliberately do NOT stop the harness's write loop first. Every other
    // test here sends 'stoploop' before stopping the watch, which empties
    // the debug-event queue and hides the failure this test exists for:
    // clearing Dr7 does not un-raise an exception the CPU has already
    // fired, so any queued debug exception gets delivered after detach to a
    // process with no debugger and kills it with STATUS_SINGLE_STEP. That
    // is what made closing the app take the game down with it.
    ;(addon as any).stopWriteWatch()

    await sleep(500) // let the loop keep writing across the detach
    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true) // still alive and responsive

    await send('stoploop')
  }, 15000)
})

describe('write watch — stop releases the target', () => {
  // The contract the DebugSession abstraction has to keep on every platform:
  // stopping a watch disarms the breakpoint on every thread and detaches,
  // leaving the target running with no debugger. A breakpoint left armed
  // after detach kills the target on its next write to the field (an
  // unhandled single-step with no debugger to take it), and a debugger left
  // attached makes the next attach fail.
  it('stops watching and the target keeps running after stop', async () => {
    const address = await staminaAddress()

    ;(addon as any).startWriteWatch(harness.pid, address)
    await sleep(200)
    const final = (addon as any).stopWriteWatch()
    expect(Array.isArray(final)).toBe(true)

    // Write the formerly watched field from the harness's own thread, then
    // ping it: both only answer if the breakpoint really came down.
    expect((await send('setp 12')).startsWith('OK')).toBe(true)
    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true)

    // Detached for real: a fresh session attaches and stops cleanly.
    ;(addon as any).startWriteWatch(harness.pid, address)
    ;(addon as any).stopWriteWatch()
    expect((await send('get')).startsWith('OK')).toBe(true)
  }, 15000)
})

describe('write watch — app teardown mid-watch', () => {
  // Simulates the app quitting while a watch is still armed, the same
  // mid-write path the "detaching while the target is still writing" test
  // above covers for the TARGET's health — this one instead checks the
  // ADDON's own health (this Node process, via the native module), which is
  // the thing an app-teardown call path actually depends on: Detach's Dr7
  // clear-and-detach sequence (platform_win32.cc's drain loop; Linux's
  // DetachOnTracer) must never itself crash or hang the caller, even when
  // called without first telling the harness to stop writing.
  it('app teardown mid-watch leaves the harness running', async () => {
    const address = await staminaAddress()

    ;(addon as any).startWriteWatch(harness.pid, address)
    await send('watchloop')

    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = (addon as any).pollWriteWatch()
    }
    expect(list.length).toBeGreaterThan(0)

    ;(addon as any).stopWriteWatch()
    // The addon survived the stop/detach intact (no crash, no hang in the
    // synchronous join StopWriteWatch does).
    expect((addon as any).ping()).toBe('pong')
    // And the harness it was watching is still alive and responsive.
    expect((await send('get')).startsWith('OK')).toBe(true)

    await send('stoploop')
  }, 15000)
})

describe('write watch — hardware debug registers unavailable', () => {
  // APPRENTICE_FORCE_NO_DEBUGREGS is honoured only by the Linux backend
  // (platform_linux_debug.cc's SupportsHardwareWatch) — it exists so this
  // exact path is deterministically testable even on a CI kernel whose
  // nested-virtualization host hides hardware breakpoints entirely (no
  // amount of ptrace capability fixes that; it is a hypervisor limit this
  // project does not control). Windows' SupportsHardwareWatch always
  // returns true and never looks at this variable, so this test is Linux
  // only.
  it.skipIf(process.platform === 'win32')(
    'reports a clear error when debug registers are unavailable',
    () => {
      process.env.APPRENTICE_FORCE_NO_DEBUGREGS = '1'
      try {
        expect(() => (addon as any).startWriteWatch(harness.pid, '0x1000')).toThrow(/not supported/i)
      } finally {
        delete process.env.APPRENTICE_FORCE_NO_DEBUGREGS
      }
    },
  )
})

describe('write watch — attach failure handling', () => {
  // A pid this large should not exist, so DebugActiveProcess fails to attach.
  const badPid = 999999999

  it('throws when it fails to attach to an invalid pid', () => {
    expect(() => (addon as any).startWriteWatch(badPid, '0x1000')).toThrow()
  })

  it('does not crash the process across repeated failed attaches with no intervening stop', () => {
    // Each failed attach leaves its loop thread exited-but-unjoined
    // (DebugLoop sets running=false without ever being joined). Before the
    // fix, the next startWriteWatch's `g_session.loop = std::thread(...)`
    // move-assignment onto that still-joinable thread called
    // std::terminate() and aborted the whole process — which would kill
    // this test runner outright rather than surface as a failed assertion.
    expect(() => (addon as any).startWriteWatch(badPid, '0x1000')).toThrow()
    expect(() => (addon as any).startWriteWatch(badPid, '0x1000')).toThrow()
    expect(() => (addon as any).startWriteWatch(badPid, '0x1000')).toThrow()

    // Reaching here proves the process survived. The addon (and, by
    // extension, the rest of the trainer) is still responsive.
    expect((addon as any).ping()).toBe('pong')
  })
})

// Regressions for FindWriteInstruction's candidate ranking (write_watch.cc).
// Both hand-build the ENTIRE instruction stream at the capture site — via
// allocateCave/writeBytes/encodeJump, the same primitives cave_ops.test.ts
// proves work end to end — rather than hoping the compiler emits a
// particular byte pattern for probe_write. That keeps the adversarial bytes
// exact and deterministic: whichever register/displacement form the
// compiler actually chose for probe_write's own store is irrelevant, since
// `movabsRax` loads the watched address directly and the crafted store
// always targets it through `rax`.
//
// Neither test proves a value gets forced (that is Task 9's job) — they
// only prove the captured instruction's address/length is the real store,
// not a coincidental neighboring decode, which is the thing a NOP patch or
// a force injection is built from.
// Not run on Linux: these tests redirect the probe site into a hand-crafted
// cave ending in a BARE `ret` (e.g. `f3 0f 11 00 c3`), which assumes the
// compiled probe_write's tail, from the watched store onward, is nothing
// but that store plus `ret` — true of the Windows harness.exe's MSVC /Od
// output, which this suite (and its exact crafted hex) was written
// against. The gcc -O0 ELF harness keeps a frame pointer, so its
// probe_write is `... movss %xmm0,(%rax); nop; pop %rbp; ret` (confirmed
// via objdump): decodeRun's own 5-byte JMP footprint covers only the movss
// + that one nop, leaving `pop %rbp; ret` as the real tail. Redirecting
// into a cave whose own code ends in a bare `c3` skips that `pop %rbp`
// entirely, so the `ret` pops the still-on-stack saved RBP as if it were a
// return address and the harness segfaults on the very first capture —
// reproduced and root-caused while bringing this file up on Linux (Task
// 15); not a DebugSession/ptrace bug, and the same category of
// cross-compiler byte-shape dependency signature_golden.test.ts is
// excluded on Linux for. Fixing it would mean hand-crafting a separate,
// gcc-tail-aware set of bytes per case (and keeping them in sync with
// whatever gcc emits), which is a separate piece of work from the ptrace
// write-watch backend itself.
describe.skipIf(process.platform === 'linux')('write watch — decode-ranking regressions', () => {
  // Resolved once: like staminaAddress/shieldAddress above, the scan keys
  // off g_probe_value's initial 30.0, which the first use overwrites, and
  // once redirected the site is committed to running hand-crafted cave code
  // for the rest of the suite — recomputing it per test would break.
  let cachedProbeSite: { watchedAddress: string; codeAddress: string; runLength: number } | null =
    null

  // Crafted code is written starting this far into the cave, not at its
  // very first byte. FindWriteInstruction reads up to 15 bytes BACKWARD
  // from the trap's rip to find the real instruction; with code starting
  // at the cave's own first byte, that backward window reads past the
  // start of the (page-granular) allocation into whatever precedes it,
  // which can be unmapped and makes the whole read fail. Leaving room
  // before the crafted bytes keeps the backward window entirely inside the
  // cave's own allocated page.
  const CODE_PAD = 16

  // DebugActiveProcessStop (inside stopWriteWatch) returns before the OS has
  // necessarily finished tearing down the debugger's injected thread in the
  // target — a suspendThreads soon afterward can catch that thread mid-
  // teardown, where OpenThread fails and SuspendAll reports "failed to
  // suspend every thread" even though nothing is actually wrong. A fixed
  // delay was tried first and was not reliable (the exact gap needed varies
  // run to run), so this retries instead: poll until suspendThreads either
  // succeeds or a generous budget elapses, mirroring how the rest of this
  // suite already polls pollWriteWatch rather than assuming a fixed wait is
  // long enough.
  async function suspendThreadsRetrying(): Promise<void> {
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        expect((addon as any).suspendThreads(handle, harness.pid)).toBe(true)
        return
      } catch (err) {
        if (Date.now() >= deadline) throw err
        await sleep(100)
      }
    }
  }

  async function probeSite(): Promise<{
    watchedAddress: string
    codeAddress: string
    runLength: number
  }> {
    if (cachedProbeSite) return cachedProbeSite

    let candidates = await (addon as any).scanFirst(handle, 'float', 30.0)
    await send('setprobe 3939')
    candidates = await (addon as any).scanNext(handle, candidates, 'float', { mode: 'exact', value: 3939 })
    expect(candidates.length).toBe(1)
    const watchedAddress = candidates[0].address

    ;(addon as any).startWriteWatch(harness.pid, watchedAddress)
    await send('probeloop')
    let caught: any[] = []
    for (let i = 0; i < 40 && caught.length === 0; i++) {
      await sleep(50)
      caught = (addon as any).pollWriteWatch()
    }
    const insn = (addon as any).stopWriteWatch()[0]
    await send('stopprobe')
    // Let the harness's probe_thread actually notice g_probe_running==0 and
    // exit (it only checks between 10ms sleep_ms cycles) before anything
    // below sends another `probeloop`: harness.c's probeloop command starts
    // a new thread only `if (!g_probe_running)`, so a probeloop sent while
    // this stale thread is still alive (just not yet having rechecked the
    // flag) sets g_probe_running back to 1 without spawning a new thread —
    // the OLD thread then wakes up, sees the flag true again, and keeps
    // looping through whatever `redirectProbeSiteTo` patches next, racing
    // the new capture. On Linux this reliably showed up as two threads
    // concurrently running the redirected cave code and segfaulting the
    // harness; Windows' thread timing happens not to hit this window.
    await sleep(50)
    expect(insn.length).toBeGreaterThan(0)

    const codeAddress = insn.instructionAddress
    const run = (addon as any).decodeRun(handle, codeAddress, 5)
    expect(run.decodable).toBe(true)

    cachedProbeSite = { watchedAddress, codeAddress, runLength: run.length }
    return cachedProbeSite
  }

  // `48 b8 <8-byte little-endian address>` = `movabs rax, address` — loads
  // the watched address directly, so the crafted store's destination never
  // depends on whatever register probe_write's compiled prologue happens to
  // use.
  function movabsRax(address: string): string {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64LE(BigInt(address))
    return '48b8' + buf.toString('hex')
  }

  // Redirects the (already-captured) probe site into a fresh cave running
  // `nop * CODE_PAD + movabsRax(watched) + storeAndReturn`, under the same
  // suspend/write/resume bracketing the brief's own end-to-end test uses.
  async function redirectProbeSiteTo(storeAndReturnHex: string): Promise<string> {
    const { watchedAddress, codeAddress, runLength } = await probeSite()
    const cave = (addon as any).allocateCave(handle, codeAddress)
    expect(cave).not.toBeNull()
    const entry = '0x' + (BigInt(cave) + BigInt(CODE_PAD)).toString(16)
    const body = '90'.repeat(CODE_PAD) + movabsRax(watchedAddress) + storeAndReturnHex
    expect((addon as any).writeBytes(handle, cave, body)).toBe(true)

    const jump = (addon as any).encodeJump(codeAddress, entry)
    const padded = jump + '90'.repeat(runLength - 5)
    await suspendThreadsRetrying()
    try {
      expect((addon as any).writeBytes(handle, codeAddress, padded)).toBe(true)
    } finally {
      (addon as any).resumeThreads()
    }
    return watchedAddress
  }

  async function captureOnce(watchedAddress: string): Promise<any> {
    ;(addon as any).startWriteWatch(harness.pid, watchedAddress)
    await send('probeloop')
    let caught: any[] = []
    for (let i = 0; i < 40 && caught.length === 0; i++) {
      await sleep(50)
      caught = (addon as any).pollWriteWatch()
    }
    const insn = (addon as any).stopWriteWatch()[0]
    await send('stopprobe')
    // See the matching comment in probeSite(): give the harness's
    // probe_thread a chance to actually exit before the next
    // redirectProbeSiteTo/captureOnce round sends another `probeloop`.
    await sleep(50)
    return insn
  }

  it('picks the real 4-byte store over a coincidental 2-byte suffix decode', async () => {
    // `f3 0f 11 00` (movss [rax], xmm0, 4 bytes) followed by `c3` (ret) —
    // the exact organic shape that originally hid the real store: the
    // store's own last two bytes (`11 00`) also independently decode as a
    // valid, shorter `adc [rax], eax` landing on the same rip with the same
    // effective address. If ranking ever regresses to "first match nearest
    // rip", this reproduces that bug deterministically.
    const watchedAddress = await redirectProbeSiteTo('f30f1100c3')
    const insn = await captureOnce(watchedAddress)

    expect(insn.length).toBe(4)
    expect(insn.bytes).toBe('f30f1100')
  }, 15000)

  it('picks the real 4-byte store over a coincidental prefix-extended decode', async () => {
    // `3e` (a DS segment-override prefix, architecturally ignored for
    // ordinary memory addressing in 64-bit mode) tacked directly in front
    // of the same real store. `3e f3 0f 11 00` decodes as ONE 5-byte
    // instruction ending at the same rip as the 4-byte `f3 0f 11 00` alone,
    // with the identical operand — a coincidental over-decode that must not
    // outrank the genuine, shorter, prefix-free instruction found nearer to
    // rip.
    const watchedAddress = await redirectProbeSiteTo('3ef30f1100c3')
    const insn = await captureOnce(watchedAddress)

    expect(insn.length).toBe(4)
    expect(insn.bytes).toBe('f30f1100')
  }, 15000)

  it('does not treat a bare REX as inert when it changes the OTHER operand', async () => {
    // ModRM 0x30 = mod00,reg=110,rm=000 — [rax] destination, reg field
    // selects the SOURCE 8-bit register. Without a REX prefix, reg=110 is
    // `dh`; WITH one (even a REX encoding no bits at all, 0x40), the 8-bit
    // register set switches from ah/ch/dh/bh to spl/bpl/sil/dil, so the
    // SAME reg field instead selects `sil`. `88 30` (`mov [rax], dh`, 2
    // bytes) and `40 88 30` (`mov [rax], sil`, 3 bytes) are genuinely
    // DIFFERENT instructions that happen to share the same memory
    // destination and the same rip — a byte-value rule that calls 0x40
    // always "content-free" would misjudge them as the same instruction
    // wearing a prefix and keep the shorter (wrong) one; comparing the
    // actual decoded operands (see IsInertPrefixExtensionOf) tells them
    // apart and keeps the genuine, longer `mov [rax], sil`.
    const watchedAddress = await redirectProbeSiteTo('408830c3')
    const insn = await captureOnce(watchedAddress)

    expect(insn.length).toBe(3)
    expect(insn.bytes).toBe('408830')
  }, 15000)
})
