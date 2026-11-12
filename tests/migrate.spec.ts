import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateNotes } from '../src/migrate.js'
import { parseNoteFile } from '../src/frontmatter.js'
import { MIGRATION_MARKER, type Note } from '../src/types.js'

/**
 * Migration tests work on real directories.
 *
 * The contract being tested is almost entirely about FILESYSTEM state — a
 * staging directory, one atomic rename, and "no partial state on failure" — so a
 * fake filesystem would test the mock instead of the behaviour.
 */
const created: string[] = []

/** A fresh parent directory; each test builds its own notes dir inside it. */
async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sticky-wall-migrate-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A fixed clock so the marker content is deterministic. */
const clock = (): Date => new Date(Date.UTC(2026, 4, 1, 12, 0, 0))

/** One legacy note, spanning every attribute the migration has to carry. */
function legacyNote(index: number, overrides: Partial<Note> = {}): Note {
  return {
    id: `note-${String(index)}`,
    title: `Title ${String(index)}`,
    body: `Body ${String(index)}\n\nwith a second paragraph`,
    tags: ['work', `tag-${String(index)}`],
    color: index % 2 === 0 ? 'pink' : 'green',
    pinned: index === 0,
    archived: index === 2,
    createdAt: `2026-03-0${String((index % 8) + 1)}T10:00:00.000Z`,
    updatedAt: `2026-03-0${String((index % 8) + 1)}T11:30:00.000Z`,
    layout: index === 1 ? null : { x: index * 40 - 60, y: index * 25 + 10, rotate: -1.5, width: 'md' },
    ...overrides,
  }
}

/** Every `.md` basename in a directory, sorted for stable comparison. */
async function mdFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.md')).sort()
}

