/**
 * Durable note store over the DSH storage domain.
 *
 * The Host owns all data: the Client renders snapshots and submits intents, and
 * every write goes through {@link StickyWallStore} — validate, persist, then
 * hand back the changed records. The storage domain provides a single
 * per-domain write chain, so concurrent writes cannot interleave, and its
 * `per-record` layout keeps one file per note: one damaged record cannot take
 * the whole wall down.
 *
 * The domain spec is mirrored structurally instead of imported: importing
 * `@deepseek-ai/dsh-storage-domain` would install a second copy of the domain
 * package (and its zod) inside the plugin instead of resolving the host's. The
 * mirrored shape is the contract the live Host validates at `open()`:
 * `{ name, version, layout, invalidRecords, tables: { <name>: { valueSchema } } }`
 * with zod record schemas.
 */

import { z } from 'zod'
import { COLORS, DOMAIN_NAME, DOMAIN_VERSION, LIMITS, type Note, type NoteColor, type NoteInput, type NotePatch } from './types.js'

/** Failure carrying a stable code the transport maps onto the RPC envelope. */
export class WallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'WallError'
  }
}

/** Record schema; every stored note is validated at domain open and on write. */
const NoteSchema = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().max(LIMITS.title).default(''),
    body: z.string().min(1).max(LIMITS.body),
    tags: z.array(z.string().min(1).max(LIMITS.tag)).max(LIMITS.tags).default([]),
    color: z.enum(COLORS).default('yellow'),
    pinned: z.boolean().default(false),
    archived: z.boolean().default(false),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough()

/** The domain declaration handed to `ctx.storageDomain.open()`. */
export const DOMAIN_SPEC = {
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  layout: 'per-record' as const,
  invalidRecords: 'backup-and-skip' as const,
  tables: { notes: { valueSchema: NoteSchema } },
}

/** The minimal domain table face this store uses; the rest is unused here. */
export interface DomainTable {
  get(key: string): unknown
  entries(): Iterable<[string, unknown]>
  keys(): Iterable<string>
  readonly size: number
  put(key: string, value: Note): Promise<void>
  update(key: string, transform: (value: Note) => Note): Promise<Note>
  delete(key: string): Promise<boolean>
}

/** The opened-domain handle the facility returns. */
export interface DomainHandle {
  table(name: string): DomainTable
  close(): Promise<void>
}

/** Normalize one tag: trim, lowercase, collapse inner whitespace, bound length. */
function normalizeTag(raw: unknown): string {
  const value = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return value.slice(0, LIMITS.tag)
}

/** Normalize a submitted tag list: drop empties, deduplicate, cap the count. */
function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  for (const entry of raw) {
    const tag = normalizeTag(entry)
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    if (seen.size >= LIMITS.tags) break
  }
  return [...seen]
}

/** Validate and trim a note body; a live note may not be blank. */
function normalizeBody(raw: unknown): string {
  const value = String(raw ?? '').replace(/\r\n?/g, '\n').trim()
  if (value === '') throw new WallError('empty-body', 'A note needs some text.')
  if (value.length > LIMITS.body) throw new WallError('body-too-long', `A note is limited to ${LIMITS.body} characters.`, { limit: LIMITS.body, length: value.length })
  return value
}

/** Validate and trim a title; an absent title is the empty string. */
function normalizeTitle(raw: unknown): string {
  const value = String(raw ?? '').replace(/\r\n?/g, ' ').trim()
  if (value.length > LIMITS.title) throw new WallError('title-too-long', `A note title is limited to ${LIMITS.title} characters.`, { limit: LIMITS.title, length: value.length })
  return value
}

/** Accept only a declared pastel key. */
function normalizeColor(raw: unknown): NoteColor {
  const value = String(raw ?? '')
  const match = COLORS.find((color) => color === value)
  if (match === undefined) throw new WallError('invalid-color', `Unknown note color ${JSON.stringify(value)}.`, { colors: [...COLORS] })
  return match
}

/** Reject ids that are not plausible note keys before touching storage. */
function assertIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new WallError('invalid-ids', 'Select at least one note.')
  if (raw.length > LIMITS.bulk) throw new WallError('too-many-ids', `At most ${LIMITS.bulk} notes per request.`, { limit: LIMITS.bulk })
  const ids = [...new Set(raw.map((id) => String(id ?? '')))]
  if (ids.some((id) => id === '' || id.length > 128)) throw new WallError('invalid-ids', 'One of the selected note ids is invalid.')
  return ids
}

/**
 * One record's sort weight: pinned first, then the requested ordering, with the
 * id as a final tiebreaker so two notes written in the same millisecond still
 * render in a stable order.
 */
function compareNotes(sort: 'pinned' | 'created' | 'updated') {
  return (left: Note, right: Note): number => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    if (sort === 'created') {
      return right.createdAt.localeCompare(left.createdAt) || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
    }
    return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
  }
}

/** The store facade the Host endpoint and the agent tool share. */
export class StickyWallStore {
  private readonly notes: DomainTable
  private closed = false

  constructor(
    private readonly domain: DomainHandle,
    private readonly maxNotes: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.notes = domain.table('notes')
  }

  /** Open one domain and wrap it in a store. */
  static async open(
    open: (spec: typeof DOMAIN_SPEC) => Promise<DomainHandle>,
    options: { maxNotes: number; seedWelcomeNote: boolean; now?: () => Date },
  ): Promise<StickyWallStore> {
    const domain = await open(DOMAIN_SPEC)
    const store = new StickyWallStore(domain, options.maxNotes, options.now ?? (() => new Date()))
    if (options.seedWelcomeNote) await store.seedWelcomeNote()
    return store
  }

