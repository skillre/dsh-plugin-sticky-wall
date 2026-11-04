import { describe, expect, it } from 'vitest'
import { StickyWallStore, WallError, DOMAIN_SPEC } from '../src/store.js'
import { LIMITS, type Note } from '../src/types.js'

/**
 * In-memory stand-in for one opened storage domain.
 *
 * It mirrors the contract the live `storageDomain` facility provides to this
 * store: synchronous reads from an authoritative record map, promise-returning
 * writes, `update(key, transform)` that fails on a missing key, and one serial
 * write chain. Keeping it here means the store's behavior is testable without a
 * DSH profile, while the real domain is still exercised by the packed-install
 * verification.
 */
function createFakeDomain() {
  const tables = new Map<string, Map<string, unknown>>()
  const chain: Promise<unknown>[] = []
  let closed = false
  const tableFor = (name: string) => {
    let table = tables.get(name)
    if (!table) {
      table = new Map()
      tables.set(name, table)
    }
    return table
  }
  return {
    table(name: string) {
      const records = tableFor(name)
      return {
        get: (key: string) => records.get(key),
        entries: () => [...records.entries()][Symbol.iterator](),
        keys: () => [...records.keys()][Symbol.iterator](),
        get size() { return records.size },
        put(key: string, value: Note) {
          if (closed) throw new WallError('closed', 'domain closed')
          const job = Promise.resolve().then(() => { records.set(key, value) })
          chain.push(job)
          return job
        },
        update(key: string, transform: (value: Note) => Note) {
          const job = Promise.resolve().then(() => {
            const current = records.get(key)
            if (current === undefined) throw new WallError('missing-key', `no record ${key}`)
            const next = transform(current as Note)
            records.set(key, next)
            return next
          })
          chain.push(job)
          return job
        },
        delete(key: string) {
          const job = Promise.resolve().then(() => {
            const existed = records.delete(key)
            return existed
          })
          chain.push(job)
          return job
        },
      }
    },
    async close() {
      await Promise.allSettled(chain)
      closed = true
    },
  }
}

const open = async () => createFakeDomain() as never

/**
 * A clock that advances one second per read, so every write gets a distinct
 * timestamp and ordering assertions stay meaningful.
 */
function steppingClock(start = Date.UTC(2026, 0, 1)): () => Date {
  let offset = 0
  return () => new Date(start + offset++ * 1000)
}

async function makeStore(options: { seed?: boolean; maxNotes?: number; now?: () => Date } = {}) {
  return StickyWallStore.open(open, {
    maxNotes: options.maxNotes ?? LIMITS.notes,
    seedWelcomeNote: options.seed ?? false,
    now: options.now ?? steppingClock(),
  })
}