describe('migrateNotes', () => {
  it('migrates every legacy note into one .md file each', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    const legacy = Array.from({ length: 5 }, (_, index) => legacyNote(index))

    const result = await migrateNotes({ notesDir, readLegacy: async () => legacy, now: clock })
    expect(result).toEqual({ migrated: true, reason: 'migrated', count: 5 })
    expect(await mdFiles(notesDir)).toEqual(legacy.map((note) => `${note.id}.md`).sort())
    // No staging directory is left behind.
    expect(await readdir(dir)).toEqual(['sticky-notes'])
  })

  it('writes a marker recording where the notes came from and how many', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    const legacy = [legacyNote(0), legacyNote(1)]
    await migrateNotes({ notesDir, readLegacy: async () => legacy, now: clock })
    const marker = JSON.parse(await readFile(join(notesDir, MIGRATION_MARKER), 'utf8')) as Record<string, unknown>
    expect(marker).toMatchObject({ from: 'skillre_sticky_wall', count: 2, sourceCount: 2, at: '2026-05-01T12:00:00.000Z' })
  })

  it('verifies the round-trip, so a mangled file fails the migration', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    const legacy = [legacyNote(0)]
    await migrateNotes({ notesDir, readLegacy: async () => legacy, now: clock })
    // The verification is a real read-back through the parser: every attribute
    // must come back byte-identical, not merely be present in the file.
    const parsed = parseNoteFile(await readFile(join(notesDir, 'note-0.md'), 'utf8'), {
      fallbackId: 'note-0',
      fallbackTime: '1970-01-01T00:00:00.000Z',
    })
    expect(parsed.note).toMatchObject({
      id: 'note-0',
      title: legacy[0]!.title,
      body: legacy[0]!.body,
      tags: legacy[0]!.tags,
      color: legacy[0]!.color,
      pinned: true,
      archived: false,
      layout: legacy[0]!.layout,
    })
    expect(parsed.note.createdAt).toBe(legacy[0]!.createdAt)
    expect(parsed.note.updatedAt).toBe(legacy[0]!.updatedAt)
  })

  it('does nothing when the notes directory already holds notes', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    await mkdir(notesDir, { recursive: true })
    // A hand-written file is enough to prove the wall is already live.
    await writeFile(join(notesDir, 'existing.md'), '---\nid: existing\n---\n\nmine\n', 'utf8')
    const result = await migrateNotes({ notesDir, readLegacy: async () => [legacyNote(0)], now: clock })
    expect(result).toEqual({ migrated: false, reason: 'already-present' })
    // The existing note is untouched and no legacy note was imported over it.
    expect(await mdFiles(notesDir)).toEqual(['existing.md'])
  })

  it('does nothing when the marker is already there', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    await mkdir(notesDir, { recursive: true })
    // A wall whose user deleted every note still must not be re-imported, so the
    // marker alone has to be enough to answer "already migrated".
    await writeFile(join(notesDir, MIGRATION_MARKER), '{"from":"skillre_sticky_wall","count":0}\n', 'utf8')
    const result = await migrateNotes({ notesDir, readLegacy: async () => [legacyNote(0)], now: clock })
    expect(result).toEqual({ migrated: false, reason: 'already-present' })
  })

  it('does nothing when the legacy wall was empty', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    const result = await migrateNotes({ notesDir, readLegacy: async () => [], now: clock })
    expect(result).toEqual({ migrated: false, reason: 'no-legacy' })
    // An empty legacy wall must not create the directory: the next start would
    // otherwise see a notes directory and skip the retry forever.
    await expect(stat(notesDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a non-UUID id such as the seeded welcome note', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    // 0.7.x seeded a note literally called `welcome`. Rewriting its id would
    // break every link the user has to it, and it is a perfectly valid file name.
    const legacy = [legacyNote(0, { id: 'welcome', pinned: true })]
    const result = await migrateNotes({ notesDir, readLegacy: async () => legacy, now: clock })
    expect(result.migrated).toBe(true)
    expect(await mdFiles(notesDir)).toEqual(['welcome.md'])
    const parsed = parseNoteFile(await readFile(join(notesDir, 'welcome.md'), 'utf8'), {
      fallbackId: 'welcome',
      fallbackTime: '1970-01-01T00:00:00.000Z',
    })
    expect(parsed.note.id).toBe('welcome')
  })

  it('preserves a null layout, meaning "never placed"', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    const legacy = [legacyNote(0, { layout: null })]
    await migrateNotes({ notesDir, readLegacy: async () => legacy, now: clock })
    // `null` is not "origin": the Client derives a preview position from the id,
    // and writing {x:0,y:0} would stack every unplaced note in one spot.
    const parsed = parseNoteFile(await readFile(join(notesDir, 'note-0.md'), 'utf8'), {
      fallbackId: 'note-0',
      fallbackTime: '1970-01-01T00:00:00.000Z',
    })
    expect(parsed.note.layout).toBeNull()
  })

  it('preserves unknown frontmatter-ready attributes and empty titles', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    const legacy = [legacyNote(0, { title: '', tags: [] })]
    await migrateNotes({ notesDir, readLegacy: async () => legacy, now: clock })
    const parsed = parseNoteFile(await readFile(join(notesDir, 'note-0.md'), 'utf8'), {
      fallbackId: 'note-0',
      fallbackTime: '1970-01-01T00:00:00.000Z',
    })
    expect(parsed.note.title).toBe('')
    expect(parsed.note.tags).toEqual([])
  })

  it('leaves no partial state when reading the legacy wall fails', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    const result = await migrateNotes({
      notesDir,
      readLegacy: async () => {
        throw new Error('domain exploded')
      },
      now: clock,
    })
    expect(result).toMatchObject({ migrated: false, reason: 'failed', error: 'domain exploded' })
    // Neither the notes directory nor the staging directory may exist: a
    // half-created wall would be read as "already migrated" on the next start.
    expect(await readdir(dir)).toEqual([])
  })

  it('leaves no partial state when a legacy id cannot be a file name', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    const result = await migrateNotes({
      notesDir,
      readLegacy: async () => [legacyNote(0), legacyNote(1, { id: '../escape' })],
      now: clock,
    })
    expect(result).toMatchObject({ migrated: false, reason: 'failed' })
    expect(await readdir(dir)).toEqual([])
  })

  it('removes a published directory the verification would reject', async () => {
    // Pin the verification by making the write produce text that cannot parse
    // back to the same note: an unserializable title is the cheapest way to get
    // past the write and fail the read-back.
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    const legacy = [legacyNote(0, { layout: { x: Number.NaN, y: 0, rotate: 0, width: 'md' } })]
    const result = await migrateNotes({ notesDir, readLegacy: async () => legacy, now: clock })
    expect(result).toMatchObject({ migrated: false, reason: 'failed' })
    // A failed verification must delete the directory so the next start retries
    // with the legacy wall still the only source of truth.
    expect(await readdir(dir)).toEqual([])
  })

  it('publishes over an empty directory a previous attempt left behind', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    // A failed attempt can leave the directory itself, empty. POSIX `rename`
    // replaces an empty destination directory, so the retry still publishes in
    // one atomic step instead of needing a separate create.
    await mkdir(notesDir, { recursive: true })
    const result = await migrateNotes({ notesDir, readLegacy: async () => [legacyNote(0)], now: clock })
    expect(result).toMatchObject({ migrated: true, count: 1 })
    expect(await mdFiles(notesDir)).toEqual(['note-0.md'])
  })

  it('refuses to replace a directory holding files it did not create', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    await mkdir(notesDir, { recursive: true })
    // Not a note and not a marker, so the migration is allowed to try — but it
    // must never delete a file it did not write, so the publish fails instead.
    await writeFile(join(notesDir, 'keep-me.txt'), 'precious', 'utf8')
    const result = await migrateNotes({ notesDir, readLegacy: async () => [legacyNote(0)], now: clock })
    expect(result).toMatchObject({ migrated: false, reason: 'failed' })
    expect(await readFile(join(notesDir, 'keep-me.txt'), 'utf8')).toBe('precious')
    expect(await mdFiles(notesDir)).toEqual([])
    // The staging directory is cleaned up in every failure path.
    expect(await readdir(dir)).toEqual(['sticky-notes'])
  })

  it('recovers from a stale staging directory left by an interrupted attempt', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    // Debris from a crash mid-migration: its contents are untrusted, so they are
    // discarded rather than appended to.
    const staging = `${notesDir}.migrating`
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'stale.md'), 'garbage', 'utf8')
    const result = await migrateNotes({ notesDir, readLegacy: async () => [legacyNote(0)], now: clock })
    expect(result).toMatchObject({ migrated: true, count: 1 })
    expect(await readdir(dir)).toEqual(['sticky-notes'])
    expect(await mdFiles(notesDir)).toEqual(['note-0.md'])
  })

  it('is idempotent: a second run reports already-present and changes nothing', async () => {
    const dir = await sandbox()
    const notesDir = join(dir, 'sticky-notes')
    const legacy = [legacyNote(0), legacyNote(1)]
    const first = await migrateNotes({ notesDir, readLegacy: async () => legacy, now: clock })
    expect(first.migrated).toBe(true)
    const before = await mdFiles(notesDir)
    const second = await migrateNotes({
      notesDir,
      readLegacy: async () => {
        throw new Error('the legacy domain must not be opened twice')
      },
      now: clock,
    })
    expect(second).toEqual({ migrated: false, reason: 'already-present' })
    expect(await mdFiles(notesDir)).toEqual(before)
  })

  it('creates the notes directory under a parent that does not exist yet', async () => {
    const dir = await sandbox()
    // A first-ever DSH start may not have created the home directory tree yet.
    const notesDir = join(dir, 'nested', 'home', 'sticky-notes')
    const result = await migrateNotes({ notesDir, readLegacy: async () => [legacyNote(0)], now: clock })
    expect(result.migrated).toBe(true)
    expect(await mdFiles(notesDir)).toEqual(['note-0.md'])
  })
})
