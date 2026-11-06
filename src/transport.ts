/**
 * Host ↔ Client transport: one exact Fetch route inside Connection's fence.
 *
 * Connection owns the Host/Origin check, the browser-session authentication and
 * the Peer scope; this module registers one exact `POST /api/<endpoint>` route
 * and only has to validate its own envelope and payload. No physical server, no
 * Express, and no second RPC channel is claimed.
 *
 * The wire envelope is the inspected Connection unary shape:
 * `{ type: 'client-request', rpcId, method, payload }` in and
 * `{ type: 'server-response', rpcId, result: { ok: true, value } | { ok: false, error } }`
 * out. A non-owner Peer is rejected by Connection before this handler runs.
 */

import { z } from 'zod'
import { WallError } from './store.js'
import {
  COLORS,
  ENDPOINT,
  LIMITS,
  SORTS,
  WIDTHS,
  type MutationResult,
  type Note,
  type NoteInput,
  type NoteLayout,
  type NotePatch,
  type NoteSort,
  type WallRequest,
  type WallResult,
} from './types.js'

/** Path of the exact route, under the shared `/api` channel. */
export const EXECUTE_PATH = `/api/${ENDPOINT}`

/** One buffered exact Fetch route as the Connection registry accepts it. */
export interface FetchRoute {
  readonly path: string
  readonly methods: readonly ['POST']
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

/** The Host Connection face this plugin depends on. */
export interface HostConnection {
  readonly fetch: { register(route: FetchRoute): () => Promise<void> }
}

/** The store operations the route dispatches onto. */
export interface WallActions {
  list(includeArchived?: boolean, sort?: NoteSort): Note[]
  create(input: NoteInput): Promise<Note>
  update(id: string, patch: NotePatch): Promise<Note>
  setArchived(ids: string[], archived: boolean): Promise<Note[]>
  remove(ids: string[]): Promise<string[]>
  clearArchived(): Promise<string[]>
  move(id: string, layout: NoteLayout): Promise<Note>
  arrange(): Promise<Note[]>
}

const envelopeSchema = z.object({
  type: z.literal('client-request'),
  rpcId: z.string(),
  method: z.string(),
  payload: z.unknown(),
})

const colorSchema = z.enum(COLORS)
const sortSchema = z.enum(SORTS)
const idSchema = z.string().min(1).max(128)
const idsSchema = z.array(idSchema).min(1).max(LIMITS.bulk)

/** One card placement; only the shape is validated here.
 *
 * The bounds are deliberately NOT enforced with `.min/.max`: a user who drags a
 * card past the world edge should get a clamped position, not an error toast.
 * The store clamps with `clampLayout`, which is the single place the policy
 * lives; rejecting here made that clamp unreachable over RPC. Non-finite values
 * are still refused, because there is no sensible clamp for NaN or Infinity.
 */
const layoutSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    rotate: z.number().finite(),
    width: z.enum(WIDTHS),
  })
  .strict()

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), includeArchived: z.boolean().optional(), sort: sortSchema.optional() }).strict(),
  z
    .object({
      action: z.literal('create'),
      note: z
        .object({
          body: z.string().min(1).max(LIMITS.body),
          title: z.string().max(LIMITS.title).optional(),
          tags: z.array(z.string().max(LIMITS.tag)).max(LIMITS.tags).optional(),
          color: colorSchema.optional(),
          pinned: z.boolean().optional(),
          layout: layoutSchema.nullable().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      id: idSchema,
      patch: z
        .object({
          body: z.string().min(1).max(LIMITS.body).optional(),
          title: z.string().max(LIMITS.title).optional(),
          tags: z.array(z.string().max(LIMITS.tag)).max(LIMITS.tags).optional(),
          color: colorSchema.optional(),
          pinned: z.boolean().optional(),
          archived: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ action: z.literal('archive'), ids: idsSchema, archived: z.boolean() }).strict(),
  z.object({ action: z.literal('delete'), ids: idsSchema }).strict(),
  z.object({ action: z.literal('clear-archived') }).strict(),
  z.object({ action: z.literal('move'), id: idSchema, layout: layoutSchema }).strict(),
  z.object({ action: z.literal('arrange') }).strict(),
])

/** A JSON response with no-store caching; the wall is always live state. */
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/** One server-response success envelope. */
function success(rpcId: string, value: unknown): Response {
  return json({ type: 'server-response', rpcId, result: { ok: true, value } })
}

/** One server-response failure envelope, using a stable plugin-owned code. */
function failure(rpcId: string, code: string, message: string, details: Record<string, unknown> = {}): Response {
  return json({ type: 'server-response', rpcId, result: { ok: false, error: { code: `sticky-wall/${code}`, message, details } } })
}

/** Recover the correlation id from any body shape so failures stay correlatable. */
function correlation(body: unknown): string {
  return body !== null && typeof body === 'object' && 'rpcId' in body && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
}

/** Dispatch one validated request onto the store. */
async function dispatch(actions: WallActions, request: WallRequest): Promise<unknown> {
  switch (request.action) {
    case 'list':
      return { notes: actions.list(request.includeArchived, request.sort) }
    case 'create':
      return { action: 'create', changed: [await actions.create(request.note)], removed: [] } satisfies MutationResult
    case 'update':
      return { action: 'update', changed: [await actions.update(request.id, request.patch)], removed: [] } satisfies MutationResult
    case 'archive':
      return { action: 'archive', changed: await actions.setArchived(request.ids, request.archived), removed: [] } satisfies MutationResult
    case 'delete':
      return { action: 'delete', changed: [], removed: await actions.remove(request.ids) } satisfies MutationResult
    case 'clear-archived':
      return { action: 'clear-archived', changed: [], removed: await actions.clearArchived() } satisfies MutationResult
    case 'move':
      return { action: 'move', changed: [await actions.move(request.id, request.layout)], removed: [] } satisfies MutationResult
    case 'arrange':
      return { action: 'arrange', changed: await actions.arrange(), removed: [] } satisfies MutationResult
  }
}

/**
 * Build the exact route Connection registers; every failure stays inside the
 * envelope. `ready` resolves the store lazily so a storage-open failure is
 * reported on the first request instead of at registration time.
 */
export function createExecuteRoute(ready: () => Promise<WallActions>): FetchRoute {
  return {
    path: EXECUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST' || new URL(request.url).pathname !== EXECUTE_PATH) return new Response('not found', { status: 404 })
      const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 })
      let body: unknown
      try {
        body = await request.json()
      } catch {
        if (request.signal.aborted) return failure(correlation(body), 'cancelled', 'The request was cancelled before dispatch.')
        return new Response('body is not JSON', { status: 400 })
      }
      if (request.signal.aborted) return failure(correlation(body), 'cancelled', 'The request was cancelled before dispatch.')
      const envelope = envelopeSchema.safeParse(body)
      if (!envelope.success) return failure(correlation(body), 'bad-request', 'Invalid client-request message.')
      const message = envelope.data
      if (message.method !== ENDPOINT) return failure(message.rpcId, 'bad-request', 'RPC method does not match the sticky-wall endpoint.')
      const parsed = requestSchema.safeParse(message.payload)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        return failure(message.rpcId, 'bad-request', first?.message ?? 'Invalid sticky-wall request.', { issues: parsed.error.issues.slice(0, 4) })
      }
      try {
        request.signal.throwIfAborted()
        return success(message.rpcId, await dispatch(await ready(), parsed.data as WallRequest))
      } catch (error) {
        // A WallError is authored for the user; anything else is a Host fault
        // whose text must not become UI copy (and must not leak backend detail).
        if (error instanceof WallError) return failure(correlation(body), error.code, error.message.slice(0, 2000), error.details)
        if (request.signal.aborted) return failure(correlation(body), 'cancelled', 'The request was cancelled.')
        return failure(correlation(body), 'internal', 'The note wall hit an internal error; check the Host log.')
      }
    },
  }
}

/** Re-export the result envelope type for the Client half's structural mirror. */
export type { WallResult }