describe('sticky-wall store', () => {
  it('declares a per-record domain so one damaged note cannot lose the wall', () => {
    expect(DOMAIN_SPEC.layout).toBe('per-record')
    expect(DOMAIN_SPEC.invalidRecords).toBe('backup-and-skip')
    expect(Object.keys(DOMAIN_SPEC.tables)).toEqual(['notes'])
  })

  it('creates a note with normalized tags and a stamped lifecycle', async () => {
    const store = await makeStore()
    const note = await store.create({ body: '  hello  ', tags: [' Work ', 'work', 'idea', ''] })
    expect(note.body).toBe('hello')
    expect(note.tags).toEqual(['work', 'idea'])
    expect(note.color).toBe('yellow')
    expect(note.pinned).toBe(false)
    expect(note.archived).toBe(false)
    expect(note.createdAt).toBe(note.updatedAt)
    expect(store.list()).toHaveLength(1)
  })

  it('rejects an empty body, an over-long body and an unknown color', async () => {
    const store = await makeStore()
    await expect(store.create({ body: '   ' })).rejects.toMatchObject({ code: 'empty-body' })
    await expect(store.create({ body: 'x'.repeat(LIMITS.body + 1) })).rejects.toMatchObject({ code: 'body-too-long' })
    await expect(store.create({ body: 'ok', color: 'chartreuse' as never })).rejects.toMatchObject({ code: 'invalid-color' })
  })

  it('enforces the configured note cap on live notes only', async () => {
    const store = await makeStore({ maxNotes: 2 })
    const first = await store.create({ body: 'one' })
    await store.create({ body: 'two' })
    await expect(store.create({ body: 'three' })).rejects.toMatchObject({ code: 'wall-full' })
    await store.setArchived([first.id], true)
    await expect(store.create({ body: 'three' })).resolves.toBeDefined()
  })

  it('updates only the fields a patch names and bumps updatedAt once', async () => {
    const store = await makeStore()
    const note = await store.create({ body: 'first', title: 'T' })
    const updated = await store.update(note.id, { body: 'second', pinned: true })
    expect(updated.body).toBe('second')
    expect(updated.title).toBe('T')
    expect(updated.pinned).toBe(true)
    expect(updated.updatedAt).not.toBe(note.updatedAt)
    // A no-op patch returns the record untouched.
    const same = await store.update(note.id, { body: 'second', pinned: true })
    expect(same.updatedAt).toBe(updated.updatedAt)
  })

  it('reports a missing note instead of silently creating one', async () => {
    const store = await makeStore()
    await expect(store.update('nope', { body: 'x' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(store.setArchived(['nope'], true)).rejects.toMatchObject({ code: 'not-found' })
    await expect(store.remove(['nope'])).rejects.toMatchObject({ code: 'not-found' })
  })

  it('rejects a batch with an unknown id without archiving any of it', async () => {
    const store = await makeStore()
    const first = await store.create({ body: 'first' })
    await store.create({ body: 'second' })
    // `first` is valid, `nope` is not: nothing may be written.
    await expect(store.setArchived([first.id, 'nope'], true)).rejects.toMatchObject({ code: 'not-found' })
    expect(store.list(true).every((note) => note.archived === false)).toBe(true)
  })

  it('refuses to restore past the cap from every write path', async () => {
    const store = await makeStore({ maxNotes: 2 })
    const keep = await store.create({ body: 'keep' })
    const archived = await store.create({ body: 'archived' })
    await store.setArchived([archived.id], true)
    // Two live notes fill the cap exactly; a restore must not squeeze in.
    await store.create({ body: 'filler' })
    await expect(store.setArchived([archived.id], false)).rejects.toMatchObject({ code: 'wall-full' })
    await expect(store.update(archived.id, { archived: false })).rejects.toMatchObject({ code: 'wall-full' })
    expect(store.list(true).filter((note) => !note.archived)).toHaveLength(2)
    expect(store.list(true).find((note) => note.id === archived.id)?.archived).toBe(true)
    expect(store.list().some((note) => note.id === keep.id)).toBe(true)
  })

  it('serializes concurrent creates at the cap boundary', async () => {
    const store = await makeStore({ maxNotes: 2 })
    await store.create({ body: 'first' })
    const results = await Promise.allSettled([store.create({ body: 'a' }), store.create({ body: 'b' })])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)
    expect(store.list()).toHaveLength(2)
  })

  it('rejects a delete batch naming a missing id without deleting any of it', async () => {
    const store = await makeStore()
    const first = await store.create({ body: 'first' })
    const second = await store.create({ body: 'second' })
    await expect(store.remove([first.id, 'nope'])).rejects.toMatchObject({ code: 'not-found' })
    expect(store.list().map((note) => note.id).sort()).toEqual([first.id, second.id].sort())
  })

  it('returns an empty result when clearing a wall with nothing archived', async () => {
    const store = await makeStore()
    await store.create({ body: 'live' })
    await expect(store.clearArchived()).resolves.toEqual([])
  })

  it('accepts exactly the bulk limit and rejects one more', async () => {
    const store = await makeStore()
    const created: string[] = []
    for (let index = 0; index < LIMITS.bulk; index += 1) created.push((await store.create({ body: `note ${index}` })).id)
    await expect(store.remove(created)).resolves.toHaveLength(LIMITS.bulk)
    await expect(store.remove([...created, 'one-more'])).rejects.toMatchObject({ code: 'too-many-ids' })
  })

  it('archives, restores and clears archived notes', async () => {
    const store = await makeStore()
    const keep = await store.create({ body: 'keep' })
    const gone = await store.create({ body: 'gone' })
    const archived = await store.setArchived([gone.id], true)
    expect(archived).toHaveLength(1)
    expect(store.list()).toHaveLength(1)
    expect(store.list(true)).toHaveLength(2)
    const restored = await store.setArchived([gone.id], false)
    expect(restored[0]?.archived).toBe(false)
    await store.setArchived([gone.id], true)
    await expect(store.clearArchived()).resolves.toEqual([gone.id])
    expect(store.list(true).map((note) => note.id)).toEqual([keep.id])
  })

  it('deletes a batch and refuses an empty or oversized selection', async () => {
    const store = await makeStore()
    const first = await store.create({ body: 'a' })
    const second = await store.create({ body: 'b' })
    await expect(store.remove([first.id, second.id])).resolves.toEqual([first.id, second.id])
    expect(store.list()).toHaveLength(0)
    await expect(store.remove([])).rejects.toMatchObject({ code: 'invalid-ids' })
    await expect(store.remove(Array.from({ length: LIMITS.bulk + 1 }, (_, index) => `id-${index}`))).rejects.toMatchObject({ code: 'too-many-ids' })
  })

  it('orders pinned first, then the requested key', async () => {
    const store = await makeStore()
    const older = await store.create({ body: 'older' })
    const newer = await store.create({ body: 'newer' })
    const pinned = await store.create({ body: 'pinned', pinned: true })
    // The stepping clock makes `pinned` the newest, so pinned-first is the only
    // thing separating it from the creation order.
    expect(store.list(false, 'created').map((note) => note.id)).toEqual([pinned.id, newer.id, older.id])
    expect(store.list(false, 'updated').map((note) => note.id)).toEqual([pinned.id, newer.id, older.id])
  })

  it('seeds one welcome note only on a brand-new wall', async () => {
    const seeded = await makeStore({ seed: true })
    const welcome = seeded.list()
    expect(welcome).toHaveLength(1)
    expect(welcome[0]?.pinned).toBe(true)
    const store = await makeStore()
    await store.create({ body: 'mine' })
    const reopened = await StickyWallStore.open(open, { maxNotes: LIMITS.notes, seedWelcomeNote: true, now: steppingClock() })
    expect(reopened.list()).toHaveLength(1)
  })

  it('closes the domain and refuses later writes instead of dropping them', async () => {
    const store = await makeStore()
    await store.create({ body: 'x' })
    await store.close()
    await expect(store.create({ body: 'y' })).rejects.toMatchObject({ code: 'closed' })
    expect(() => store.list()).toThrow(/shutting down/)
  })
})
