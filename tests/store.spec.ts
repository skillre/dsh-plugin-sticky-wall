import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StickyWallStore, WallError } from '../src/store.js'
import { footprintOf, intersectsReserve } from '../src/layout.js'
import { fileNameOf, parseNoteFile } from '../src/frontmatter.js'
import { LAYOUT_LIMITS, LIMITS, type Note } from '../src/types.js'

/**
 * The store now owns a real directory, so every test gets a real one.
 *
 * There is no in-memory stand-in any more, deliberately: the whole point of the
 * 0.8.0 change is that a note is a file, and a fake would never exercise the
 * atomic write, the frontmatter round-trip or the load path — which is exactly
 * where the failures live. `mkdtemp` under the OS temp directory keeps the tests
 * hermetic and lets them run in parallel.
 */
const created: string[] = []

async function notesDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sticky-wall-store-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true })
})

/**
 * A clock that advances one second per read, so every write gets a distinct
 * timestamp and ordering assertions stay meaningful.
 */
function steppingClock(start = Date.UTC(2026, 0, 1)): () => Date {
  let offset = 0
  return () => new Date(start + offset++ * 1000)
}

interface MakeOptions {
  dir?: string
  seed?: boolean
  maxNotes?: number
  now?: () => Date
  log?: (message: string) => void
}

async function makeStore(options: MakeOptions = {}) {
  const dir = options.dir ?? (await notesDir())
  const store = await StickyWallStore.open({
    notesDir: dir,
    maxNotes: options.maxNotes ?? LIMITS.notes,
    seedWelcomeNote: options.seed ?? false,
    now: options.now ?? steppingClock(),
    ...(options.log === undefined ? {} : { log: options.log }),
  })
  return store
}

/** Every `.md` basename currently on disk, sorted for stable comparison. */
async function mdFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.md')).sort()
}

