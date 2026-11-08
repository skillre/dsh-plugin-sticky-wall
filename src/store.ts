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
import { arrangeLayouts, clampLayout, findFreeLayout, normalizeReserve, normalizeWidth, sameLayout } from './layout.js'
import {
  CENTRE_RESERVE,
  COLORS,
  WIDTHS,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  LIMITS,
  type CentreReserve,
  type Note,
  type NoteColor,
  type NoteInput,
  type NoteLayout,
  type NotePatch,
} from './types.js'

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
    // `null` means "never placed": the Client derives a preview position from
    // the note id. A stored layout is owned by the Host, so a wall opened in
    // two windows shows the same arrangement.
    layout: z
      .object({
        x: z.number(),
        y: z.number(),
        rotate: z.number(),
        width: z.enum(WIDTHS),
      })
      .nullable()
      .default(null),
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

/** Validate and clamp a submitted placement; `null` clears it back to derived. */
function normalizeLayout(raw: unknown): NoteLayout | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') throw new WallError('invalid-layout', 'A note placement must be an object.')
  const value = raw as Record<string, unknown>
  const x = Number(value.x)
  const y = Number(value.y)
  const rotate = Number(value.rotate ?? 0)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(rotate)) {
    throw new WallError('invalid-layout', 'A note placement needs finite x, y and rotate values.')
  }
  return clampLayout({ x, y, rotate, width: normalizeWidth(value.width) })
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
  /**
   * Store-level mutation chain.
   *
   * The storage domain serializes its own writes, but a read-then-write pair
   * (the `maxNotes` check followed by the `put`) is two steps: two concurrent
   * creates at the boundary would both read the pre-write count and both
   * succeed. Every mutation therefore runs on this chain, so each check and its
   * write are one indivisible step.
   */
  private chain: Promise<unknown> = Promise.resolve()

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

  /** Queue one mutation so its checks and writes cannot interleave with another. */
  private mutate<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job)
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private liveCount(): number {
    let count = 0
    for (const [, note] of this.notes.entries()) if (!(note as Note).archived) count += 1
    return count
  }

  /**
   * Reject a write that would take the live (non-archived) note count past
   * `maxNotes`.
   *
   * Every path that can make a note live goes through this — `create`, an
   * `update` that unarchives, and a batch restore — because the documented cap
   * is an invariant of the wall, not a hint on the create form.
   */
  private assertRoom(incomingLive: number): void {
    if (incomingLive <= 0) return
    const projected = this.liveCount() + incomingLive
    if (projected > this.maxNotes) {
      throw new WallError('wall-full', `The wall already holds ${this.maxNotes} notes; archive or delete one first.`, {
        limit: this.maxNotes,
        projected,
      })
    }
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
      // The one note the plugin places itself, so a brand-new wall opens with a
      // card that is obviously meant to be dragged.
      //
      // The position is chosen to be OUTSIDE the centrepiece reserve. It used to
      // be {120, 96}, which is squarely inside the reserved rectangle: a brand-new
      // wall therefore opened with the welcome note sitting on top of the capture
      // field, and every overlap assertion had to special-case it. Placing it in
      // the first ring keeps the invariant true from the very first note.
      layout: { x: 300, y: -420, rotate: -1.6, width: 'md' },
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

  /**
   * Create one note from a Client or agent submission.
   *
   * `options.centreReserve` is the Client's zoom-corrected version of the clear
   * rectangle around the wall's centrepiece. It only affects a note created
   * WITHOUT a layout: the Host places that note in the nearest free gap, which
   * is what makes a capture from the centre field appear right next to the field
   * instead of wherever an index-derived spiral happened to reach.
   */
  async create(input: NoteInput, id?: string, options: { centreReserve?: CentreReserve | undefined } = {}): Promise<Note> {
    this.assertOpen()
    return this.mutate(() => this.createNow(input, id, options))
  }

  private async createNow(input: NoteInput, id?: string, options: { centreReserve?: CentreReserve | undefined } = {}): Promise<Note> {
    const body = normalizeBody(input?.body)
    const title = normalizeTitle(input?.title)
    this.assertRoom(1)
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
      layout: input?.layout === undefined ? null : normalizeLayout(input.layout),
    }
    if (this.notes.get(note.id) !== undefined) throw new WallError('duplicate-id', `A note with id ${JSON.stringify(note.id)} already exists.`)
    // A note with no explicit placement gets the nearest free spot on the wall,
    // not `null`. `null` means "derive a position from my index", and that spiral
    // grows outward — so the user's tenth capture could land a screen away from
    // where they were looking, which reads as the capture having failed.
    if (note.layout === null) {
      note.layout = findFreeLayout(note, this.list(true, 'pinned'), { centreReserve: normalizeReserve(options.centreReserve ?? CENTRE_RESERVE) })
    }
    await this.notes.put(note.id, note)
    return note
  }

  /** Apply one patch; `updatedAt` moves only when a field actually changed. */
  async update(id: string, patch: NotePatch): Promise<Note> {
    this.assertOpen()
    return this.mutate(() => this.updateNow(id, patch))
  }

  private async updateNow(id: string, patch: NotePatch): Promise<Note> {
    const current = this.notes.get(id) as Note | undefined
    if (current === undefined) throw new WallError('not-found', `No note with id ${JSON.stringify(id)}.`, { id })
    const next: Note = { ...current }
    if (patch?.body !== undefined) next.body = normalizeBody(patch.body)
    if (patch?.title !== undefined) next.title = normalizeTitle(patch.title)
    if (patch?.tags !== undefined) next.tags = normalizeTags(patch.tags)
    if (patch?.color !== undefined) next.color = normalizeColor(patch.color)
    if (patch?.pinned !== undefined) next.pinned = patch.pinned === true
    if (patch?.archived !== undefined) next.archived = patch.archived === true
    // Restoring an archived note makes it live again, so it must fit the cap.
    if (current.archived && !next.archived) this.assertRoom(1)
    const changed = (['body', 'title', 'color', 'pinned', 'archived'] as const).some((key) => next[key] !== current[key]) ||
      JSON.stringify(next.tags) !== JSON.stringify(current.tags)
    if (!changed) return current
    next.updatedAt = this.now().toISOString()
    return this.notes.update(id, () => next)
  }

  /**
   * Flip the archived flag on a batch; returns the notes that actually moved.
   *
   * Every id is resolved BEFORE the first write: a missing id rejects the whole
   * request, so a bad batch cannot leave half the selection archived while the
   * Client still believes the mutation failed.
   */
  async setArchived(ids: string[], archived: boolean): Promise<Note[]> {
    this.assertOpen()
    return this.mutate(() => this.setArchivedNow(ids, archived))
  }

  private async setArchivedNow(ids: string[], archived: boolean): Promise<Note[]> {
    const selected = assertIds(ids)
    const targets: Note[] = []
    for (const id of selected) {
      const current = this.notes.get(id) as Note | undefined
      if (current === undefined) throw new WallError('not-found', `No note with id ${JSON.stringify(id)}.`, { id })
      if (current.archived !== archived) targets.push(current)
    }
    // A restore batch makes every target live; check the whole batch up front so
    // a partial restore can never exceed the cap.
    if (!archived) this.assertRoom(targets.length)
    const changed: Note[] = []
    for (const current of targets) {
      const next: Note = { ...current, archived, updatedAt: this.now().toISOString() }
      changed.push(await this.notes.update(current.id, () => next))
    }
    return changed
  }

  /**
   * Delete a batch; returns the ids that were removed.
   *
   * The whole selection is resolved before the first delete, so a request
   * naming an absent note changes nothing: a caller is never told the batch
   * failed while part of it was already applied. Batch semantics match
   * {@link setArchived}.
   */
  async remove(ids: string[]): Promise<string[]> {
    this.assertOpen()
    return this.mutate(() => this.removeNow(ids))
  }

  private async removeNow(ids: string[]): Promise<string[]> {
    const selected = assertIds(ids)
    for (const id of selected) {
      if ((this.notes.get(id) as Note | undefined) === undefined) throw new WallError('not-found', `No note with id ${JSON.stringify(id)}.`, { id })
    }
    const removed: string[] = []
    for (const id of selected) {
      await this.notes.delete(id)
      removed.push(id)
    }
    return removed
  }

  /**
   * Move one card on the free canvas.
   *
   * Moving is its own operation rather than an `update` patch: it deliberately
   * does NOT bump `updatedAt`, because rearranging a wall is not editing a
   * note's content and must not reshuffle a "by updated" sort. The write is
   * still serialised on the mutation chain so two drags cannot race.
   */
  async move(id: string, layout: NoteLayout): Promise<Note> {
    this.assertOpen()
    return this.mutate(() => this.moveNow(id, layout))
  }

  private async moveNow(id: string, layout: NoteLayout): Promise<Note> {
    const current = this.notes.get(id) as Note | undefined
    if (current === undefined) throw new WallError('not-found', `No note with id ${JSON.stringify(id)}.`, { id })
    const next = normalizeLayout(layout)
    if (sameLayout(current.layout, next)) return current
    return this.notes.update(id, () => ({ ...current, layout: next }))
  }

  /**
   * Tidy the wall: repack every note into a deterministic shelf arrangement.
   *
   * Returns only the notes that actually moved, so the Client can reconcile
   * without refetching the whole wall, and pressing tidy on an already-tidy
   * wall is a no-op instead of a write storm.
   */
  async arrange(options: { centreReserve?: CentreReserve | undefined } = {}): Promise<Note[]> {
    this.assertOpen()
    return this.mutate(() => this.arrangeNow(options))
  }

  private async arrangeNow(options: { centreReserve?: CentreReserve | undefined } = {}): Promise<Note[]> {
    // Every note, archived ones included. Packing only the live set left an
    // archived-but-visible card at its dragged position, on top of the freshly
    // tidied ones — the wall has to be tidy in every filter, not just the
    // default one.
    const current = this.list(true, 'pinned')
    const planned = arrangeLayouts(current, { centreReserve: normalizeReserve(options.centreReserve ?? CENTRE_RESERVE) })
    const changed: Note[] = []
    for (const note of current) {
      const target = planned.get(note.id)
      if (target === undefined || sameLayout(note.layout, target)) continue
      changed.push(await this.notes.update(note.id, () => ({ ...note, layout: target })))
    }
    return changed
  }

  /**
   * Permanently remove every archived note.
   *
   * The archived set is read once and deleted in order; a delete failure stops
   * the sweep and surfaces, leaving the remaining archived notes intact rather
   * than reporting a clean sweep that did not happen.
   */
  async clearArchived(): Promise<string[]> {
    this.assertOpen()
    return this.mutate(() => this.clearArchivedNow())
  }

  private async clearArchivedNow(): Promise<string[]> {
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
