import { describe, it, expect } from 'vitest'
import { findClassTable, type BootstrapOps } from '../src/factory/il2cppBootstrap'
import { FakeMemory } from './helpers/fakeIl2cpp'

const CLASS0 = 0x1d4b2bef730n
const CLASS1 = 0x1d4b276f840n
const CLASS2 = 0x1d4b27cf8d0n
const TABLE = 0x1d4b0326f70n

function opsWith(overrides: Partial<BootstrapOps> = {}, count = 3): { ops: BootstrapOps; calls: string[] } {
  const mem = new FakeMemory()
  // The real table plus a decoy: a self-reference of class 0 with the wrong neighbour.
  mem.qword(TABLE, CLASS0)
  mem.qword(TABLE + 8n, CLASS1)
  mem.qword(TABLE + 16n, CLASS2)
  mem.qword(0x1d4b2bef770n, CLASS0)
  mem.qword(0x1d4b2bef778n, CLASS0)
  const calls: string[] = []
  const ops: BootstrapOps = {
    call: async (fn, args) => {
      calls.push(`${fn}(${args.join(',')})`)
      switch (fn) {
        case 'domain_get':
          return '0x000001d4c3bb3fc0'
        case 'assembly_open':
          return '0x000001d4b02785c0'
        case 'assembly_get_image':
          return '0x000001d4b0256000'
        case 'image_class_count':
          return '0x' + count.toString(16)
        case 'image_get_class':
          return args[1] === '0x0' ? '0x' + CLASS0.toString(16) : '0x' + CLASS1.toString(16)
      }
    },
    writeString: () => '0x7fffeb9f0000',
    scanQword: async (value) => (value === CLASS0 ? ['0x1d4b2bef770', '0x1d4b2bef778', '0x1d4b0326f70'] : []),
    readBytes: mem.readBytes,
    ...overrides
  }
  return { ops, calls }
}

describe('findClassTable', () => {
  it('returns every class pointer from the table whose first two entries match', async () => {
    const { ops } = opsWith()
    expect(await findClassTable(ops)).toEqual(['0x1d4b2bef730', '0x1d4b276f840', '0x1d4b27cf8d0'])
  })

  it('makes exactly six remote calls, in order', async () => {
    const { ops, calls } = opsWith()
    await findClassTable(ops)
    expect(calls).toEqual([
      'domain_get()',
      'assembly_open(0x1d4c3bb3fc0,0x7fffeb9f0000)',
      'assembly_get_image(0x1d4b02785c0)',
      'image_class_count(0x1d4b0256000)',
      'image_get_class(0x1d4b0256000,0x0)',
      'image_get_class(0x1d4b0256000,0x1)'
    ])
  })

  it('names the failing step when a call returns null', async () => {
    const { ops } = opsWith({ call: async (fn) => (fn === 'domain_get' ? null : '0x1') })
    await expect(findClassTable(ops)).rejects.toThrow(/domain_get/)
  })

  it('treats a zero result as a failure', async () => {
    const { ops } = opsWith({ call: async (fn) => (fn === 'assembly_open' ? '0x0' : '0x1234') })
    await expect(findClassTable(ops)).rejects.toThrow(/assembly_open/)
  })

  it('rejects an implausible class count', async () => {
    await expect(findClassTable(opsWith({}, 0).ops)).rejects.toThrow(/class.count/)
    await expect(findClassTable(opsWith({}, 500000).ops)).rejects.toThrow(/class.count/)
  })

  it('fails clearly when no scan hit is followed by class 1', async () => {
    const { ops } = opsWith({ scanQword: async () => ['0x1d4b2bef770', '0x1d4b2bef778'] })
    await expect(findClassTable(ops)).rejects.toThrow(/class table/)
  })
})
