/**
 * Durable note store over the real `.md` files under the notes directory.
 *
 * The Host owns all data: the Client renders snapshots and submits intents, and
 * every write goes through {@link StickyWallStore} — validate, persist, then
 * hand back the changed records.
 *
 * 0.8.0 moved the notes off the storage domain and onto plain files the user can
 * open in any editor: one `.md` per note, frontmatter for the attributes, the
 * body being the note text itself. That shape is why this store looks the way it
 * does:
 *
 * - **Reads are synchronous.** Every note is loaded once at `open()` into the
 *   in-memory map, which stays the AUTHORITATIVE cache. The wall polls with the
 *   cheap `revision` call, so a read must never touch the disk.
 * - **Writes go to disk FIRST, then to the cache.** A resolved mutation means
 *   the bytes are on disk; the cache can never run ahead of the file, and a
 *   failed write leaves the previous state intact.
 * - **Every mutation is serialised** on one chain, so a check-then-write pair —
 *   the `maxNotes` count followed by the write — cannot interleave with another
 *   request. The filesystem gives us no such guarantee on its own.
 * - **One unreadable file never takes the wall down.** A file that is too large,
 *   misnamed or carries a broken frontmatter block is skipped, or degraded to a
 *   note with `metaError`, but never thrown away.
 */
import { type CentreReserve, type Note, type NoteInput, type NoteLayout, type NotePatch } from './types.js';
/** Failure carrying a stable code the transport maps onto the RPC envelope. */
export declare class WallError extends Error {
    readonly code: string;
    readonly details: Record<string, unknown>;
    constructor(code: string, message: string, details?: Record<string, unknown>);
}
/**
 * The legacy storage-domain table face, kept only so the one-time migration can
 * read what a 0.7.x install left behind.
 *
 * The store itself no longer touches a domain: the caller opens the legacy
 * domain, drains its `notes` table into `Note[]`, and hands that array to
 * `open()` as `readLegacy`. Mirroring the two-method shape here means the Host
 * entry does not have to re-declare it, and keeps the old file's public surface
 * importable while the migration exists.
 */
