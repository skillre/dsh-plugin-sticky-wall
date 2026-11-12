/**
 * One-time migration from the 0.7.x storage domain to real `.md` files.
 *
 * The old build kept a wall in a JSON storage domain. 0.8.0 stores one file per
 * note instead, so an existing user's wall has to be carried across exactly once,
 * without losing a note and without ever leaving a half-migrated directory that
 * the next start would mistake for a finished one.
 *
 * The whole design follows from one requirement: **the notes directory must
 * never be observable in a partial state.** So the notes are written into a
 * sibling staging directory and published with a single `rename`, which is
 * atomic within one parent directory. A crash before the rename leaves the legacy
 * wall untouched and the staging directory removable; a crash after it leaves a
 * complete wall that the marker then declares migrated.
 *
 * Nothing here is on the hot path, and nothing here runs when the directory
 * already holds notes: a user who has been on 0.8.0 for months must not have a
 * stale legacy domain re-imported over edits they have made since.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileNameOf, idOfFile, isNoteId, parseNoteFile, serializeNoteFile } from './frontmatter.js'
import { LEGACY_DOMAIN_NAME, LIMITS, MIGRATION_MARKER, type Note } from './types.js'

/** The staging directory the migration writes into before publishing. */
function stagingDirOf(notesDir: string): string {
  return `${notesDir}.migrating`
}

/** What one migration attempt did, and why it did nothing when it did nothing. */
export interface MigrateResult {
  /** True only when this call published the notes directory. */
  migrated: boolean
  /**
   * Stable outcome: `migrated`, `already-present`, `no-legacy`, or `failed`.
   *
   * `already-present` is the normal steady state, not an error — it is what a
   * second start reports after a successful migration.
   */
  reason: string
  /** Notes carried across, set only when `migrated` is true. */
  count?: number
  /** Human-readable cause, set only when `reason` is `failed`. */
  error?: string
}

/** Everything the migration needs; `now` is injectable for a deterministic marker. */
export interface MigrateOptions {
  /** Destination directory, `<DSH_HOME>/sticky-notes`. */
  notesDir: string
  /** Drains the legacy storage domain; resolves to every note it held. */
  readLegacy: () => Promise<Note[]>
  /** Clock for the marker's `at` field. */
  now?: (() => Date) | undefined
}

