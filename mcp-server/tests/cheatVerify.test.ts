import { describe, it, expect } from 'vitest'
import {
  resolveMonoTargetAddress,
  valueMatches,
  extractBit,
  buildTargetStatus,
  unsupportedAnchorStatus,
  type MonoResolveOps,
  type MonoTarget,
  type ChainTarget
} from '../src/cheatVerify'

describe('valueMatches', () => {
  it('matches floats within 1.0 tolerance', () => {
    expect(valueMatches(99.5, 100, 'float')).toBe(true)
    expect(valueMatches(98.9, 100, 'float')).toBe(false)
  })
  it('matches ints exactly', () => {
    expect(valueMatches(100, 100, 'int32')).toBe(true)
    expect(valueMatches(99, 100, 'int32')).toBe(false)
  })
})

describe('extractBit', () => {
  it('returns the raw value when bitIndex is undefined', () => {
    expect(extractBit(5, undefined)).toBe(5)
  })
  it('extracts a single bit when bitIndex is set', () => {
    expect(extractBit(0b0110, 1)).toBe(1)
    expect(extractBit(0b0110, 0)).toBe(0)
  })
})

describe('resolveMonoTargetAddress', () => {
  function ops(overrides: Partial<MonoResolveOps> = {}): MonoResolveOps {
    return {
      resolveClass: async () => '0xc1a55',
      resolveField: async () => ({ offset: 0x10 }),
      staticFieldAddress: async () => '0xf1e1d0',
      readBytes: () => '0000000000000000',
      ...overrides
    }
  }

  it('resolves a plain static field with no instance hop', async () => {
    const target: MonoTarget = { kind: 'mono', className: 'Player', staticFieldName: 'm_godMode' }
    const address = await resolveMonoTargetAddress(target, 1, '0x1000', ops())
    expect(address).toBe('0xf1e1d0')
  })

  it('returns null when the class does not resolve', async () => {
    const target: MonoTarget = { kind: 'mono', className: 'Nope', staticFieldName: 'x' }
    const address = await resolveMonoTargetAddress(target, 1, '0x1000', ops({ resolveClass: async () => null }))
    expect(address).toBeNull()
  })

  it('dereferences the static field and adds the instance field offset when instanceFieldName is set', async () => {
    const pointerHex = '0020000000000000'
    const target: MonoTarget = {
      kind: 'mono',
      className: 'Player',
      staticFieldName: 'm_localPlayer',
      instanceFieldName: 'm_health'
    }
    const address = await resolveMonoTargetAddress(
      target,
      1,
      '0x1000',
      ops({ readBytes: () => pointerHex, resolveField: async () => ({ offset: 0x18 }) })
    )
    expect(address).toBe('0x2018')
  })

  it('returns null when the dereferenced pointer is zero (not touched this session)', async () => {
    const target: MonoTarget = {
      kind: 'mono',
      className: 'Player',
      staticFieldName: 'm_localPlayer',
      instanceFieldName: 'm_health'
    }
    const address = await resolveMonoTargetAddress(
      target,
      1,
      '0x1000',
      ops({ readBytes: () => '0000000000000000' })
    )
    expect(address).toBeNull()
  })
})

describe('buildTargetStatus', () => {
  const chainTarget: ChainTarget = { moduleName: 'game.exe', baseOffset: '0x100', offsets: [] }

  it('reports unresolved when the address is null', () => {
    const status = buildTargetStatus(null, () => 5, chainTarget, 100, 'int32')
    expect(status).toEqual({ supported: true, alive: false, value: null, expected: null, matches: null })
  })

  it('reports a matching value', () => {
    const status = buildTargetStatus('0x2000', () => 100, chainTarget, 100, 'int32')
    expect(status).toEqual({ supported: true, alive: true, value: 100, expected: 100, matches: true })
  })

  it('reports a non-matching value', () => {
    const status = buildTargetStatus('0x2000', () => 5, chainTarget, 100, 'int32')
    expect(status).toEqual({ supported: true, alive: true, value: 5, expected: 100, matches: false })
  })

  it("prefers the target's own value/dataType override over the cheat's", () => {
    const overriddenTarget: ChainTarget = { ...chainTarget, value: 7, dataType: 'int8' }
    const status = buildTargetStatus('0x2000', () => 7, overriddenTarget, 100, 'int32')
    expect(status.expected).toBe(7)
    expect(status.matches).toBe(true)
  })
})

describe('unsupportedAnchorStatus', () => {
  it('always reports unsupported with the fixed reason', () => {
    expect(unsupportedAnchorStatus()).toEqual({
      supported: false,
      alive: null,
      value: null,
      expected: null,
      matches: null,
      reason:
        'anchor targets require a capture patch installed by the running app; not resolvable from a static profile read-only'
    })
  })
})