describe('sticky-wall store', () => {
  it('writes one .md file per note and exposes the directory', async () => {
    const dir = await notesDir()
    const store = await makeStore({ dir })
    // The directory is created on open even when it does not exist yet.
    expect(store.notesDir).toBe(dir)
    const note = await store.create({ body: 'first' })
    expect(store.pathOf(note.id)).toBe(join(dir, fileNameOf(note.id)))
    expect(await mdFiles(dir)).toEqual([fileNameOf(note.id)])
    // A note is a real file: the frontmatter and the body are on disk, not in a
    // JSON blob only this process can read.
    const text = await readFile(store.pathOf(note.id), 'utf8')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text.endsWith('first')).toBe(true)
  })

  it('creates a note with normalized tags and a stamped lifecycle', async () => {
    const store = await makeStore()
    const note = await store.create({ body: 'hello', tags: [' Work ', 'work', 'idea', ''] })
    expect(note.body).toBe('hello')
    expect(note.tags).toEqual(['work', 'idea'])
    expect(note.color).toBe('yellow')
    expect(note.pinned).toBe(false)
    expect(note.archived).toBe(false)
    expect(note.createdAt).toBe(note.updatedAt)
    expect(store.list()).toHaveLength(1)
    expect(store.read(note.id)).toEqual(note)
    expect(store.read('absent')).toBeNull()
  })

  it('rejects an empty body, an over-long body and an unknown color', async () => {
    const store = await makeStore()
    await expect(store.create({ body: '   ' })).rejects.toMatchObject({ code: 'empty-body' })
    await expect(store.create({ body: 'x'.repeat(LIMITS.body + 1) })).rejects.toMatchObject({ code: 'body-too-long' })
    await expect(store.create({ body: 'ok', color: 'chartreuse' as never })).rejects.toMatchObject({ code: 'invalid-color' })
    // The file is the address, so an id that cannot be a file name is refused
    // rather than escaped into a path.
    await expect(store.create({ body: 'ok' }, '../escape')).rejects.toMatchObject({ code: 'invalid-ids' })
  })

  it('keeps the body byte for byte, with no trim and no reflow', async () => {
    // The card-height estimate walks this text line by line, so a `trim()` here
    // would change every card's geometry; and a note's own leading indentation
    // and trailing blank lines are content, not noise.
    const store = await makeStore()
    const body = '  indented\n\nsecond line\n\ttabbed\n'
    const note = await store.create({ body })
    expect(note.body).toBe(body)
    // A reopen goes through the parser, which must give back exactly the same
    // characters — this is the round-trip the whole file format rests on.
    const reopened = await makeStore({ dir: store.notesDir })
    expect(reopened.read(note.id)?.body).toBe(body)
  })

  it('normalizes CRLF line endings without touching anything else', async () => {
    const store = await makeStore()
    const note = await store.create({ body: '  one\r\n two  ' })
    expect(note.body).toBe('  one\n two  ')
  })

  it('preserves every attribute across a reopen through the frontmatter', async () => {
    const store = await makeStore()
    const note = await store.create({
      body: 'round trip',
      title: 'A title: with punctuation',
      tags: ['work', 'idea'],
      color: 'blue',
      pinned: true,
      layout: { x: -123.5, y: 456, rotate: -3.25, width: 'lg' },
    })
    await store.setArchived([note.id], true)
    const before = store.read(note.id)!
    const reopened = await makeStore({ dir: store.notesDir })
    const after = reopened.read(note.id)!
    expect(after).toMatchObject({
      id: before.id,
      title: before.title,
      body: before.body,
      tags: before.tags,
      color: before.color,
      pinned: before.pinned,
      archived: before.archived,
      layout: before.layout,
      createdAt: before.createdAt,
      updatedAt: before.updatedAt,
    })
    // Archived notes are still files, and still load.
    expect(reopened.list(true)).toHaveLength(1)
    expect(reopened.list()).toHaveLength(0)
  })

  it('loads a hand-written note file and keeps its timestamps', async () => {
    const dir = await notesDir()
    await makeStore({ dir })
    // A user (or another agent) editing the directory directly is a supported
    // workflow now, so a file with no frontmatter must still become a note — it
    // takes the file's mtime as its timestamps and the whole text as its body.
    await writeFile(join(dir, 'hand-made.md'), 'written by hand\n', 'utf8')
    const store = await makeStore({ dir })
    const note = store.read('hand-made')!
    expect(note.body).toBe('written by hand\n')
    expect(note.title).toBe('')
    expect(new Date(note.createdAt).getTime()).toBe((await stat(join(dir, 'hand-made.md'))).mtime.getTime())
  })

  it('loads a note with broken frontmatter, flagging it instead of dropping it', async () => {
    // Fail-soft is the old storage domain's `backup-and-skip` contract: a mangled
    // YAML line must cost the user their colour, never their note.
    const dir = await notesDir()
    await makeStore({ dir })
    await writeFile(join(dir, 'mangled.md'), '---\nthis is not yaml\ncolor: pink\n---\n\nstill here\n', 'utf8')
    const store = await makeStore({ dir })
    const note = store.read('mangled')
    expect(note).not.toBeNull()
    expect(note?.metaError).toBe('malformed-frontmatter')
    // The body is everything after the closing delimiter, minus the one
    // separator newline — so the note's own text survives even though its
    // attributes did not.
    expect(note?.body).toBe('still here\n')
    expect(store.list()).toHaveLength(1)
  })

  it('preserves unknown frontmatter keys through a write', async () => {
    const dir = await notesDir()
    await makeStore({ dir })
    await writeFile(join(dir, 'extras.md'), '---\nid: extras\ncolor: green\ndue: 2026-01-01\n---\n\nbody\n', 'utf8')
    const store = await makeStore({ dir })
    expect(store.read('extras')?.extra).toEqual({ due: '2026-01-01' })
    await store.update('extras', { title: 'Renamed' })
    // A write must not silently destroy a key this build does not understand.
    const text = await readFile(join(dir, 'extras.md'), 'utf8')
    expect(text).toContain('due:')
    expect(text).toContain('2026-01-01')
    expect(store.read('extras')?.extra).toEqual({ due: '2026-01-01' })
    // And the metaError of a suspect file rides along untouched, too.
    await writeFile(join(dir, 'suspect.md'), '---\nbad line\n---\n\nsuspect body\n', 'utf8')
    const reloaded = await makeStore({ dir })
    await reloaded.update('suspect', { body: 'edited' })
    expect(reloaded.read('suspect')?.metaError).toBe('malformed-frontmatter')
  })

  it('skips an oversized note file without losing the rest of the wall', async () => {
    const dir = await notesDir()
    const store = await makeStore({ dir })
    await store.create({ body: 'small' })
    const messages: string[] = []
    await writeFile(join(dir, 'huge.md'), Buffer.alloc(LIMITS.fileBytes + 1, 97))
    const reopened = await makeStore({ dir, log: (message) => messages.push(message) })
    expect(reopened.read('huge')).toBeNull()
    expect(reopened.list()).toHaveLength(1)
    expect(messages.join('\n')).toMatch(/oversized/)
  })

  it('skips files that are not named after a valid note id', async () => {
    const dir = await notesDir()
    await makeStore({ dir })
    await writeFile(join(dir, 'notes.txt'), 'not a note', 'utf8')
    await writeFile(join(dir, '.hidden.md'), 'not a note either', 'utf8')
    const store = await makeStore({ dir })
    expect(store.list(true)).toHaveLength(0)
  })

  it('bumps the revision only when a mutation really changes something', async () => {
    const store = await makeStore()
    expect(store.revision).toBe(0)
    const note = await store.create({ body: 'first' })
    expect(store.revision).toBe(1)
    // A no-op patch, the same placement again, archiving what is already
    // archived and tidying a tidy wall are all non-events: a polling Client must
    // see no reason to re-render.
    await store.update(note.id, { body: 'first' })
    expect(store.revision).toBe(1)
    await store.move(note.id, note.layout!)
    expect(store.revision).toBe(1)
    await store.setArchived([note.id], false)
    expect(store.revision).toBe(1)
    await expect(store.clearArchived()).resolves.toEqual([])
    expect(store.revision).toBe(1)
    await store.arrange()
    const arranged = store.revision
    await expect(store.arrange()).resolves.toEqual([])
    expect(store.revision).toBe(arranged)
    // Real changes each bump it exactly once.
    await store.update(note.id, { body: 'second' })
    expect(store.revision).toBe(arranged + 1)
    await store.setArchived([note.id], true)
    expect(store.revision).toBe(arranged + 2)
    await store.remove([note.id])
    expect(store.revision).toBe(arranged + 3)
  })

  it('keeps one revision bump per batch, not per note', async () => {
    const store = await makeStore()
    const first = await store.create({ body: 'a' })
    const second = await store.create({ body: 'b' })
    const before = store.revision
    // A batch is one user action, so one bump — the Client reconciles the whole
    // mutation result in one pass either way.
    expect(await store.setArchived([first.id, second.id], true)).toHaveLength(2)
    expect(store.revision).toBe(before + 1)
    expect(await store.setArchived([first.id, second.id], false)).toHaveLength(2)
    expect(store.revision).toBe(before + 2)
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
    // And the patch is on disk, not just in memory.
    const reopened = await makeStore({ dir: store.notesDir })
    expect(reopened.read(note.id)?.body).toBe('second')
  })

  it('allows an update to save an empty body', async () => {
    // Clearing the editor is a legitimate edit — the user is retyping the note,
    // or keeping the card for its title alone. Refusing it left the old text on
    // disk and the editor unable to save, which is worse than an empty note.
    const store = await makeStore()
    const note = await store.create({ body: 'delete me later', title: 'Keep' })
    const cleared = await store.update(note.id, { body: '' })
    expect(cleared.body).toBe('')
    expect(cleared.title).toBe('Keep')
    const reopened = await makeStore({ dir: store.notesDir })
    expect(reopened.read(note.id)?.body).toBe('')
    // Creating a note out of nothing is still refused.
    await expect(store.create({ body: '' })).rejects.toMatchObject({ code: 'empty-body' })
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
    // Nothing reached the disk either.
    const onDisk = await Promise.all(
      (await mdFiles(store.notesDir)).map(async (name) => (await readFile(join(store.notesDir, name), 'utf8')).includes('archived: true')),
    )
    expect(onDisk.some(Boolean)).toBe(false)
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
    // The check-then-write pair is one step, so the rejected write left no file.
    expect(await mdFiles(store.notesDir)).toHaveLength(2)
  })

  it('rejects a delete batch naming a missing id without deleting any of it', async () => {
    const store = await makeStore()
    const first = await store.create({ body: 'first' })
    const second = await store.create({ body: 'second' })
    await expect(store.remove([first.id, 'nope'])).rejects.toMatchObject({ code: 'not-found' })
    expect(store.list().map((note) => note.id).sort()).toEqual([first.id, second.id].sort())
    expect(await mdFiles(store.notesDir)).toEqual([fileNameOf(first.id), fileNameOf(second.id)].sort())
  })

  it('returns an empty result when clearing a wall with nothing archived', async () => {
    const store = await makeStore()
    await store.create({ body: 'live' })
    await expect(store.clearArchived()).resolves.toEqual([])
  })

  it('accepts exactly the bulk limit and rejects one more', async () => {
    const store = await makeStore()
    const ids: string[] = []
    for (let index = 0; index < LIMITS.bulk; index += 1) ids.push((await store.create({ body: `note ${index}` })).id)
    await expect(store.remove(ids)).resolves.toHaveLength(LIMITS.bulk)
    await expect(store.remove([...ids, 'one-more'])).rejects.toMatchObject({ code: 'too-many-ids' })
    expect(await mdFiles(store.notesDir)).toEqual([])
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
    // Clearing archived notes removes their files, not just their records.
    expect(await mdFiles(store.notesDir)).toEqual([fileNameOf(keep.id)])
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
    // The seed is a real note file like any other.
    expect(await mdFiles(seeded.notesDir)).toEqual(['welcome.md'])
    const dir = await notesDir()
    const store = await makeStore({ dir })
    await store.create({ body: 'mine' })
    const reopened = await makeStore({ dir, seed: true })
    expect(reopened.list()).toHaveLength(1)
  })

  it('moves a card without touching its content timestamp', async () => {
    const store = await makeStore()
    const note = await store.create({ body: 'draggable' })
    // A created note is PLACED, not left with a null layout: null means "derive a
    // position from my index", and that spiral grows outward, so the user's next
    // capture could land off screen. See `places a new note in a free gap`.
    expect(note.layout).not.toBeNull()
    const moved = await store.move(note.id, { x: 120, y: 64, rotate: 3, width: 'lg' })
    expect(moved.layout).toEqual({ x: 120, y: 64, rotate: 3, width: 'lg' })
    // Rearranging a wall is not editing a note, so a "by updated" sort must not
    // reshuffle just because a card was dragged.
    expect(moved.updatedAt).toBe(note.updatedAt)
    // The placement is on disk, so a reopen shows the same arrangement.
    const reopened = await makeStore({ dir: store.notesDir })
    expect(reopened.read(note.id)?.layout).toEqual({ x: 120, y: 64, rotate: 3, width: 'lg' })
  })

  it('places a new note in a free gap instead of leaving its layout null', async () => {
    // The user-facing bug: creating from the centre capture field put the card
    // somewhere far from the field, so the capture looked like it had failed.
    // The Host now assigns the nearest free spot at creation time.
    const store = await makeStore()
    const first = await store.create({ body: 'first' })
    expect(first.layout).not.toBeNull()
    const second = await store.create({ body: 'second' })
    expect(second.layout).not.toBeNull()
    // Two cards must not be stacked on each other.
    expect(second.layout).not.toEqual(first.layout)
    // Both are outside the centrepiece's reserved rectangle.
    for (const note of [first, second]) {
      expect(intersectsReserve(footprintOf(note, note.layout!))).toBe(false)
    }
  })

  it('honours an explicit layout instead of placing the note itself', async () => {
    // The agent tool and a drag both submit a real placement; the free-spot search
    // must not override it.
    const store = await makeStore()
    const note = await store.create({ body: 'placed', layout: { x: 900, y: -700, rotate: 2, width: 'sm' } })
    expect(note.layout).toEqual({ x: 900, y: -700, rotate: 2, width: 'sm' })
  })

  it('accepts a zoom-corrected centre reserve and keeps cards out of it', async () => {
    const store = await makeStore()
    // A deeply zoomed-out view covers far more world space, so its reserve is
    // bigger; the placement must respect the bigger rectangle.
    const wide = { halfWidth: 900, halfHeight: 500 }
    const note = await store.create({ body: 'zoomed out' }, undefined, { centreReserve: wide })
    expect(note.layout).not.toBeNull()
    expect(intersectsReserve(footprintOf(note, note.layout!), wide)).toBe(false)
  })

  it('clamps an out-of-range placement and treats a repeat move as a no-op', async () => {
    const store = await makeStore()
    const note = await store.create({ body: 'bounded' })
    const moved = await store.move(note.id, { x: 99_999, y: -99_999, rotate: 999, width: 'md' })
    expect(moved.layout?.x).toBe(LAYOUT_LIMITS.coord)
    expect(moved.layout?.y).toBe(-LAYOUT_LIMITS.coord)
    expect(moved.layout?.rotate).toBe(LAYOUT_LIMITS.rotate)
    // The same placement again returns the stored record instead of rewriting.
    const again = await store.move(note.id, moved.layout!)
    expect(again).toBe(moved)
  })

  it('rejects a move for a missing note and a non-numeric placement', async () => {
    const store = await makeStore()
    await expect(store.move('nope', { x: 1, y: 2, rotate: 0, width: 'md' })).rejects.toMatchObject({ code: 'not-found' })
    const note = await store.create({ body: 'x' })
    await expect(store.move(note.id, { x: Number.NaN, y: 0, rotate: 0, width: 'md' })).rejects.toMatchObject({ code: 'invalid-layout' })
  })

  it('accepts a placement on create so a new card can land where it was dropped', async () => {
    const store = await makeStore()
    const note = await store.create({ body: 'placed', layout: { x: 40, y: 50, rotate: -2, width: 'sm' } })
    expect(note.layout).toEqual({ x: 40, y: 50, rotate: -2, width: 'sm' })
  })

  it('refuses to create over a note file the loader skipped', async () => {
    // A note file too large to load is absent from the cache but present on
    // disk. Creating a note with that id would rename straight over it and
    // destroy a file the user still has.
    const dir = await notesDir()
    const store = await makeStore({ dir })
    await writeFile(join(dir, 'oversized.md'), Buffer.alloc(LIMITS.fileBytes + 1, 97))
    const reopened = await makeStore({ dir })
    expect(reopened.read('oversized')).toBeNull()
    await expect(reopened.create({ body: 'clobber' }, 'oversized')).rejects.toMatchObject({ code: 'duplicate-id' })
    // The original file is still the original file.
    expect((await stat(join(dir, 'oversized.md'))).size).toBe(LIMITS.fileBytes + 1)
  })

  it('refuses a duplicate id instead of overwriting the existing note', async () => {
    const store = await makeStore()
    const note = await store.create({ body: 'original' }, 'fixed-id')
    expect(note.id).toBe('fixed-id')
    await expect(store.create({ body: 'impostor' }, 'fixed-id')).rejects.toMatchObject({ code: 'duplicate-id' })
    expect(store.read('fixed-id')?.body).toBe('original')
  })

  it('tidies every card into a non-overlapping arrangement and only reports real moves', async () => {
    const store = await makeStore()
    for (let index = 0; index < 6; index += 1) await store.create({ body: `note ${index}` })
    const changed = await store.arrange()
    expect(changed.length).toBeGreaterThan(0)
    const placed = store.list()
    for (const note of placed) {
      expect(note.layout).not.toBeNull()
      expect(note.layout?.width).toMatch(/^(sm|md|lg)$/)
    }
    // Coordinates are distinct: two cards never share an exact corner.
    expect(new Set(placed.map((note) => `${String(note.layout?.x)}:${String(note.layout?.y)}`)).size).toBe(placed.length)
    // A second tidy on an already-tidy wall writes nothing.
    await expect(store.arrange()).resolves.toEqual([])
  })

  it('tidies archived notes too, so an archived card cannot overlap a tidied one', async () => {
    // Regression: `arrange` used to pack only the live set, leaving an
    // archived-but-visible note wherever it had been dragged — on top of the
    // freshly tidied cards. Tidy must cover every note the wall can show.
    const store = await makeStore()
    const live = await store.create({ body: 'live note' })
    const archived = await store.create({ body: 'archived note' })
    await store.move(archived.id, { x: 900, y: 900, rotate: 0, width: 'md' })
    await store.setArchived([archived.id], true)
    await store.arrange()
    const all = store.list(true)
    expect(all).toHaveLength(2)
    const archivedAfter = all.find((note) => note.id === archived.id)!
    // The archived card was repacked instead of staying at its dragged corner.
    expect(archivedAfter.layout?.x).not.toBe(900)
    expect(archivedAfter.layout?.y).not.toBe(900)
    expect(all.find((note) => note.id === live.id)?.layout).not.toBeNull()
  })

  it('tidies without bumping updatedAt, so a tidy never reshuffles a by-updated sort', async () => {
    // The move test asserts this for `move`; `arrange` writes through the same
    // path, and a future refactor through `update()` must not start bumping it.
    const store = await makeStore()
    const note = await store.create({ body: 'note' })
    await store.move(note.id, { x: 500, y: 500, rotate: 0, width: 'md' })
    const before = store.list()[0]!
    await store.arrange()
    const after = store.list()[0]!
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(after.layout).not.toEqual(before.layout)
  })

  it('keeps the seeded welcome note placed so a new wall is immediately draggable', async () => {
    const store = await makeStore({ seed: true })
    const welcome = store.list()[0]!
    expect(welcome.layout).not.toBeNull()
    expect(welcome.layout?.width).toBe('md')
  })

  it('writes atomically, leaving no temp file behind', async () => {
    const store = await makeStore()
    const note = await store.create({ body: 'atomic' })
    await store.update(note.id, { body: 'rewritten' })
    // The write goes to `<id>.md.tmp` and is renamed over the target; a leftover
    // temp file would mean a reader could have seen a half-written note.
    expect(await readdir(store.notesDir)).toEqual([fileNameOf(note.id)])
    const text = await readFile(store.pathOf(note.id), 'utf8')
    expect(text.endsWith('rewritten')).toBe(true)
    // ...and the file really does parse back to the note in memory.
    const parsed = parseNoteFile(text, { fallbackId: note.id, fallbackTime: note.createdAt })
    expect(parsed.note.body).toBe('rewritten')
    expect(parsed.note.id).toBe(note.id)
  })

  it('recreates a removed notes directory on the next write', async () => {
    const store = await makeStore()
    await store.create({ body: 'first' })
    await rm(store.notesDir, { recursive: true, force: true })
    const note = await store.create({ body: 'second' })
    expect(await mdFiles(store.notesDir)).toEqual([fileNameOf(note.id)])
  })

  it('reports the wall summary and caps the requested limit', async () => {
    const store = await makeStore()
    await store.create({ body: 'a' })
    const archived = await store.create({ body: 'b' })
    await store.setArchived([archived.id], true)
    const summary = store.summary(500)
    expect(summary.total).toBe(2)
    expect(summary.archived).toBe(1)
    // Far beyond the documented agent limit, the summary still returns the cap.
    expect(summary.notes.length).toBeLessThanOrEqual(LIMITS.listLimit)
  })

  it('closes the store and refuses later writes instead of dropping them', async () => {
    const store = await makeStore()
    await store.create({ body: 'x' })
    await store.close()
    await expect(store.create({ body: 'y' })).rejects.toMatchObject({ code: 'closed' })
    expect(() => store.list()).toThrow(/shutting down/)
    // Closing twice is safe: the Fiber's dispose may run after a failed open.
    await expect(store.close()).resolves.toBeUndefined()
  })

  it('drains queued writes before closing', async () => {
    const store = await makeStore()
    // Start a write and close immediately: the note was acknowledged to the
    // caller, so it has to be on disk even though shutdown overtook it.
    const pending = store.create({ body: 'last words' })
    await store.close()
    const note = await pending
    expect(await mdFiles(store.notesDir)).toEqual([fileNameOf(note.id)])
    expect((await readFile(store.pathOf(note.id), 'utf8')).endsWith('last words')).toBe(true)
  })

  it('surfaces WallError for every documented failure code', async () => {
    // The Client maps these codes onto its own copy, so the exact strings are a
    // contract rather than an implementation detail.
    const store = await makeStore({ maxNotes: 3 })
    const codes: string[] = []
    const capture = async (job: Promise<unknown>): Promise<void> => {
      try {
        await job
      } catch (error) {
        if (error instanceof WallError) codes.push(error.code)
        else throw error
      }
    }
    await capture(store.create({ body: '' }))
    await capture(store.create({ body: 'ok', color: 'nope' as never }))
    await capture(store.update('missing', { body: 'x' }))
    await capture(store.remove([]))
    // Fill the cap, then prove the last code.
    await store.create({ body: 'one' })
    await store.create({ body: 'two' })
    await store.create({ body: 'three' })
    await capture(store.create({ body: 'four' }))
    expect(codes).toEqual(['empty-body', 'invalid-color', 'not-found', 'invalid-ids', 'wall-full'])
  })
})

describe('sticky-wall store note type', () => {
  it('never invents attributes the frontmatter did not carry', async () => {
    const store = await makeStore()
    const note: Note = await store.create({ body: 'plain' })
    expect(note).not.toHaveProperty('extra')
    expect(note.metaError).toBeUndefined()
  })
})
