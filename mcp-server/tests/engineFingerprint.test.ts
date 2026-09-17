import { describe, it, expect } from 'vitest'
import { classifyEngine } from '../src/engineFingerprint'
import type { ModuleInfo } from '../src/addon'

function mod(name: string, base: string): ModuleInfo {
  return { name, base, size: 0x1000, timestamp: 0, version: null }
}

describe('classifyEngine', () => {
  it('detects Unity/Mono via mono.dll', () => {
    const result = classifyEngine([mod('game.exe', '0x1000'), mod('mono.dll', '0x2000')])
    expect(result).toEqual({ engine: 'unity-mono', confidence: 'high', monoDllBase: '0x2000' })
  })

  it('detects Unity/Mono via mono-2.0-bdwgc.dll, case-insensitively', () => {
    const result = classifyEngine([mod('game.exe', '0x1000'), mod('MONO-2.0-BDWGC.DLL', '0x3000')])
    expect(result).toEqual({ engine: 'unity-mono', confidence: 'high', monoDllBase: '0x3000' })
  })

  it('detects Unity/IL2CPP via GameAssembly.dll when no mono module is present', () => {
    const result = classifyEngine([mod('game.exe', '0x1000'), mod('GameAssembly.dll', '0x4000')])
    expect(result).toEqual({ engine: 'unity-il2cpp', confidence: 'high', gameAssemblyBase: '0x4000' })
  })

  it('prefers Mono over IL2CPP if both modules are somehow present', () => {
    const result = classifyEngine([
      mod('game.exe', '0x1000'),
      mod('GameAssembly.dll', '0x4000'),
      mod('mono.dll', '0x2000')
    ])
    expect(result.engine).toBe('unity-mono')
  })

  it('detects Unreal via *-Win64-Shipping.exe filename convention', () => {
    const result = classifyEngine([mod('Palworld-Win64-Shipping.exe', '0x5000'), mod('ntdll.dll', '0x9000')])
    expect(result).toEqual({ engine: 'unreal', confidence: 'heuristic', exeBase: '0x5000' })
  })

  it('matches the Unreal filename convention case-insensitively', () => {
    const result = classifyEngine([mod('SomeGame-WIN64-SHIPPING.EXE', '0x5000')])
    expect(result.engine).toBe('unreal')
  })

  it('falls back to native-unknown when nothing matches', () => {
    const modules = [mod('game.exe', '0x1000'), mod('kernel32.dll', '0x7000'), mod('ntdll.dll', '0x9000')]
    const result = classifyEngine(modules)
    expect(result).toEqual({
      engine: 'native-unknown',
      confidence: 'low',
      mainModuleBase: '0x1000',
      moduleCount: 3
    })
  })
})
