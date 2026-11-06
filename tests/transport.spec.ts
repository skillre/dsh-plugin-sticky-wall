import { describe, expect, it } from 'vitest'
import { WallError } from '../src/store.js'
import { createExecuteRoute, EXECUTE_PATH } from '../src/transport.js'
import { ENDPOINT, LIMITS, type Note } from '../src/types.js'

/**
 * Transport contract tests.
 *
 * They drive the exact Fetch route with real `Request` objects, so the envelope
 * validation, the content-type gate, the correlation id and the error mapping
 * are exercised the way Connection's shared Fetch handler will call them.
 */

const store = {
  notes: new Map<string, Note>(),
  list: (includeArchived = false) => [...store.notes.values()].filter((note) => includeArchived || !note.archived),
  async create(input: { body: string }) {
    const note = {
      id: 'n1', title: '', body: input.body, tags: [], color: 'yellow' as const,
      pinned: false, archived: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      layout: null,
    }
    store.notes.set(note.id, note)
    return note
  },
  async update(id: string, patch: Record<string, unknown>) {
    const note = store.notes.get(id)
    if (!note) throw Object.assign(new Error(`No note with id ${JSON.stringify(id)}.`), { code: 'not-found', details: { id } })
    const next = { ...note, ...(patch as Partial<Note>) }
    store.notes.set(id, next)
    return next
  },
  async setArchived(ids: string[], archived: boolean) {
    return ids.map((id) => ({ ...store.notes.get(id)!, archived }))
  },
  async remove(ids: string[]) {
    for (const id of ids) {
      if (!store.notes.has(id)) throw Object.assign(new Error('missing'), { code: 'not-found' })
    }
    for (const id of ids) store.notes.delete(id)
    return ids
  },
  async clearArchived() {
    return []
  },
  async move(id: string, layout: { x: number; y: number; rotate: number; width: 'sm' | 'md' | 'lg' }) {
    const note = store.notes.get(id)
    if (!note) throw Object.assign(new Error('missing'), { code: 'not-found' })
    const next = { ...note, layout }
    store.notes.set(id, next)
    return next
  },
  async arrange() {
    return [...store.notes.values()]
  },
}

const actions = async () => store

