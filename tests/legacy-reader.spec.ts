import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../src/index.js'

/**
 * Regression for the 0.8.0 data-loss bug.
 *
 * Shipped 0.8.0 declared the legacy table as `tables: { notes: {} }`, with no
 * `valueSchema`. `storageDomain` validates every record with
 * `tableSpec.valueSchema.parse(raw)` while opening the domain, so that
 * declaration threw on the FIRST record and — under `invalidRecords:
 * 'backup-and-skip'` — made the backend rename every note to
 * `<id>.json.bak.<stamp>` and treat it as absent. The migration then saw zero
 * notes, seeded a welcome note, and the user's wall looked empty.
 *
 * Every existing migration test injected `readLegacy: async () => [...]`, which
 * bypassed the real domain entirely — which is precisely why a green suite
 * shipped a broken migration. These tests instead drive the REAL
 * `storageDomain` facade contract, so a spec that cannot validate its own
 * records fails here.
 */

/** Poll until `condition` holds, or fail after a short budget. */
async function waitFor(condition: () => boolean, budgetMs = 3000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > budgetMs) throw new Error('condition not met within budget')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const note = {
  id: 'n1',
  title: 'T',
  body: 'hello',
  tags: ['a'],
  color: 'blue',
  pinned: true,
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  layout: { x: 10, y: 20, rotate: 1.5, width: 'lg' },
}

/**
 * A `storageDomain` double that behaves like the real one where it matters:
 * it validates every record through the DECLARED `valueSchema` and throws — or
 * quarantines — exactly as the shipped backend does.
 */
function makeFacility(records: Record<string, unknown>) {
  const quarantined: string[] = []
  const opened: unknown[] = []
  const facility = {
    async open(spec: {
      invalidRecords?: string
      tables: Record<string, { valueSchema?: { parse(value: unknown): unknown } }>
    }) {
      opened.push(spec)
      const table = spec.tables['notes']
      const schema = table?.valueSchema
      if (schema === undefined || typeof schema.parse !== 'function') {
        // This is the shipped bug, reproduced: no schema means the real backend
        // throws on the first record instead of loading it.
        throw new Error('tableSpec.valueSchema.parse is not a function')
      }
      const stored = new Map<string, unknown>()
      for (const [key, raw] of Object.entries(records)) {
        try {
          stored.set(key, schema.parse(raw))
        } catch (error) {
          if (spec.invalidRecords !== 'backup-and-skip') throw error
          // The real backend renames the file aside and treats it as absent.
          quarantined.push(key)
        }
      }
      return {
        table: () => ({ entries: () => [...stored.entries()][Symbol.iterator]() }),
        async close() {},
      }
    },
  }
  return { facility, quarantined, opened }
}

describe('legacy reader (real domain contract)', () => {
  it('declares a real valueSchema instead of an empty table spec', async () => {
    // The regression in one assertion: an empty `{}` table spec is what lost the
    // data, so the plugin must hand the domain a usable schema.
    const { facility, opened } = makeFacility({ n1: note })
    const ctx = {
      logger: { error: () => {}, warn: () => {} },
      get: (key: string) => {
        if (key === 'connection') return { fetch: { register: () => async () => {} } }
        if (key === 'storageDomain') return facility
        return undefined
      },
      effect: (callback: () => unknown) => { callback(); return () => {} },
    }
    const notesDir = await mkdtemp(join(tmpdir(), 'sw-legacy-'))
    ;(plugin.apply as (context: unknown, config?: unknown) => void)(ctx, { enableAgentTool: false, notesDir })
    // The store opens lazily and the migration runs off that promise, so wait
    // for it rather than assuming one macrotask is enough.
    await waitFor(() => opened.length > 0)

    expect(opened.length).toBeGreaterThan(0)
    const spec = opened[0] as { tables: Record<string, { valueSchema?: unknown }> }
    const schema = spec.tables['notes']?.valueSchema
    expect(schema).toBeDefined()
    expect(typeof (schema as { parse?: unknown }).parse).toBe('function')
  })

  it('migrates every record rather than quarantining them', async () => {
    const { facility, quarantined } = makeFacility({ n1: note })
    const collected: unknown[] = []
    const ctx = {
      logger: { error: () => {}, warn: () => {} },
      get: (key: string) => {
        if (key === 'connection') return { fetch: { register: () => async () => {} } }
        if (key === 'storageDomain') {
          return {
            async open(spec: never) {
              const handle = await facility.open(spec)
              // Capture what the reader actually pulled out.
              const entries = handle.table().entries()
              return {
                table: () => ({
                  entries: () => {
                    for (const entry of entries) collected.push(entry)
                    return [][Symbol.iterator]()
                  },
                }),
                async close() {},
              }
            },
          }
        }
        return undefined
      },
      effect: (callback: () => unknown) => { callback(); return () => {} },
    }
    const notesDir = await mkdtemp(join(tmpdir(), 'sw-legacy-'))
    ;(plugin.apply as (context: unknown, config?: unknown) => void)(ctx, { enableAgentTool: false, notesDir })
    await waitFor(() => collected.length > 0)

    // Nothing was quarantined: the schema accepted the record it was given.
    expect(quarantined).toEqual([])
    expect(collected.length).toBe(1)
  })
})
