import type { MonoTarget } from './store'
import { littleEndianToBigInt } from './ipc'
import { slotHexToPointer } from './patchEngine'

export interface MonoResolverOps {
  resolveClass(handle: number, monoDllBase: string, namespaceName: string, className: string): Promise<string | null>
  resolveField(handle: number, monoDllBase: string, classHandle: string, fieldName: string): Promise<{ offset: number } | null>
  staticFieldAddress(handle: number, monoDllBase: string, classHandle: string, fieldName: string): Promise<string | null>
  readBytes(address: string, length: number): string | null
}

function addHex(address: string, delta: bigint): string {
  return '0x' + (BigInt(address) + delta).toString(16)
}

// Resolves a MonoTarget to a live address: find the class, find the static
// field, and either use its own storage address directly (no
// instanceFieldName) or dereference it to an object pointer and add the
// instance field's offset — the [LocalPlayer]+Player.m_godMode shape.
// Every failure mode returns null rather than throwing, matching the
// codebase's "can't resolve right now" convention.
export async function resolveMonoTargetAddress(
  target: MonoTarget,
  handle: number,
  monoDllBase: string,
  ops: MonoResolverOps
): Promise<string | null> {
  const classHandle = await ops.resolveClass(handle, monoDllBase, '', target.className)
  if (classHandle === null) return null

  const staticAddress = await ops.staticFieldAddress(handle, monoDllBase, classHandle, target.staticFieldName)
  if (staticAddress === null) return null

  if (target.instanceFieldName === undefined) return staticAddress

  const field = await ops.resolveField(handle, monoDllBase, classHandle, target.instanceFieldName)
  if (field === null) return null

  const pointerHex = ops.readBytes(staticAddress, 8)
  if (pointerHex === null) return null
  const objectPointer = littleEndianToBigInt(pointerHex)
  if (objectPointer === 0n) return null // the game hasn't set this yet this session

  return addHex('0x' + objectPointer.toString(16), BigInt(field.offset))
}

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
