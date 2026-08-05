# Mono Authoring Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Mono Explorer's existing "resolve by name, no JSON editing" workflow cover two gaps found while cataloguing missing Valheim cheats: cross-class search + live field values (so a field can be found without a reference CE table), and one-hop instance-field arming for immune/guard patches (so `Skills:OnDeath`-shaped cheats — armed through `Player.m_localPlayer` → `.m_skills`, not a static field alone — can be built through the UI).

**Architecture:** Both gaps extend existing modules rather than introducing new subsystems. All new resolution logic is pure, testable functions added to `src/main/monoTargetResolve.ts` (same shape as the existing `resolveMonoTargetAddress`), wired into `ipc.ts`/`preload`/`tamper.d.ts` with thin glue, and surfaced in the existing `CheatList.tsx` immune mini-form and `MonoExplorer.tsx` screen. No native (`native/src/mono_bridge.cc`) changes are needed — every new capability composes primitives (`resolveClass`, `resolveField`, `staticFieldAddress`, `readBytes`) that already exist.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React, Vitest.

## Global Constraints

- Every new resolver function returns `null`/an error string on failure — never throws — matching every existing function in `monoTargetResolve.ts`, `anchor.ts`, and `monoResolver.ts`.
- No new native/C++ code — this plan is proven achievable with existing native primitives (see spec's "Design" section, confirmed against `src/main/ipc.ts`, `src/main/patchEngine.ts`, `src/main/monoTargetResolve.ts` during brainstorming).
- Two-hop resolution (static field → instance → one more instance field) is the ceiling — no arbitrary-depth chains (per spec's Non-goals).
- Follow this codebase's established pattern: pure resolution logic lives in a plain function taking an `ops` interface (testable with a fake, no live process needed); Electron wiring (`ipcMain.handle`, `contextBridge`) stays a thin pass-through with no logic of its own.

---

### Task 1: One-hop pointer-chain resolver (`resolveMonoPointerChain`)

**Files:**
- Modify: `src/main/monoTargetResolve.ts`
- Test: `tests/main/monoTarget.test.ts`

**Interfaces:**
- Consumes: `MonoResolverOps` (already defined in `monoTargetResolve.ts`); `slotHexToPointer` from `src/main/patchEngine.ts` (already exported there, line 177).
- Produces: `resolveMonoPointerChain(handle: number, monoDllBase: string, className: string, staticFieldName: string, ops: MonoResolverOps, instanceFieldName?: string): Promise<string | null>` — later tasks (2) call this.

- [ ] **Step 1: Write the failing tests**

Add to `tests/main/monoTarget.test.ts` (reuse the existing `FakeResolver` class already in that file):

```ts
import { resolveMonoTargetAddress, resolveMonoPointerChain, MonoResolverOps } from '../../src/main/monoTargetResolve'
```

(add `resolveMonoPointerChain` to the existing import line)

```ts
describe('resolveMonoPointerChain', () => {
  it('resolves a plain static pointer with no instance hop', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.memory.set('0x9100', '0030000000000000') // little-endian pointer 0x3000

    const pointer = await resolveMonoPointerChain(1, '0x400000', 'Player', 'm_localPlayer', ops)
    expect(pointer).toBe('0x3000')
  })

  it('follows one more instance field to a second object (the Skills:OnDeath shape)', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.staticAddresses.set('0xc2.m_skills', '2000') // field OFFSET, per store.ts's field-offset shape
    ops.memory.set('0x9100', '0030000000000000') // Player instance pointer 0x3000
    ops.memory.set('0x' + (0x3000 + 2000).toString(16), '0040000000000000') // Skills instance pointer 0x4000

    const pointer = await resolveMonoPointerChain(1, '0x400000', 'Player', 'm_localPlayer', ops, 'm_skills')
    expect(pointer).toBe('0x4000')
  })

  it('returns null when the class does not resolve', async () => {
    const ops = new FakeResolver()
    const pointer = await resolveMonoPointerChain(1, '0x400000', 'Player', 'm_localPlayer', ops, 'm_skills')
    expect(pointer).toBeNull()
  })

  it('returns null when the first hop pointer reads as zero', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.memory.set('0x9100', '0000000000000000')
    const pointer = await resolveMonoPointerChain(1, '0x400000', 'Player', 'm_localPlayer', ops, 'm_skills')
    expect(pointer).toBeNull()
  })

  it('returns null when the second hop field is not found', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.memory.set('0x9100', '0030000000000000')
    // no ops.staticAddresses entry for 0xc2.m_skills -> resolveField returns null
    const pointer = await resolveMonoPointerChain(1, '0x400000', 'Player', 'm_localPlayer', ops, 'm_skills')
    expect(pointer).toBeNull()
  })

  it('returns null when the second hop pointer reads as zero', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.staticAddresses.set('0xc2.m_skills', '2000')
    ops.memory.set('0x9100', '0030000000000000')
    ops.memory.set('0x' + (0x3000 + 2000).toString(16), '0000000000000000')
    const pointer = await resolveMonoPointerChain(1, '0x400000', 'Player', 'm_localPlayer', ops, 'm_skills')
    expect(pointer).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/main/monoTarget.test.ts`
Expected: FAIL — `resolveMonoPointerChain` is not exported yet.

- [ ] **Step 3: Implement `resolveMonoPointerChain`**

In `src/main/monoTargetResolve.ts`, add this import at the top (alongside the existing `MonoTarget` import):

```ts
import { slotHexToPointer } from './patchEngine'
```

Then append this function at the end of the file:

```ts
// Resolves a live object pointer by dereferencing a class's static field,
// and optionally following ONE more instance field declared on that SAME
// class to a second object — the Player.m_localPlayer -> .m_skills shape an
// immune patch's arm value needs when the object it must compare against
// isn't the player itself, but something the player owns (Skills:OnDeath's
// `this` is the player's Skills instance, not the Player instance). Both
// fields must belong to the same classHandle, exactly like
// resolveMonoTargetAddress's instanceFieldName hop above — every failure
// mode returns null, matching every other resolver in this file.
export async function resolveMonoPointerChain(
  handle: number,
  monoDllBase: string,
  className: string,
  staticFieldName: string,
  ops: MonoResolverOps,
  instanceFieldName?: string
): Promise<string | null> {
  const classHandle = await ops.resolveClass(handle, monoDllBase, '', className)
  if (classHandle === null) return null

  const staticAddress = await ops.staticFieldAddress(handle, monoDllBase, classHandle, staticFieldName)
  if (staticAddress === null) return null

  const bytes = ops.readBytes(staticAddress, 8)
  if (bytes === null) return null
  const pointer = slotHexToPointer(bytes)
  if (BigInt(pointer) === 0n) return null // the game hasn't set this yet this session

  if (instanceFieldName === undefined) return pointer

  const field = await ops.resolveField(handle, monoDllBase, classHandle, instanceFieldName)
  if (field === null) return null

  const fieldAddress = addHex(pointer, BigInt(field.offset))
  const fieldBytes = ops.readBytes(fieldAddress, 8)
  if (fieldBytes === null) return null
  const instancePointer = slotHexToPointer(fieldBytes)
  if (BigInt(instancePointer) === 0n) return null

  return instancePointer
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/main/monoTarget.test.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/main/monoTargetResolve.ts tests/main/monoTarget.test.ts
git commit -m "Add one-hop instance-field pointer resolution for immune arming

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WTRkUftV3WSHjj2Gd1gN95"
```

---

### Task 2: Wire the arm chain through the store schema, patch engine, and IPC

**Files:**
- Modify: `src/main/store.ts`
- Modify: `src/main/anchor.ts`
- Modify: `src/main/patchEngine.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/tamper.d.ts`
- Test: `tests/main/patchEngine.test.ts`

**Interfaces:**
- Consumes: `resolveMonoPointerChain` from Task 1.
- Produces: `PatchCheat.armPointerInstanceFieldName?: string`; `MonoOps.resolvePointer` (in `anchor.ts`) gains an optional 4th param `instanceFieldName?: string`; `window.tamper.monoResolvePlayerPointer` gains an optional 3rd param `instanceFieldName?: string` — Task 3 (UI) consumes both.

- [ ] **Step 1: Write the failing test**

In `tests/main/patchEngine.test.ts`, find the existing `FakeMonoOps` class (around line 1010):

```ts
class FakeMonoOps {
  monoDllBaseValue: string | null = '0x500000'
  methodAddress: string | null = '0x400100'
  pointerValue: string | null = null
  resolvePointerCalls: { className: string; fieldName: string }[] = []

  monoDllBase(): string | null {
    return this.monoDllBaseValue
  }
  async resolveClass(): Promise<string | null> {
    return '0xc9'
  }
  async compileMethod(): Promise<string | null> {
    return this.methodAddress
  }
  async resolvePointer(_base: string, className: string, fieldName: string): Promise<string | null> {
    this.resolvePointerCalls.push({ className, fieldName })
    return this.pointerValue
  }
}
```

Update `resolvePointerCalls`'s element type and the `resolvePointer` method signature to also capture the new param:

```ts
  resolvePointerCalls: { className: string; fieldName: string; instanceFieldName?: string }[] = []
```

```ts
  async resolvePointer(
    _base: string,
    className: string,
    fieldName: string,
    instanceFieldName?: string
  ): Promise<string | null> {
    this.resolvePointerCalls.push({ className, fieldName, instanceFieldName })
    return this.pointerValue
  }
```

Then add a new test in the `describe('PatchEngine — immune injection, Mono-anchored re-arming', ...)` block (around line 1031), right after the existing `monoImmunePatch` fixture and its `it('arms the freshly-resolved pointer, ...')` test:

```ts
  it('passes armPointerInstanceFieldName through to resolvePointer when set', async () => {
    ops.memory.set('0x400100', ORIGINAL)
    engine.setAnchorContext(new Map(), new Set())
    const monoOps = new FakeMonoOps()
    monoOps.pointerValue = '0x4000'
    engine.setMonoOps(monoOps as any)

    const patch: PatchCheat = { ...monoImmunePatch, armPointerInstanceFieldName: 'm_skills' }
    const result = await engine.apply(patch)

    expect(result.ok).toBe(true)
    expect(monoOps.resolvePointerCalls).toEqual([
      { className: 'Player', fieldName: 'm_localPlayer', instanceFieldName: 'm_skills' }
    ])
  })
```

This reuses `ops`/`engine` (the module-level fakes reset in the file's top-level `beforeEach`, already in scope for every `describe` block in this file) and the `monoImmunePatch`/`ORIGINAL` fixtures already defined above it in the same file — no new fixtures needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/patchEngine.test.ts`
Expected: FAIL — `armPointerInstanceFieldName` doesn't exist on `PatchCheat` yet (TypeScript compile error surfaces as a test failure).

- [ ] **Step 3: Add the field to `PatchCheat`**

In `src/main/store.ts`, immediately after the existing `armPointerFieldName?: string` line (in the `PatchCheat` interface):

```ts
  armPointerClassName?: string
  armPointerFieldName?: string
  // One more instance-field hop past armPointerFieldName's static field, for
  // an object reached THROUGH the player rather than the player object
  // itself — e.g. Skills:OnDeath's `this` is the player's Skills instance
  // (Player.m_localPlayer -> .m_skills), not the Player instance armValue
  // alone would resolve. Both fields must be declared on armPointerClassName
  // — see resolveMonoPointerChain's own comment for why. Absent means the
  // static field's own dereferenced value IS the arm pointer, exactly as
  // before this field existed.
  armPointerInstanceFieldName?: string
```

- [ ] **Step 4: Extend `MonoOps.resolvePointer`'s signature**

In `src/main/anchor.ts`, update the `MonoOps` interface's `resolvePointer` line:

```ts
  resolvePointer?(
    monoDllBase: string,
    className: string,
    fieldName: string,
    instanceFieldName?: string
  ): Promise<string | null>
```

- [ ] **Step 5: Pass the new field through in `patchEngine.ts`**

In `src/main/patchEngine.ts`, in the block that calls `this.monoOps.resolvePointer` (around line 373), add the 4th argument:

```ts
          const resolved = await this.monoOps.resolvePointer(
            monoDllBase,
            patch.armPointerClassName,
            patch.armPointerFieldName,
            patch.armPointerInstanceFieldName
          )
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/main/patchEngine.test.ts`
Expected: PASS.

- [ ] **Step 7: Wire the real resolver in `ipc.ts`**

In `src/main/ipc.ts`, replace the body of `resolveMonoPointer` (around line 125) — keep its exact exported signature but add the new param and delegate to Task 1's function instead of the hand-rolled steps it does today:

```ts
async function resolveMonoPointer(
  handle: number,
  base: string,
  className: string,
  fieldName: string,
  instanceFieldName?: string
): Promise<string | null> {
  return resolveMonoPointerChain(handle, base, className, fieldName, monoOps, instanceFieldName)
}
```

Add `resolveMonoPointerChain` to the existing `import { resolveMonoTargetAddress, MonoResolverOps } from './monoTargetResolve'` line (near the top of the file, line 23):

```ts
import { resolveMonoTargetAddress, resolveMonoPointerChain, MonoResolverOps } from './monoTargetResolve'
```

Then update the two call sites that already call `resolveMonoPointer` to pass the new param through:

In `monoPatchOps` (around line 332):

```ts
  resolvePointer: (base, cls, field, instanceField) =>
    attachedHandle === null
      ? Promise.resolve(null)
      : resolveMonoPointer(attachedHandle, base, cls, field, instanceField)
```

In the `mono:resolvePlayerPointer` IPC handler (around line 756):

```ts
  ipcMain.handle(
    'mono:resolvePlayerPointer',
    async (
      _e,
      className: string,
      fieldName: string,
      instanceFieldName?: string
    ): Promise<string | null> => {
      if (attachedHandle === null) return null
      const base = monoDllBase()
      if (base === null) return null
      return resolveMonoPointer(attachedHandle, base, className, fieldName, instanceFieldName)
    }
  )
```

- [ ] **Step 8: Extend preload and the renderer type declaration**

In `src/preload/index.ts`, update `monoResolvePlayerPointer`:

```ts
  monoResolvePlayerPointer: (className: string, fieldName: string, instanceFieldName?: string) =>
    ipcRenderer.invoke('mono:resolvePlayerPointer', className, fieldName, instanceFieldName),
```

In `src/renderer/src/tamper.d.ts`, update the `monoResolvePlayerPointer` declaration (around line 99) and its comment:

```ts
      // Resolves a live object pointer from a named class's static field —
      // e.g. ('Player', 'm_localPlayer') — for an immune patch's armValue.
      // With instanceFieldName set, follows one more instance field on that
      // SAME class to a second object (Player.m_localPlayer -> .m_skills),
      // for an armValue that isn't the player itself but something the
      // player owns. Null if the runtime isn't attached, either field isn't
      // found, or either hop's pointer hasn't been set yet this session.
      monoResolvePlayerPointer: (
        className: string,
        fieldName: string,
        instanceFieldName?: string
      ) => Promise<string | null>
```

- [ ] **Step 9: Run the full test suite to check nothing else broke**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/main/store.ts src/main/anchor.ts src/main/patchEngine.ts src/main/ipc.ts src/preload/index.ts src/renderer/src/tamper.d.ts tests/main/patchEngine.test.ts
git commit -m "Wire one-hop instance-field arming through patch engine and IPC

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WTRkUftV3WSHjj2Gd1gN95"
```

---

### Task 3: Immune mini-form UI for the instance-field arm hop

**Files:**
- Modify: `src/renderer/src/screens/CheatList.tsx`

**Interfaces:**
- Consumes: `window.tamper.monoResolvePlayerPointer(className, fieldName, instanceFieldName?)` from Task 2.
- Produces: nothing consumed elsewhere — this is the leaf UI.

- [ ] **Step 1: Add state**

Near the existing `monoAnchorPlayerField` state (around line 193), add:

```ts
  const [monoAnchorUseInstanceField, setMonoAnchorUseInstanceField] = useState(false)
  const [monoAnchorPlayerInstanceField, setMonoAnchorPlayerInstanceField] = useState('')
```

- [ ] **Step 2: Thread the new field through `resolveMonoAnchorArmValue`**

In the existing `resolveMonoAnchorArmValue` function (around line 256), change the call to pass the instance field when the checkbox is on, and make the failure message name both hops — `resolveMonoPointerChain` always returns a plain `null` on any failure (matching every other resolver in this codebase — see Task 1's comment on why), so the UI is the only place that can say anything more specific than "didn't work," by naming what it asked for rather than what actually failed inside:

```ts
      const instanceField = monoAnchorUseInstanceField ? monoAnchorPlayerInstanceField.trim() : undefined
      const pointer = await window.tamper.monoResolvePlayerPointer(
        monoAnchorPlayerClass,
        monoAnchorPlayerField,
        instanceField
      )
      if (pointer === null) {
        setMonoAnchorArmValue(null)
        setMonoAnchorArmError(
          instanceField
            ? `Could not resolve ${monoAnchorPlayerClass}.${monoAnchorPlayerField} -> .${instanceField} — either the runtime isn't attached yet, ${monoAnchorPlayerClass} has no static field ${monoAnchorPlayerField} or no instance field ${instanceField}, or the local player hasn't loaded this session.`
            : `Could not resolve ${monoAnchorPlayerClass}.${monoAnchorPlayerField} — is the runtime attached and has a local player loaded yet?`
        )
        return
      }
      setMonoAnchorArmValue(pointer)
```

This replaces the existing `if (pointer === null) { ... }` block in that function — the two-branch message above takes over where the current single-message block used to be, and the existing `try`/`finally` wrapping stays as-is.

- [ ] **Step 3: Thread it through `saveMonoAnchorPatch`**

In `saveMonoAnchorPatch` (around line 662), inside the existing `mode === 'immune'` spread, add the new field:

```ts
        ? {
            baseRegister: monoAnchorBaseRegister.trim().toLowerCase(),
            armValue: monoAnchorArmValue as string,
            armPointerClassName: monoAnchorPlayerClass.trim(),
            armPointerFieldName: monoAnchorPlayerField.trim(),
            ...(monoAnchorUseInstanceField && monoAnchorPlayerInstanceField.trim()
              ? { armPointerInstanceFieldName: monoAnchorPlayerInstanceField.trim() }
              : {})
          }
        : {})
```

- [ ] **Step 4: Reset the new state alongside the rest on save**

In the same function, immediately after the existing `setMonoAnchorArmError(null)` reset line (around line 685):

```ts
    setMonoAnchorUseInstanceField(false)
    setMonoAnchorPlayerInstanceField('')
```

- [ ] **Step 5: Add the checkbox and input to the JSX**

In the immune-mode block (around line 846-889), immediately after the existing "Static field, e.g. m_localPlayer" input and before the "Resolve player pointer" button, insert:

```tsx
              <label style={{ flexBasis: '100%' }}>
                <input
                  type="checkbox"
                  checked={monoAnchorUseInstanceField}
                  onChange={(e) => {
                    setMonoAnchorUseInstanceField(e.target.checked)
                    setMonoAnchorArmValue(null)
                  }}
                />{' '}
                Reached through an instance field on that object (e.g. the local player&apos;s own
                Skills, not the player itself)
              </label>
              {monoAnchorUseInstanceField && (
                <input
                  placeholder="Instance field on that same class, e.g. m_skills"
                  value={monoAnchorPlayerInstanceField}
                  onChange={(e) => {
                    setMonoAnchorPlayerInstanceField(e.target.value)
                    setMonoAnchorArmValue(null)
                  }}
                />
              )}
```

Then update the "Resolve player pointer" button's `disabled` condition immediately below to also require the instance field when the checkbox is on:

```tsx
              <button
                onClick={resolveMonoAnchorArmValue}
                disabled={
                  !monoAnchorPlayerClass ||
                  !monoAnchorPlayerField ||
                  (monoAnchorUseInstanceField && !monoAnchorPlayerInstanceField.trim()) ||
                  monoAnchorResolvingArm
                }
              >
```

- [ ] **Step 6: Manual check — TypeScript compiles and the app builds**

Run: `npx tsc --noEmit` (this repo's `package.json` has no dedicated typecheck script; `tsconfig.json` already exists at the repo root)
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/screens/CheatList.tsx
git commit -m "Add instance-field arm hop to the immune anchor mini-form

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WTRkUftV3WSHjj2Gd1gN95"
```

---

### Task 4: Live-value resolver (`resolveMonoLiveValue`)

**Files:**
- Modify: `src/main/monoTargetResolve.ts`
- Test: `tests/main/monoTarget.test.ts`

**Interfaces:**
- Consumes: `resolveMonoTargetAddress` (already in this file).
- Produces: `MonoLiveValue { raw: string; int32: number; float: number }`; `resolveMonoLiveValue(target: MonoTarget, handle: number, monoDllBase: string, ops: MonoResolverOps): Promise<MonoLiveValue | null>` — Task 5 consumes both.

- [ ] **Step 1: Write the failing tests**

Add to `tests/main/monoTarget.test.ts`:

```ts
import { resolveMonoTargetAddress, resolveMonoPointerChain, resolveMonoLiveValue, MonoResolverOps } from '../../src/main/monoTargetResolve'
```

(add `resolveMonoLiveValue` to the import line)

```ts
describe('resolveMonoLiveValue', () => {
  it('reads and decodes the 4 bytes at a static field as both int32 and float', async () => {
    const ops = new FakeResolver()
    ops.classes.set('GameSettings', '0xc1')
    ops.staticAddresses.set('0xc1.m_difficulty', '0x9000')
    ops.memory.set('0x9000', '05000000') // int32 5, little-endian

    const value = await resolveMonoLiveValue(staticOnlyTarget, 1, '0x400000', ops)
    expect(value?.raw).toBe('05000000')
    expect(value?.int32).toBe(5)
  })

  it('reads through an instance field the same way resolveMonoTargetAddress does', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.staticAddresses.set('0xc2.m_godMode', '1681')
    ops.memory.set('0x9100', '5030000000000000')
    ops.memory.set('0x' + (0x3050 + 1681).toString(16), '01000000')

    const value = await resolveMonoLiveValue(godModeTarget, 1, '0x400000', ops)
    expect(value?.int32).toBe(1)
  })

  it('returns null when the address does not resolve', async () => {
    const ops = new FakeResolver()
    const value = await resolveMonoLiveValue(staticOnlyTarget, 1, '0x400000', ops)
    expect(value).toBeNull()
  })
})
```

(this reuses the existing `staticOnlyTarget` and `godModeTarget` fixtures already defined near the top of this test file)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/main/monoTarget.test.ts`
Expected: FAIL — `resolveMonoLiveValue` is not exported yet.

- [ ] **Step 3: Implement `resolveMonoLiveValue`**

Append to `src/main/monoTargetResolve.ts`:

```ts
export interface MonoLiveValue {
  raw: string
  int32: number
  float: number
}

// Reads whatever is currently stored at a MonoTarget's live address, decoded
// two ways since Mono Explorer doesn't know a field's real type ahead of
// time — the user recognizes which decoding looks right by watching it
// change while playing (e.g. a stamina float sitting near 25.0, or a byte
// flag reading 0/1 in the int32 view). Returns null on any resolution
// failure, matching every other resolver in this file.
export async function resolveMonoLiveValue(
  target: MonoTarget,
  handle: number,
  monoDllBase: string,
  ops: MonoResolverOps
): Promise<MonoLiveValue | null> {
  const address = await resolveMonoTargetAddress(target, handle, monoDllBase, ops)
  if (address === null) return null

  const raw = ops.readBytes(address, 4)
  if (raw === null) return null

  const buf = Buffer.from(raw, 'hex')
  return { raw, int32: buf.readInt32LE(0), float: buf.readFloatLE(0) }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/main/monoTarget.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/monoTargetResolve.ts tests/main/monoTarget.test.ts
git commit -m "Add live-value resolver for Mono Explorer field watching

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WTRkUftV3WSHjj2Gd1gN95"
```

---

### Task 5: Wire live-value reading through IPC, preload, and the type declaration

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/tamper.d.ts`

**Interfaces:**
- Consumes: `resolveMonoLiveValue`, `MonoLiveValue` from Task 4.
- Produces: `window.tamper.monoReadLiveValue(className, staticFieldName, instanceFieldName?)` — Task 7 consumes this.

- [ ] **Step 1: Add the IPC handler**

In `src/main/ipc.ts`, update the import from `monoTargetResolve` (same line touched in Task 2, Step 7) to also bring in the new function and type:

```ts
import { resolveMonoTargetAddress, resolveMonoPointerChain, resolveMonoLiveValue, MonoLiveValue, MonoResolverOps } from './monoTargetResolve'
```

Then add a new handler near `mono:resolvePlayerPointer` (in the same `registerIpcHandlers`-style block, whatever it's actually called in this file — place it directly after the `mono:resolvePlayerPointer` handler added/touched in Task 2):

```ts
  ipcMain.handle(
    'mono:readLiveValue',
    async (
      _e,
      className: string,
      staticFieldName: string,
      instanceFieldName?: string
    ): Promise<MonoLiveValue | null> => {
      if (attachedHandle === null) return null
      const base = monoDllBase()
      if (base === null) return null
      const target: MonoTarget = instanceFieldName
        ? { kind: 'mono', className, staticFieldName, instanceFieldName }
        : { kind: 'mono', className, staticFieldName }
      return resolveMonoLiveValue(target, attachedHandle, base, monoOps)
    }
  )
```

`MonoTarget` is already imported from `./store` at the top of `ipc.ts` (used by `resolveMonoTarget`/`writeCheat`) — no import change needed for it.

- [ ] **Step 2: Add the preload bridge**

In `src/preload/index.ts`, immediately after the existing `monoResolveMethodBytes` line:

```ts
  monoReadLiveValue: (className: string, staticFieldName: string, instanceFieldName?: string) =>
    ipcRenderer.invoke('mono:readLiveValue', className, staticFieldName, instanceFieldName),
```

- [ ] **Step 3: Add the type declaration**

In `src/renderer/src/tamper.d.ts`, immediately after the `monoResolveMethodBytes` declaration (around line 121):

```ts
      // Reads the CURRENT value at a Mono-resolved field, decoded as both
      // int32 and float (Explorer doesn't know the field's real type ahead
      // of time) — for watching a field change live while playing, to
      // recognize which one it is. Same static/instance-field shape as a
      // MonoTarget value cheat (see store.ts's MonoTarget). Null if the
      // runtime isn't attached or either field doesn't resolve.
      monoReadLiveValue: (
        className: string,
        staticFieldName: string,
        instanceFieldName?: string
      ) => Promise<{ raw: string; int32: number; float: number } | null>
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts src/renderer/src/tamper.d.ts
git commit -m "Expose live Mono field reading over IPC

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WTRkUftV3WSHjj2Gd1gN95"
```

---

### Task 6: Pure search-index filter (`filterSearchIndex`)

**Files:**
- Create: `src/renderer/src/monoSearchIndex.ts`
- Test: `tests/renderer/monoSearchIndex.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SearchIndexEntry { namespaceName: string; className: string; kind: 'field' | 'method'; name: string }`; `filterSearchIndex(index: SearchIndexEntry[], query: string): SearchIndexEntry[]` — Task 7 consumes both.

- [ ] **Step 1: Write the failing test**

Check whether `tests/renderer/` exists yet (`ls tests/`); if not, this is the first file in it — create the directory as part of writing the file.

Create `tests/renderer/monoSearchIndex.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { filterSearchIndex, SearchIndexEntry } from '../../src/renderer/src/monoSearchIndex'

const fixture: SearchIndexEntry[] = [
  { namespaceName: '', className: 'Player', kind: 'field', name: 'm_ghostMode' },
  { namespaceName: '', className: 'Player', kind: 'field', name: 'm_maxCarryWeight' },
  { namespaceName: '', className: 'Character', kind: 'method', name: 'ApplyDamage' },
  { namespaceName: '', className: 'Skills', kind: 'method', name: 'Raise' }
]

describe('filterSearchIndex', () => {
  it('matches a substring case-insensitively across every class', () => {
    const result = filterSearchIndex(fixture, 'ghost')
    expect(result).toEqual([fixture[0]])
  })

  it('matches multiple entries across different classes', () => {
    const result = filterSearchIndex(fixture, 'a')
    expect(result.map((e) => e.name)).toEqual([
      'm_maxCarryWeight',
      'ApplyDamage',
      'Raise'
    ])
  })

  it('returns an empty array for an empty query rather than the whole index', () => {
    expect(filterSearchIndex(fixture, '')).toEqual([])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterSearchIndex(fixture, 'zzz')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/monoSearchIndex.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement it**

Create `src/renderer/src/monoSearchIndex.ts`:

```ts
// One row per field or method, built once per assembly by MonoExplorer (see
// buildSearchIndex there) so a name can be found across every class in that
// assembly instead of browsing one class at a time.
export interface SearchIndexEntry {
  namespaceName: string
  className: string
  kind: 'field' | 'method'
  name: string
}

// Empty query returns nothing rather than the whole index — an unfiltered
// dump of every field/method in a real game assembly is thousands of rows,
// not a useful "no query yet" state to render.
export function filterSearchIndex(index: SearchIndexEntry[], query: string): SearchIndexEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  return index.filter((entry) => entry.name.toLowerCase().includes(q))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/monoSearchIndex.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/monoSearchIndex.ts tests/renderer/monoSearchIndex.test.ts
git commit -m "Add pure cross-class field/method search filter for Mono Explorer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WTRkUftV3WSHjj2Gd1gN95"
```

`vitest.config.ts` sets no `test.include` override, so Vitest's default glob (`**/*.{test,spec}.ts` outside `node_modules`) already picks up a new `tests/renderer/` directory with no config change needed.

---

### Task 7: Mono Explorer UI — search box and live-value watch

**Files:**
- Modify: `src/renderer/src/screens/MonoExplorer.tsx`

**Interfaces:**
- Consumes: `filterSearchIndex`, `SearchIndexEntry` from Task 6; `window.tamper.monoReadLiveValue` from Task 5; `window.tamper.monoListFields`/`monoListMethods`/`monoResolveClass` (already used elsewhere in this file).
- Produces: nothing consumed elsewhere — leaf UI.

- [ ] **Step 1: Import the new module and add state**

At the top of `src/renderer/src/screens/MonoExplorer.tsx`:

```ts
import { filterSearchIndex, SearchIndexEntry } from '../monoSearchIndex'
```

Near the existing `classFilter`/`browseError` state (around line 32-34), add:

```ts
  const [searchIndex, setSearchIndex] = useState<SearchIndexEntry[]>([])
  const [indexing, setIndexing] = useState(false)
  const [indexProgress, setIndexProgress] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  const [watchedField, setWatchedField] = useState<string | null>(null)
  const [watchHolderClass, setWatchHolderClass] = useState('')
  const [watchHolderField, setWatchHolderField] = useState('m_localPlayer')
  const [liveValue, setLiveValue] = useState<{ raw: string; int32: number; float: number } | null>(null)
```

- [ ] **Step 2: Build the search index, one class at a time**

Add this function alongside `pickAssembly`/`pickClass`:

```ts
  // Walks every class in the currently picked assembly, resolving each one
  // and recording its field/method names — sequential, not Promise.all, so
  // a large assembly (Assembly-CSharp can have hundreds of classes) doesn't
  // fire hundreds of concurrent native round-trips against a live process
  // at once; indexProgress keeps this from looking hung on a big assembly.
  // A class that fails to resolve (unlikely, since `classes` itself came
  // from live metadata) is skipped rather than aborting the whole index.
  async function buildSearchIndex() {
    if (selectedImage === null) return
    setIndexing(true)
    setIndexProgress('')
    const entries: SearchIndexEntry[] = []
    for (let i = 0; i < classes.length; i++) {
      const c = classes[i]
      setIndexProgress(`${i + 1}/${classes.length}`)
      const handle = await window.tamper.monoResolveClass(c.namespaceName, c.className)
      if (handle === null) continue
      const [classFields, classMethods] = await Promise.all([
        window.tamper.monoListFields(handle),
        window.tamper.monoListMethods(handle)
      ])
      for (const f of classFields) {
        entries.push({ namespaceName: c.namespaceName, className: c.className, kind: 'field', name: f })
      }
      for (const m of classMethods) {
        entries.push({ namespaceName: c.namespaceName, className: c.className, kind: 'method', name: m })
      }
    }
    setSearchIndex(entries)
    setIndexing(false)
    setIndexProgress('')
  }

  const searchResults = filterSearchIndex(searchIndex, searchQuery)

  // Jumps straight to a search hit: resolves its class (same as clicking it
  // in the class list would) and pre-fills the matching field/method filter
  // below so the exact hit surfaces first in that already-existing list,
  // reusing the existing "Use as value target"/"Use as patch anchor"
  // buttons rather than duplicating them here.
  function pickSearchResult(entry: SearchIndexEntry) {
    pickClass(entry.namespaceName, entry.className)
    if (entry.kind === 'field') {
      setFieldFilter(entry.name)
    } else {
      setMethodFilter(entry.name)
    }
  }
```

- [ ] **Step 3: Render the search box**

In the JSX, immediately after the existing "Browse" `<h3>` block's assembly list and before the "Filter classes…" input (i.e. once `selectedImage` is set), add:

```tsx
      {selectedImage && (
        <>
          <h3>Search this assembly</h3>
          <button onClick={buildSearchIndex} disabled={indexing}>
            {indexing
              ? `Indexing… ${indexProgress}`
              : searchIndex.length > 0
                ? 'Rebuild index'
                : 'Build search index'}
          </button>
          {searchIndex.length > 0 && (
            <>
              <input
                placeholder="Search field/method names across every class…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <ul style={{ maxHeight: 200, overflowY: 'auto' }}>
                {searchResults.map((entry, i) => (
                  <li key={`${entry.className}-${entry.kind}-${entry.name}-${i}`}>
                    <button onClick={() => pickSearchResult(entry)}>
                      {entry.namespaceName ? `${entry.namespaceName}.` : ''}
                      {entry.className}.{entry.name}
                      {entry.kind === 'method' ? '()' : ''}
                    </button>
                  </li>
                ))}
                {searchQuery.trim() !== '' && searchResults.length === 0 && (
                  <li className="muted">No matches for &quot;{searchQuery}&quot;.</li>
                )}
              </ul>
            </>
          )}
        </>
      )}
```

- [ ] **Step 4: Add a live-value watch effect**

Alongside the component's other logic (before the `return`), add:

```ts
  useEffect(() => {
    if (watchedField === null) return
    let cancelled = false

    async function poll() {
      const result = await window.tamper.monoReadLiveValue(
        watchHolderClass.trim(),
        watchHolderField.trim(),
        watchedField ?? undefined
      )
      if (!cancelled) setLiveValue(result)
    }

    poll()
    const timer = setInterval(poll, 500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [watchedField, watchHolderClass, watchHolderField])
```

Make sure `useEffect` is imported from `'react'` at the top of the file — the existing `import { useState } from 'react'` line needs `useEffect` added to it:

```ts
import { useEffect, useState } from 'react'
```

- [ ] **Step 5: Add a "Watch" button per field row and the value panel**

In the existing fields list (around line 186-191), change the field `<li>` to add a Watch button alongside "Use as value target":

```tsx
            {visibleFields.map((f, i) => (
              <li key={`${f}-${i}`}>
                {f}
                <button onClick={() => onUseAsValueTarget(className, f)}>Use as value target</button>
                <button
                  onClick={() => {
                    setWatchedField(f)
                    setWatchHolderClass(className)
                    setLiveValue(null)
                  }}
                >
                  Watch live value
                </button>
              </li>
            ))}
```

Then, right after the fields `<ul>` closes (before the `<h3>Methods…` heading), add the watch panel:

```tsx
          {watchedField && (
            <div className="banner" style={{ flexWrap: 'wrap' }}>
              <p style={{ flexBasis: '100%' }}>
                Watching <code>{watchHolderClass}.{watchHolderField}</code> → <code>{watchedField}</code>.
                If this field isn&apos;t reached through an object (it&apos;s itself static), set the
                holder field below to the same name so it dereferences to itself — most fields worth
                watching belong to an object, so this defaults to the common case.
              </p>
              <input
                placeholder="Holder class, e.g. Player"
                value={watchHolderClass}
                onChange={(e) => setWatchHolderClass(e.target.value)}
              />
              <input
                placeholder="Holder's static field, e.g. m_localPlayer"
                value={watchHolderField}
                onChange={(e) => setWatchHolderField(e.target.value)}
              />
              {liveValue ? (
                <p style={{ flexBasis: '100%' }}>
                  int32: <strong>{liveValue.int32}</strong> · float: <strong>{liveValue.float}</strong> ·
                  raw: <code>{liveValue.raw}</code>
                </p>
              ) : (
                <p style={{ flexBasis: '100%' }} className="muted">
                  Not resolving yet — check the holder class/field above.
                </p>
              )}
              <button onClick={() => setWatchedField(null)}>Stop watching</button>
            </div>
          )}
```

- [ ] **Step 6: Manual check — TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/screens/MonoExplorer.tsx
git commit -m "Add cross-class search and live-value watching to Mono Explorer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WTRkUftV3WSHjj2Gd1gN95"
```

---

### Task 8: Manual verification against the running game

**Files:** none (verification only — may produce a follow-up edit to `games/valheim.json`, done by hand through the UI, not by this task writing JSON directly).

- [ ] **Step 1: Build and launch the app**

Run whatever this repo's dev/build script is (check `package.json`'s `scripts` — likely `npm run dev` or similar) and attach to a running Valheim process.

- [ ] **Step 2: Verify search + live value**

Open Mono Explorer → load assemblies → pick the game's main assembly → Build search index → search "ghostMode" → confirm it finds `Player.m_ghostMode` → click it → click Watch live value on that row → confirm a live int32/float readout appears and changes when toggling ghost mode manually via a value-target cheat.

- [ ] **Step 3: Verify the one-hop arm chain end-to-end**

Mono Explorer → resolve class `Character` → find method `ApplyDamage` (or search for it) → Use as patch anchor → set mode to `immune` → check "Reached through an instance field on that object" is available (even though this specific cheat doesn't need it, confirms the control renders) → separately, resolve class `Skills` → find method `OnDeath` → Use as patch anchor → immune mode → Player class `Player`, static field `m_localPlayer`, check the instance-field box, instance field `m_skills` → Resolve player pointer → confirm it resolves to a real address (not an error) → Save → toggle the cheat on in-game → die → confirm no skill loss.

- [ ] **Step 4: If Step 3 works, note it — no code change needed**

The cheat now exists as a saved patch in this game's profile (`games/valheim.json`), created entirely through the UI — this is the capability the whole plan exists to prove out. No manual JSON edit needed; if the verification step reveals the profile file changed, that's the app doing its job, not a task deliverable to review as code.

- [ ] **Step 5: Report results**

Summarize what worked and what didn't (e.g. "search index took N seconds for M classes", "instance-field arm resolved and OnDeath skip worked", or any friction found) — this is the acceptance check for the whole plan, not a commit.