  /** Release the domain handle; later writes fail instead of silently dropping. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.domain.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new WallError('closed', 'The note wall is shutting down.')
  }

  private liveCount(): number {
    let count = 0
    for (const [, note] of this.notes.entries()) if (!(note as Note).archived) count += 1
    return count
  }

  /** Write the one-time welcome note on a brand-new wall. */
  private async seedWelcomeNote(): Promise<void> {
    if (this.notes.size > 0) return
    const stamp = this.now().toISOString()
    const note: Note = {
      id: 'welcome',
      title: '便签墙',
      body: '随手记下一闪而过的灵感，或一件临时的工作。点右下角的 + 新建一张便签；按 ⌘/Ctrl + Enter 保存。',
      tags: ['开始'],
      color: 'yellow',
      pinned: true,
      archived: false,
      createdAt: stamp,
      updatedAt: stamp,
    }
    await this.notes.put(note.id, note)
  }

  /** Every stored note, newest-relevant first; archived ones only on request. */
  list(includeArchived = false, sort: 'pinned' | 'created' | 'updated' = 'pinned'): Note[] {
    this.assertOpen()
    const notes: Note[] = []
    for (const [, note] of this.notes.entries()) {
      const value = note as Note
      if (value.archived && !includeArchived) continue
      notes.push(value)
    }
    return notes.sort(compareNotes(sort))
  }

  /** Create one note from a Client or agent submission. */
  async create(input: NoteInput, id?: string): Promise<Note> {
    this.assertOpen()
    const body = normalizeBody(input?.body)
    const title = normalizeTitle(input?.title)
    if (this.liveCount() >= this.maxNotes) {
      throw new WallError('wall-full', `The wall already holds ${this.maxNotes} notes; archive or delete one first.`, { limit: this.maxNotes })
    }
    const stamp = this.now().toISOString()
    const note: Note = {
      id: id ?? globalThis.crypto.randomUUID(),
      title,
      body,
      tags: normalizeTags(input?.tags),
      color: input?.color === undefined ? 'yellow' : normalizeColor(input.color),
      pinned: input?.pinned === true,
      archived: false,
      createdAt: stamp,
      updatedAt: stamp,
    }
    if (this.notes.get(note.id) !== undefined) throw new WallError('duplicate-id', `A note with id ${JSON.stringify(note.id)} already exists.`)
    await this.notes.put(note.id, note)
    return note
  }

  /** Apply one patch; `updatedAt` moves only when a field actually changed. */
  async update(id: string, patch: NotePatch): Promise<Note> {
    this.assertOpen()
    const current = this.notes.get(id) as Note | undefined
    if (current === undefined) throw new WallError('not-found', `No note with id ${JSON.stringify(id)}.`, { id })
    const next: Note = { ...current }
    if (patch?.body !== undefined) next.body = normalizeBody(patch.body)
    if (patch?.title !== undefined) next.title = normalizeTitle(patch.title)
    if (patch?.tags !== undefined) next.tags = normalizeTags(patch.tags)
    if (patch?.color !== undefined) next.color = normalizeColor(patch.color)
    if (patch?.pinned !== undefined) next.pinned = patch.pinned === true
    if (patch?.archived !== undefined) next.archived = patch.archived === true
    const changed = (['body', 'title', 'color', 'pinned', 'archived'] as const).some((key) => next[key] !== current[key]) ||
      JSON.stringify(next.tags) !== JSON.stringify(current.tags)
    if (!changed) return current
    next.updatedAt = this.now().toISOString()
    return this.notes.update(id, () => next)
  }

  /** Flip the archived flag on a batch; returns the notes that actually moved. */
  async setArchived(ids: string[], archived: boolean): Promise<Note[]> {
    this.assertOpen()
    const changed: Note[] = []
    for (const id of assertIds(ids)) {
      const current = this.notes.get(id) as Note | undefined
      if (current === undefined) throw new WallError('not-found', `No note with id ${JSON.stringify(id)}.`, { id })
      if (current.archived === archived) continue
      const next: Note = { ...current, archived, updatedAt: this.now().toISOString() }
      changed.push(await this.notes.update(id, () => next))
    }
    return changed
  }

  /** Delete a batch; returns the ids that existed and were removed. */
  async remove(ids: string[]): Promise<string[]> {
    this.assertOpen()
    const removed: string[] = []
    for (const id of assertIds(ids)) {
      if ((this.notes.get(id) as Note | undefined) === undefined) continue
      await this.notes.delete(id)
      removed.push(id)
    }
    if (removed.length === 0) throw new WallError('not-found', 'None of the selected notes exist any more.')
    return removed
  }

  /** Permanently remove every archived note. */
  async clearArchived(): Promise<string[]> {
    this.assertOpen()
    const archived = this.list(true).filter((note) => note.archived).map((note) => note.id)
    const removed: string[] = []
    for (const id of archived) {
      await this.notes.delete(id)
      removed.push(id)
    }
    return removed
  }

  /** Compact plain-text digest of the wall for the model-facing tool. */
  summary(limit = 20): { total: number; archived: number; notes: Note[] } {
    this.assertOpen()
    const all = this.list(true, 'updated')
    return {
      total: all.length,
      archived: all.filter((note) => note.archived).length,
      notes: all.slice(0, Math.max(1, Math.min(limit, 50))),
    }
  }
}
