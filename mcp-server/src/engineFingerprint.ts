import type { ModuleInfo } from './addon'

export type EngineClassification =
  | { engine: 'unity-mono'; confidence: 'high'; monoDllBase: string }
  | { engine: 'unity-il2cpp'; confidence: 'high'; gameAssemblyBase: string }
  | { engine: 'unreal'; confidence: 'heuristic'; exeBase: string }
  | { engine: 'native-unknown'; confidence: 'low'; mainModuleBase: string; moduleCount: number }

const MONO_NAMES = new Set(['mono.dll', 'mono-2.0-bdwgc.dll'])

export function classifyEngine(modules: ModuleInfo[]): EngineClassification {
  const monoModule = modules.find((m) => MONO_NAMES.has(m.name.toLowerCase()))
  if (monoModule) return { engine: 'unity-mono', confidence: 'high', monoDllBase: monoModule.base }

  const gameAssemblyModule = modules.find((m) => m.name.toLowerCase() === 'gameassembly.dll')
  if (gameAssemblyModule) {
    return { engine: 'unity-il2cpp', confidence: 'high', gameAssemblyBase: gameAssemblyModule.base }
  }

  const unrealModule = modules.find((m) => m.name.toLowerCase().endsWith('-win64-shipping.exe'))
  if (unrealModule) return { engine: 'unreal', confidence: 'heuristic', exeBase: unrealModule.base }

  return {
    engine: 'native-unknown',
    confidence: 'low',
    mainModuleBase: modules[0].base,
    moduleCount: modules.length
  }
}