/** Build one request envelope the way the browser RPC caller does. */
function request(payload: unknown, rpcId = 'rpc-1'): Request {
  return new Request(`http://127.0.0.1${EXECUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: ENDPOINT, payload }),
  })
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

describe('sticky-wall transport', () => {
  it('registers one buffered POST route on the shared /api channel', () => {
    const route = createExecuteRoute(actions)
    expect(route.path).toBe('/api/skillre-sticky-wall/execute')
    expect(route.methods).toEqual(['POST'])
    expect(route.requestBody).toBe('buffered')
  })

  it('answers a list request with a correlated success envelope', async () => {
    const route = createExecuteRoute(actions)
    const response = await route.fetch(request({ action: 'list' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const document = await body(response)
    expect(document.type).toBe('server-response')
    expect(document.rpcId).toBe('rpc-1')
    expect(document.result).toMatchObject({ ok: true })
  })

  it('creates a note through the endpoint', async () => {
    const route = createExecuteRoute(actions)
    const response = await route.fetch(request({ action: 'create', note: { body: 'hello' } }))
    const document = await body(response)
    const result = document.result as { ok: boolean; value: { changed: Note[] } }
    expect(result.ok).toBe(true)
    expect(result.value.changed[0]?.body).toBe('hello')
  })

  it('rejects a wrong content type, a non-JSON body and a mismatched method', async () => {
    const route = createExecuteRoute(actions)
    const wrongType = await route.fetch(new Request(`http://127.0.0.1${EXECUTE_PATH}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }))
    expect(wrongType.status).toBe(415)
    const badJson = await route.fetch(new Request(`http://127.0.0.1${EXECUTE_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }))
    expect(badJson.status).toBe(400)
    const otherPath = await route.fetch(new Request('http://127.0.0.1/api/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
    expect(otherPath.status).toBe(404)
  })

  it('keeps a malformed envelope inside the RPC result instead of throwing', async () => {
    const route = createExecuteRoute(actions)
    const response = await route.fetch(new Request(`http://127.0.0.1${EXECUTE_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'nope', rpcId: 'rpc-2' }),
    }))
    const document = await body(response)
    expect(document.rpcId).toBe('rpc-2')
    expect(document.result).toMatchObject({ ok: false, error: { code: 'sticky-wall/bad-request' } })
  })

  it('rejects an unknown method on the right path', async () => {
    const route = createExecuteRoute(actions)
    const response = await route.fetch(new Request(`http://127.0.0.1${EXECUTE_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-3', method: 'other', payload: {} }),
    }))
    const document = await body(response)
    expect(document.result).toMatchObject({ ok: false, error: { code: 'sticky-wall/bad-request' } })
  })

  it('validates the payload shape before dispatching', async () => {
    const route = createExecuteRoute(actions)
    for (const payload of [
      {},
      { action: 'nope' },
      { action: 'create' },
      { action: 'create', note: { body: '' } },
      { action: 'create', note: { body: 'x'.repeat(LIMITS.body + 1) } },
      { action: 'create', note: { body: 'ok', color: 'chartreuse' } },
      { action: 'update', id: 'n1' },
      { action: 'archive', ids: [] },
      { action: 'delete', ids: Array.from({ length: LIMITS.bulk + 1 }, (_, index) => `id-${index}`) },
      { action: 'list', extra: true },
    ]) {
      const response = await route.fetch(request(payload, 'rpc-bad'))
      const document = await body(response)
      expect(document.rpcId, JSON.stringify(payload)).toBe('rpc-bad')
      expect(document.result, JSON.stringify(payload)).toMatchObject({ ok: false })
    }
  })

  it('maps a store failure onto a stable plugin-owned error code', async () => {
    const failing = async () => ({ ...store, async update() { throw new WallError('not-found', 'missing', { id: 'x' }) } })
    const route = createExecuteRoute(failing as never)
    const response = await route.fetch(request({ action: 'update', id: 'x', patch: { body: 'y' } }))
    const document = await body(response)
    expect(document.result).toMatchObject({ ok: false, error: { code: 'sticky-wall/not-found', message: 'missing', details: { id: 'x' } } })
  })

  it('accepts a charset-qualified JSON content type', async () => {
    const route = createExecuteRoute(actions)
    const response = await route.fetch(new Request(`http://127.0.0.1${EXECUTE_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-ct', method: ENDPOINT, payload: { action: 'list' } }),
    }))
    const document = await body(response)
    expect(document.result).toMatchObject({ ok: true })
  })

  it('correlates a cancelled request instead of answering with a placeholder id', async () => {
    const route = createExecuteRoute(actions)
    const controller = new AbortController()
    controller.abort()
    const response = await route.fetch(new Request(`http://127.0.0.1${EXECUTE_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-cancel', method: ENDPOINT, payload: { action: 'list' } }),
      signal: controller.signal,
    }))
    const document = await body(response)
    expect(document.rpcId).toBe('rpc-cancel')
    expect(document.result).toMatchObject({ ok: false, error: { code: 'sticky-wall/cancelled' } })
  })

  it('never leaks raw Host error text for a non-WallError throw', async () => {
    const route = createExecuteRoute(async () => { throw new TypeError('kaboom: internal backend detail') })
    const response = await route.fetch(request({ action: 'list' }, 'rpc-leak'))
    const document = await body(response)
    expect(document.result).toMatchObject({ ok: false, error: { code: 'sticky-wall/internal' } })
    expect(JSON.stringify(document)).not.toContain('kaboom')
  })

  it('reports an unarchive dispatch with the archived flag it was given', async () => {
    const route = createExecuteRoute(actions)
    const response = await route.fetch(request({ action: 'archive', ids: ['n1'], archived: false }))
    const document = await body(response)
    const result = document.result as { ok: boolean; value: { changed: Note[] } }
    expect(result.value.changed[0]?.archived).toBe(false)
  })

  it('moves a card through the exact route and echoes the stored placement', async () => {
    const route = createExecuteRoute(actions)
    await store.create({ body: 'movable' })
    const response = await route.fetch(
      request({ action: 'move', id: 'n1', layout: { x: 88, y: 44, rotate: 2, width: 'lg' } }, 'rpc-move'),
    )
    const document = await body(response)
    const result = document.result as { ok: boolean; value: { changed: Note[] } }
    expect(result.ok).toBe(true)
    expect(result.value.changed[0]?.layout).toEqual({ x: 88, y: 44, rotate: 2, width: 'lg' })
  })

  it('rejects a placement with a non-numeric coordinate before it reaches the store', async () => {
    const route = createExecuteRoute(actions)
    await store.create({ body: 'x' })
    const response = await route.fetch(
      request({ action: 'move', id: 'n1', layout: { x: 'left', y: 0, rotate: 0, width: 'md' } }, 'rpc-bad-move'),
    )
    const document = await body(response)
    expect(document.result).toMatchObject({ ok: false, error: { code: 'sticky-wall/bad-request' } })
  })

  it('rejects a placement outside the world bounds and an unknown width preset', async () => {
    const route = createExecuteRoute(actions)
    await store.create({ body: 'x' })
    for (const layout of [
      { x: 99_999, y: 0, rotate: 0, width: 'md' },
      { x: 0, y: 0, rotate: 0, width: 'huge' },
      { x: 0, y: 0, rotate: 90, width: 'md' },
    ]) {
      const response = await route.fetch(request({ action: 'move', id: 'n1', layout }, 'rpc-bound'))
      const document = await body(response)
      expect(document.result).toMatchObject({ ok: false, error: { code: 'sticky-wall/bad-request' } })
    }
  })

  it('dispatches a tidy request and returns the notes it repacked', async () => {
    const route = createExecuteRoute(actions)
    await store.create({ body: 'a' })
    await store.create({ body: 'b' })
    const response = await route.fetch(request({ action: 'arrange' }, 'rpc-arrange'))
    const document = await body(response)
    const result = document.result as { ok: boolean; value: { changed: Note[] } }
    expect(result.ok).toBe(true)
    expect(Array.isArray(result.value.changed)).toBe(true)
  })

  it('reports a storage-open failure on the first request instead of at registration', async () => {
    const route = createExecuteRoute(async () => { throw new Error('domain failed to open') })
    expect(() => createExecuteRoute(async () => { throw new Error('x') })).not.toThrow()
    const response = await route.fetch(request({ action: 'list' }))
    const document = await body(response)
    expect(document.result).toMatchObject({ ok: false, error: { code: 'sticky-wall/internal' } })
    expect(JSON.stringify(document)).not.toContain('domain failed to open')
  })
})
