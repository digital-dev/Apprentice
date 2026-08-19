import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { importCheatTableWithBudget } from '../../src/main/ctImportSafe'
import { importCheatTable } from '../../src/main/ctImport'

// Fixture worker scripts used to exercise the timeout/error paths
// deterministically — see their own file comments for why a fixture
// (rather than a genuinely slow pathological input against a tiny real
// timeout) is the reliable way to test this without flakiness.
const HANG_WORKER = path.join(__dirname, 'fixtures', 'hangForeverWorker.js')
const THROWING_WORKER = path.join(__dirname, 'fixtures', 'throwingWorker.js')

const validTableXml = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="45">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"Health"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>"game.exe"+ABCD</Address>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`

describe('importCheatTableWithBudget', () => {
  it('returns the real CtImportResult on the success path, well within the timeout', async () => {
    const result = await importCheatTableWithBudget(validTableXml, 8000)
    expect('error' in result).toBe(false)
    // Must match what the synchronous parser itself produces — the worker
    // wrapper is not allowed to change the outcome, only bound its time.
    expect(result).toEqual(importCheatTable(validTableXml))
  })

  it(
    'terminates the worker and returns a graceful error when the worker never responds in time',
    async () => {
      const result = await importCheatTableWithBudget('irrelevant', 50, HANG_WORKER)
      expect(result).toEqual({
        error: 'This file took too long to parse — it may be malformed or corrupted.'
      })
    },
    5000
  )

  it('returns a graceful error (not a rejected promise) when the worker throws uncaught', async () => {
    const result = await importCheatTableWithBudget('irrelevant', 8000, THROWING_WORKER)
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.length).toBeGreaterThan(0)
    }
  })

  it('never rejects even when passed a nonexistent worker script path', async () => {
    const result = await importCheatTableWithBudget(
      'irrelevant',
      8000,
      path.join(__dirname, 'fixtures', 'does-not-exist.js')
    )
    expect('error' in result).toBe(true)
  })
})