/** True when the directory already holds something this migration must not touch. */
async function isAlreadyPresent(notesDir: string): Promise<boolean> {
  let entries: string[]
  try {
    entries = await readdir(notesDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // No directory, or the path is not a directory at all: nothing to protect.
    // Any other failure is a real I/O problem and is reported as a failure by
    // the caller rather than being read as "empty".
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
  return entries.some((name) => name === MIGRATION_MARKER || idOfFile(name) !== null)
}

/** Two timestamps name the same instant, tolerating format-only differences. */
function sameInstant(left: string, right: string): boolean {
  if (left === right) return true
  const a = new Date(left).getTime()
  const b = new Date(right).getTime()
  return !Number.isNaN(a) && !Number.isNaN(b) && a === b
}

/** One field-by-field read-back comparison between the legacy note and its file. */
function sameNote(expected: Note, actual: Note): boolean {
  return (
    expected.id === actual.id &&
    expected.title === actual.title &&
    expected.body === actual.body &&
    expected.color === actual.color &&
    expected.pinned === actual.pinned &&
    expected.archived === actual.archived &&
    expected.tags.length === actual.tags.length &&
    expected.tags.every((tag, index) => tag === actual.tags[index]) &&
    sameLayout(expected.layout, actual.layout) &&
    sameInstant(expected.createdAt, actual.createdAt) &&
    sameInstant(expected.updatedAt, actual.updatedAt)
  )
}

/** Compare two placements, treating two `null`s as equal. */
function sameLayout(left: Note['layout'], right: Note['layout']): boolean {
  if (left === null || right === null) return left === right
  return left.x === right.x && left.y === right.y && left.rotate === right.rotate && left.width === right.width
}

/** Remove the staging directory, ignoring the case where it is already gone. */
async function discardStaging(staging: string): Promise<void> {
  await rm(staging, { recursive: true, force: true })
}

/**
 * Move the legacy notes into `notesDir`, or explain why there was nothing to do.
 *
 * Never throws for an expected outcome: a failed migration is reported as
 * `{ migrated: false, reason: 'failed' }` with the notes directory left absent,
 * so the next start retries with the legacy wall still intact.
 */
export async function migrateNotes(options: MigrateOptions): Promise<MigrateResult> {
  const notesDir = resolve(options.notesDir)
  const staging = stagingDirOf(notesDir)
  let renamed = false
  try {
    if (await isAlreadyPresent(notesDir)) return { migrated: false, reason: 'already-present' }

    const legacy = await options.readLegacy()
    if (legacy.length === 0) return { migrated: false, reason: 'no-legacy' }

    // The id becomes a file name, so it has to be one this build would accept
    // from disk. Ids are NOT filtered by shape otherwise: a 0.7.x wall could hold
    // `welcome` (the seeded note does), and rewriting it to a UUID would break
    // every link the user has to that note.
    const invalid = legacy.find((note) => !isNoteId(note.id))
    if (invalid !== undefined) throw new Error(`legacy note id ${JSON.stringify(invalid.id)} is not a valid file name`)

    // A leftover staging directory is debris from an interrupted attempt; its
    // contents are untrusted, so it is discarded rather than resumed into.
    await discardStaging(staging)
    await mkdir(dirname(notesDir), { recursive: true })
    await mkdir(staging, { recursive: true })

    for (const note of legacy) {
      await writeFile(join(staging, fileNameOf(note.id)), serializeNoteFile(note), 'utf8')
    }

    // Publish. A directory left by an earlier attempt is empty — a `.md` or a
    // marker in it would have ended this run at `already-present` — and POSIX
    // `rename` replaces an empty destination directory atomically. A destination
    // holding anything else is NOT touched: this plugin never removes files it
    // did not create, so that is a failure the user has to resolve.
    const target = await stat(notesDir).catch(() => null)
    if (target !== null && !target.isDirectory()) throw new Error(`${notesDir} exists and is not a directory`)
    await rename(staging, notesDir)
    renamed = true

    // Read the published directory back. The rename guarantees the FILE SET is
    // the one just written, but only a parse proves the bytes survived the
    // round-trip, and a silently mangled note is the one failure a user would
    // never notice until the text was already wrong.
    const files = (await readdir(notesDir)).filter((name) => idOfFile(name) !== null)
    if (files.length !== legacy.length) {
      throw new Error(`migrated ${String(files.length)} files from ${String(legacy.length)} legacy notes`)
    }
    for (const note of legacy) {
      const path = join(notesDir, fileNameOf(note.id))
      const info = await stat(path)
      if (info.size > LIMITS.fileBytes) throw new Error(`migrated file for ${note.id} exceeds the size cap`)
      const parsed = parseNoteFile(await readFile(path, 'utf8'), {
        fallbackId: note.id,
        fallbackTime: info.mtime.toISOString(),
      })
      if (!sameNote(note, parsed.note)) throw new Error(`migrated file for ${note.id} does not round-trip`)
    }

    const at = (options.now ?? (() => new Date()))().toISOString()
    // Best-effort: the marker is documentation of what happened, and the notes
    // themselves already prove the migration. Failing here would delete a good
    // directory over a cosmetic file, so a write error is swallowed — the next
    // start sees the notes and reports `already-present` either way.
    await writeFile(
      join(notesDir, MIGRATION_MARKER),
      `${JSON.stringify({ from: LEGACY_DOMAIN_NAME, count: legacy.length, at, sourceCount: legacy.length }, null, 2)}\n`,
      'utf8',
    ).catch(() => {})

    return { migrated: true, reason: 'migrated', count: legacy.length }
  } catch (error) {
    // Leave no partial state behind: a published-but-unverified directory is
    // removed so the next start retries instead of treating a bad migration as
    // finished. The staging directory goes too, in every case.
    await discardStaging(staging).catch(() => {})
    if (renamed) await rm(notesDir, { recursive: true, force: true }).catch(() => {})
    return { migrated: false, reason: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}