export interface DomainTable {
    get(key: string): unknown;
    entries(): Iterable<[string, unknown]>;
    keys(): Iterable<string>;
    readonly size: number;
    put(key: string, value: Note): Promise<void>;
    update(key: string, transform: (value: Note) => Note): Promise<Note>;
    delete(key: string): Promise<boolean>;
}
/** The opened-domain handle a legacy migration reads through. */
export interface DomainHandle {
    table(name: string): DomainTable;
    close(): Promise<void>;
}
/** Everything `open()` needs to build a store. */
export interface StoreOptions {
    /** Directory holding one `.md` per note; created recursively when absent. */
    notesDir: string;
    /** Reject a write that would take the live (non-archived) note count past this. */
    maxNotes: number;
    /** Write the built-in welcome note when the wall is empty. */
    seedWelcomeNote: boolean;
    /**
     * Reader for the legacy storage-domain notes.
     *
     * When present, `open()` runs the one-time migration BEFORE scanning the
     * directory. Leave it out and the store opens whatever `.md` files are there
     * and nothing else — which is what the tests and any non-DSH caller want.
     */
    readLegacy?: (() => Promise<Note[]>) | undefined;
    /**
     * Where a broken 0.8.0 run quarantined the legacy records.
     *
     * Passed through to the migration so it can recover a wall that build left
     * looking empty. Omit it when the caller has no legacy medium at all.
     */
    legacyNotesDir?: string | undefined;
    /** Injectable clock; tests use a stepping clock so timestamps are distinct. */
    now?: (() => Date) | undefined;
    /** Sink for non-fatal problems (an oversized or unreadable note file). */
    log?: ((message: string) => void) | undefined;
}
/** The store facade the Host endpoint and the agent tool share. */
export declare class StickyWallStore {
    /** Absolute directory the notes live in. */
    readonly notesDir: string;
    private readonly notes;
    private readonly maxNotes;
    private readonly now;
    private readonly log;
    /** Backing counter for {@link revision}. */
    private counter;
    private closed;
    /**
     * Store-level mutation chain.
     *
     * A read-then-write pair (the `maxNotes` check followed by the file write) is
     * two steps, and two concurrent creates at the boundary would both read the
     * pre-write count and both succeed. Every mutation therefore runs on this
     * chain, so each check and its write are one indivisible step.
     */
    private chain;
    private constructor();
    /**
     * Open the notes directory and load every note.
     *
     * Order matters: the one-time migration runs BEFORE the directory is created,
     * because the migration publishes its result with a single atomic `rename` of
     * a staging directory and would otherwise have to rename over a directory this
     * method had just made. Once the directory and the cache agree, the store is
     * usable; every later read is served from memory.
     */
    static open(options: StoreOptions): Promise<StickyWallStore>;
    /**
     * Monotonic change counter; bumps once per mutation that actually changed
     * something.
     *
     * The Client cannot be pushed to, so it polls. An unchanged number means the
     * caller must not touch component state at all — that is what keeps a
     * background refresh from interrupting someone mid-composition in the editor.
     */
    get revision(): number;
    /**
     * Close the store: drain queued writes, then refuse new ones.
     *
     * Draining is the point. A mutation that started before `close()` may still be
     * writing its file; dropping the chain would acknowledge a note to the Client
     * and then lose it on shutdown.
     */
    close(): Promise<void>;
    private assertOpen;
    /** Queue one mutation so its checks and writes cannot interleave with another. */
    private mutate;
    /** Absolute `.md` path for a note id. */
    pathOf(id: string): string;
    /**
     * Read every note file into the cache.
     *
     * The directory is the source of truth, so this is deliberately forgiving: a
     * subdirectory, a file that is not named after a valid note id, a file too
     * large to be a note, or one that cannot be read is skipped with a log line
     * and the rest of the wall still opens.
     */
    private load;
    /**
     * Persist one note.
     *
     * The bytes go to a sibling temp file and are then `rename`d over the target:
     * within one directory that is atomic, so a reader — or a crash — sees either
     * the old note or the new one and never a half-written file. Writing the
     * target directly would truncate it first, and a crash in that window loses
     * the note outright.
     */
    private writeNote;
    /** Remove one note file; already gone is not an error. */
    private dropFile;
    private liveCount;
    /**
     * Reject a write that would take the live (non-archived) note count past
     * `maxNotes`.
     *
     * Every path that can make a note live goes through this — `create`, an
     * `update` that unarchives, and a batch restore — because the documented cap
     * is an invariant of the wall, not a hint on the create form.
     */
    private assertRoom;
    /** Write the one-time welcome note on a brand-new wall. */
    private seedWelcomeNote;
    /** One note by id, or `null` when the wall has no such note. */
    read(id: string): Note | null;
    /** Every stored note, newest-relevant first; archived ones only on request. */
    list(includeArchived?: boolean, sort?: 'pinned' | 'created' | 'updated'): Note[];
    /**
     * The snapshot the store's own mutations work from.
     *
     * Deliberately does NOT check `closed`: {@link close} drains queued writes
     * AFTER flipping the flag, so a mutation that was already acknowledged still
     * has to run to completion — refusing it here would lose a note the caller
     * was told was saved. It is private for exactly that reason: an outside caller
     * always goes through {@link list}, which does check.
     */
    private gathered;
    /**
     * Create one note from a Client or agent submission.
     *
     * `options.centreReserve` is the Client's zoom-corrected version of the clear
     * rectangle around the wall's centrepiece. It only affects a note created
     * WITHOUT a layout: the Host places that note in the nearest free gap, which
     * is what makes a capture from the centre field appear right next to the field
     * instead of wherever an index-derived spiral happened to reach.
     */
    create(input: NoteInput, id?: string, options?: {
        centreReserve?: CentreReserve | undefined;
    }): Promise<Note>;
    private createNow;
    /** Apply one patch; `updatedAt` moves only when a field actually changed. */
    update(id: string, patch: NotePatch): Promise<Note>;
    private updateNow;
    /**
     * Flip the archived flag on a batch; returns the notes that actually moved.
     *
     * Every id is resolved BEFORE the first write: a missing id rejects the whole
     * request, so a bad batch cannot leave half the selection archived while the
     * Client still believes the mutation failed.
     */
    setArchived(ids: string[], archived: boolean): Promise<Note[]>;
    private setArchivedNow;
    /**
     * Delete a batch; returns the ids that were removed.
     *
     * The whole selection is resolved before the first delete, so a request
     * naming an absent note changes nothing: a caller is never told the batch
     * failed while part of it was already applied. Batch semantics match
     * {@link setArchived}.
     */
    remove(ids: string[]): Promise<string[]>;
    private removeNow;
    /**
     * Move one card on the free canvas.
     *
     * Moving is its own operation rather than an `update` patch: it deliberately
     * does NOT bump `updatedAt`, because rearranging a wall is not editing a
     * note's content and must not reshuffle a "by updated" sort. The write is
     * still serialised on the mutation chain so two drags cannot race.
     */
    move(id: string, layout: NoteLayout): Promise<Note>;
    private moveNow;
    /**
     * Tidy the wall: repack every note into a deterministic shelf arrangement.
     *
     * Returns only the notes that actually moved, so the Client can reconcile
     * without refetching the whole wall, and pressing tidy on an already-tidy
     * wall is a no-op instead of a write storm.
     */
    arrange(options?: {
        centreReserve?: CentreReserve | undefined;
    }): Promise<Note[]>;
    private arrangeNow;
    /**
     * Permanently remove every archived note.
     *
     * The archived set is read once and deleted in order; a delete failure stops
     * the sweep and surfaces, leaving the remaining archived notes intact rather
     * than reporting a clean sweep that did not happen.
     */
    clearArchived(): Promise<string[]>;
    private clearArchivedNow;
    /** Compact plain-text digest of the wall for the model-facing tool. */
    summary(limit?: number): {
        total: number;
        archived: number;
        notes: Note[];
    };
}
