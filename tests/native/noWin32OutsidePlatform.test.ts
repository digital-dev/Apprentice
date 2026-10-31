import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Guard: OS-specific headers and Win32/ptrace identifiers may only appear in
// native/src/platform/platform_win32.cc. Everything else goes through
// platform.h. Comments and string/char literals are stripped first so prose
// and JS-visible error strings do not trip it.

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: '#include <windows.h>', re: /#\s*include\s*<windows\.h>/ },
  { name: '#include <tlhelp32.h>', re: /#\s*include\s*<tlhelp32\.h>/ },
  { name: '#include <psapi.h>', re: /#\s*include\s*<psapi\.h>/ },
  { name: '#include <sys/ptrace.h>', re: /#\s*include\s*<sys\/ptrace\.h>/ },
  { name: 'HANDLE', re: /\bHANDLE\b/ },
  { name: 'DWORD', re: /\bDWORD\b/ },
  { name: 'OpenProcess(', re: /(?<!platform::)\bOpenProcess\s*\(/ },
  // Not preceded by platform:: nor by "Value " (the addon's own N-API wrapper).
  { name: 'CreateRemoteThread(', re: /(?<!platform::)(?<!Value\s)\bCreateRemoteThread\s*\(/ },
  { name: 'VirtualQueryEx', re: /\bVirtualQueryEx\b/ },
  { name: 'ReadProcessMemory', re: /\bReadProcessMemory\b/ },
  { name: 'WriteProcessMemory', re: /\bWriteProcessMemory\b/ },
  { name: 'VirtualAllocEx', re: /\bVirtualAllocEx\b/ },
  { name: 'VirtualProtectEx', re: /\bVirtualProtectEx\b/ },
  { name: 'GetThreadContext', re: /\bGetThreadContext\b/ },
  { name: 'SetThreadContext', re: /\bSetThreadContext\b/ },
  { name: 'DebugActiveProcess', re: /\bDebugActiveProcess\b/ },
  { name: 'WaitForDebugEvent', re: /\bWaitForDebugEvent\b/ },
  { name: 'CreateToolhelp32Snapshot', re: /\bCreateToolhelp32Snapshot\b/ },
]

// Replaces comments and string/char literal contents with spaces, keeping
// newlines so line numbers survive. Quotes of literals are kept as "" / ''.
export function stripCommentsAndLiterals(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j++
      out += blank(src.slice(i, j))
      i = j
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      const j = end < 0 ? n : end + 2
      out += blank(src.slice(i, j))
      i = j
    } else if (c === 'R' && d === '"' && /[^A-Za-z0-9_]/.test(src[i - 1] ?? ' ')) {
      // raw string literal R"delim( ... )delim"
      const open = src.indexOf('(', i + 2)
      const delim = open < 0 ? '' : src.slice(i + 2, open)
      const close = open < 0 ? -1 : src.indexOf(')' + delim + '"', open)
      const j = close < 0 ? n : close + delim.length + 2
      out += '""' + blank(src.slice(i + 2, j))
      i = j
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') j++
        j++
      }
      const end = Math.min(j + 1, n)
      out += c + blank(src.slice(i + 1, j)) + (src[j] === c ? c : '')
      i = end
    } else {
      out += c
      i++
    }
  }
  return out
}

// Exemption: platform.h and platform_linux.cc declare/define the platform::
// functions OpenProcess/CreateRemoteThread themselves (inside namespace
// platform), so in those two files only declaration forms (a type name before
// the identifier, e.g. `ProcessHandle OpenProcess(`) are allowed. Call-like
// uses (`::OpenProcess(`, `= OpenProcess(`, `return OpenProcess(`, ...) are
// still reported there.
const API_EXEMPT_FILES = ['native/src/platform/platform.h', 'native/src/platform/platform_linux.cc']
const DECLARATION_FORM =
  /^\s*(?!return\b)[A-Za-z_][\w:<>]*[\s*&]+(?:OpenProcess|CreateRemoteThread)\s*\(/

export function findViolations(
  src: string,
  declaresPlatformApi = false,
): { line: number; token: string }[] {
  const lines = stripCommentsAndLiterals(src).split('\n')
  const hits: { line: number; token: string }[] = []
  lines.forEach((text, idx) => {
    for (const f of FORBIDDEN) {
      if (
        declaresPlatformApi &&
        (f.name === 'OpenProcess(' || f.name === 'CreateRemoteThread(') &&
        DECLARATION_FORM.test(text)
      ) {
        continue
      }
      if (f.re.test(text)) hits.push({ line: idx + 1, token: f.name })
    }
  })
  return hits
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const root = join(__dirname, '..', '..')
const srcDir = join(root, 'native', 'src')
const EXEMPT = ['native/src/platform/platform_win32.cc']

describe('no OS-specific code outside the platform layer', () => {
  it('native/src (except platform_win32.cc) has no Win32/ptrace headers or calls', () => {
    const offenders: string[] = []
    for (const file of walk(srcDir)) {
      const rel = relative(root, file).split(sep).join('/')
      if (EXEMPT.includes(rel) || rel.includes('/third_party/') || rel.includes('Linux/native/')) continue
      for (const v of findViolations(readFileSync(file, 'utf8'), API_EXEMPT_FILES.includes(rel))) {
        offenders.push(`${rel}:${v.line}: ${v.token}`)
      }
    }
    expect(
      offenders,
      'Move these behind native/src/platform/platform.h:\n' + offenders.join('\n'),
    ).toEqual([])
  })

  it('matcher ignores comments, literals and platform:: calls but flags real uses', () => {
    const snippet = [
      '// HANDLE in a comment',
      '/* DWORD in a block',
      '   comment */',
      'const char* m = "ReadProcessMemory failed";',
      'auto t = platform::CreateRemoteThread(h, a, 0);',
      'auto p = platform::OpenProcess(pid);',
      'Napi::Value CreateRemoteThread(const Napi::CallbackInfo& info) {}',
      'HANDLE h;',
    ].join('\n')
    expect(findViolations(snippet)).toEqual([{ line: 8, token: 'HANDLE' }])
    expect(findViolations('#include <windows.h>\nOpenProcess(1,0,2);')).toEqual([
      { line: 1, token: '#include <windows.h>' },
      { line: 2, token: 'OpenProcess(' },
    ])
  })
  it('exemption allows only declaration forms in the two named platform files', () => {
    const decl = 'ProcessHandle OpenProcess(uint32_t pid, std::string& error);'
    expect(findViolations(decl, true)).toEqual([])
    expect(findViolations('  ThreadHandle CreateRemoteThread(ProcessHandle h) { return 0; }', true)).toEqual([])
    expect(findViolations('auto h = ::OpenProcess(pid);', true)).toEqual([{ line: 1, token: 'OpenProcess(' }])
    expect(findViolations('return OpenProcess(pid);', true)).toEqual([{ line: 1, token: 'OpenProcess(' }])
    expect(findViolations(decl, false)).toEqual([{ line: 1, token: 'OpenProcess(' }])
  })
})
