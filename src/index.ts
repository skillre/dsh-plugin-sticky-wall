/**
 * Host entry of the sticky wall.
 *
 * Ownership split: this half owns durable notes (storage domain) and the
 * Connection route the Client renders from; the Client half owns only view
 * state. Everything registered here — the domain handle, the exact Fetch
 * route, and the optional agent tool — belongs to this plugin's Fiber, so
 * stopping or updating the row releases all three with no residue.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.js'
import type { WallConfig } from './config.js'
import { StickyWallStore } from './store.js'
import type { DomainHandle } from './store.js'
import { createExecuteRoute } from './transport.js'
import type { HostConnection } from './transport.js'
import { LIMITS, type Note, type NoteColor, type NoteLayout } from './types.js'

export { Config, StickyWallStore }
export const name = 'skillre-sticky-wall'

/**
 * Required services. `storageDomain` provides the durable note table;
 * `connection` provides the authenticated Client route. Both are declared hard
 * dependencies so a profile missing either fails loudly instead of mounting a
 * wall that can never persist or be reached.
 */
export const inject = ['storageDomain', 'connection']

/**
 * The storage-domain facility face this plugin uses. `open` is the only
 * operation needed: it validates the spec, routes the domain to the configured
 * backend and loads every stored record before resolving the handle.
 */
interface DomainFacility {
  open(spec: unknown): Promise<DomainHandle>
}

/** Optional `tools` service; absent when the profile mounts no tool registry. */
interface ToolExecution {
  signal: AbortSignal
}
interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: unknown, execution: ToolExecution): Promise<unknown>
  isConcurrencySafe(args: unknown): boolean
  timeoutMs?: number
}
interface Tools {
  register(definition: ToolDefinition): () => void
}

/** Read an optional Cordis service without declaring it required. */
function service<T>(ctx: Context, key: string): T | undefined {
  return ctx.get(key) as T | undefined
}

/** Model-facing text for one tool result; short, deterministic and readable. */
function renderWall(value: unknown): string {
  const data = (value ?? {}) as Record<string, unknown>
  const action = typeof data.action === 'string' ? data.action : 'result'
  if (action === 'list') {
    const notes = Array.isArray(data.notes) ? (data.notes as Note[]) : []
    if (notes.length === 0) return 'The note wall is empty.'
    const lines = notes.map((note) => {
      const pin = note.pinned ? '📌 ' : ''
      const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : ''
      const archived = note.archived ? ' (archived)' : ''
      const heading = note.title ? `${note.title}: ` : ''
      return `- ${pin}${note.id}${archived}${tags} ${heading}${note.body.replace(/\s+/g, ' ').slice(0, 140)}`
    })
    return [`${String(data.total ?? notes.length)} notes (${String(data.archived ?? 0)} archived):`, ...lines].join('\n')
  }
  if (action === 'arrange') {
    const notes = Array.isArray(data.changed) ? (data.changed as Note[]) : []
    return notes.length === 0 ? 'The wall was already tidy.' : `Tidied ${notes.length} note${notes.length === 1 ? '' : 's'} into the shelf arrangement.`
  }
  if (action === 'delete' || action === 'clear-archived') {
    const removed = Array.isArray(data.removed) ? data.removed.length : 0
    return `Removed ${removed} note${removed === 1 ? '' : 's'}.`
  }
  if (action === 'archive') {
    const notes = Array.isArray(data.notes) ? (data.notes as Note[]) : []
    return notes.length === 0 ? 'No note changed.' : notes.map((note) => `${note.id} ${note.archived ? 'archived' : 'restored'}`).join('\n')
  }
  const note = data.note as Note | undefined
  if (note) return `${action === 'create' ? 'Created' : 'Updated'} note ${note.id}${note.title ? ` (${note.title})` : ''}: ${note.body.replace(/\s+/g, ' ').slice(0, 140)}`
  return 'Done.'
}

/** Register the model-facing capture tool when the registry is present. */
function registerAgentTool(ctx: Context, ready: Promise<StickyWallStore>): void {
  const tools = service<Tools>(ctx, 'tools')
  if (!tools) return
  ctx.effect(() => {
    const disposer = tools.register({
      name: 'sticky_wall',
      description:
        "Capture and manage sticky notes on the user's DSH note wall (便签墙): quick inspiration, temporary tasks and short reminders. Use it when the user asks to note something down, list their notes, update or pin one, or clean up archived notes.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'archive', 'delete', 'clear-archived', 'arrange'] },
          id: { type: 'string', description: 'Exact note id; required by update.' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Note ids; required by archive and delete (1–200 entries).' },
          body: { type: 'string', description: `The note text (1–${LIMITS.body} characters). Required by create; optional patch field for update.` },
          title: { type: 'string', description: `Optional short heading (max ${LIMITS.title} characters).` },
          tags: { type: 'array', items: { type: 'string' }, description: `Optional lowercase tags (max ${LIMITS.tags}).` },
          color: { type: 'string', enum: ['yellow', 'pink', 'green', 'blue', 'purple', 'orange'], description: 'Optional pastel note color.' },
          pinned: { type: 'boolean', description: 'Pin the note to the top of the wall.' },
          archived: { type: 'boolean', description: 'Archive (true) or restore (false) one note on update.' },
          includeArchived: { type: 'boolean', description: 'list only: include archived notes.' },
          x: { type: 'number', description: 'Free-canvas horizontal position of the card, in canvas pixels. Optional on create.' },
          y: { type: 'number', description: 'Free-canvas vertical position of the card, in canvas pixels. Optional on create.' },
          limit: { type: 'integer', description: 'list only: how many notes to return (1–50, default 20).' },
        },
      },
      timeoutMs: 20_000,
      isConcurrencySafe(args) {
        return typeof args === 'object' && args !== null && (args as { action?: unknown }).action === 'list'
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: renderWall(value) }]
        },
      },
      async execute(raw, execution) {
        execution.signal.throwIfAborted()
        const store = await ready
        const args = (raw ?? {}) as Record<string, unknown>
        switch (args.action) {
          case 'list':
            return { action: 'list', ...store.summary(typeof args.limit === 'number' ? args.limit : 20) }
          case 'create':
            return {
              action: 'create',
              note: await store.create({
                body: String(args.body ?? ''),
                ...(typeof args.title === 'string' ? { title: args.title } : {}),
                ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
                ...(typeof args.color === 'string' ? { color: args.color as NoteColor } : {}),
                ...(typeof args.pinned === 'boolean' ? { pinned: args.pinned } : {}),
                ...(typeof args.x === 'number' && typeof args.y === 'number'
                  ? { layout: { x: args.x, y: args.y, rotate: 0, width: 'md' as const } }
                  : {}),
              }),
            }
          case 'update':
            return {
              action: 'update',
              note: await store.update(String(args.id ?? ''), {
                ...(typeof args.body === 'string' ? { body: args.body } : {}),
                ...(typeof args.title === 'string' ? { title: args.title } : {}),
                ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
                ...(typeof args.color === 'string' ? { color: args.color as NoteColor } : {}),
                ...(typeof args.pinned === 'boolean' ? { pinned: args.pinned } : {}),
                ...(typeof args.archived === 'boolean' ? { archived: args.archived } : {}),
              }),
            }
          case 'archive':
            return { action: 'archive', notes: await store.setArchived((args.ids as string[] | undefined) ?? [], args.archived === true) }
          case 'delete':
            return { action: 'delete', removed: await store.remove((args.ids as string[] | undefined) ?? []) }
          case 'clear-archived':
            return { action: 'clear-archived', removed: await store.clearArchived() }
          case 'arrange':
            return { action: 'arrange', changed: await store.arrange() }
          default:
            throw new Error(`Unknown sticky_wall action ${JSON.stringify(args.action)}.`)
        }
      },
    })
    return disposer
  }, 'skillre-sticky-wall agent tool')
}

export function apply(ctx: Context, rawConfig: Partial<WallConfig> = {}): void {
  const config = resolveConfig(rawConfig)
  const connection = service<HostConnection>(ctx, 'connection')
  if (!connection?.fetch?.register) throw new Error('Sticky wall requires the current DSH Connection exact Fetch-route registry.')
  const facility = service<DomainFacility>(ctx, 'storageDomain')
  if (!facility?.open) throw new Error('Sticky wall requires the DSH storageDomain facility.')

  const ready = StickyWallStore.open((spec) => facility.open(spec), {
    maxNotes: config.maxNotes,
    seedWelcomeNote: config.seedWelcomeNote,
  })
  ready.catch((error: unknown) => {
    // The route and the tool both await `ready`, so the failure also reaches the
    // first caller; log it once so it is never silent in the Host log.
    ctx.logger?.error?.(`sticky-wall: storage domain failed to open: ${error instanceof Error ? error.message : String(error)}`)
  })

  ctx.effect(() => () => {
    void ready.then((store) => store.close()).catch(() => {})
  }, 'skillre-sticky-wall storage lifetime')

  ctx.effect(
    () =>
      connection.fetch.register(
        createExecuteRoute(async () => {
          const store = await ready
          return {
            list: (includeArchived, sort) => store.list(includeArchived, sort),
            create: (input) => store.create(input),
            update: (id, patch) => store.update(id, patch as Parameters<StickyWallStore['update']>[1]),
            setArchived: (ids, archived) => store.setArchived(ids, archived),
            remove: (ids) => store.remove(ids),
            clearArchived: () => store.clearArchived(),
            move: (id, layout) => store.move(id, layout),
            arrange: () => store.arrange(),
          }
        }),
      ),
    'skillre-sticky-wall client route',
  )

  if (config.enableAgentTool) registerAgentTool(ctx, ready)
}
