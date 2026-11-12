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
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arrangeLayouts, clampLayout, findFreeLayout, normalizeReserve, normalizeWidth, sameLayout } from './layout.js';
import { fileNameOf, idOfFile, isNoteId, parseNoteFile, serializeNoteFile } from './frontmatter.js';
import { migrateNotes } from './migrate.js';
import { CENTRE_RESERVE, COLORS, LIMITS, } from './types.js';
/** Failure carrying a stable code the transport maps onto the RPC envelope. */
export class WallError extends Error {
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'WallError';
    }
}
/** Normalize one tag: trim, lowercase, collapse inner whitespace, bound length. */
function normalizeTag(raw) {
    const value = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    return value.slice(0, LIMITS.tag);
}
/** Normalize a submitted tag list: drop empties, deduplicate, cap the count. */
function normalizeTags(raw) {
    if (!Array.isArray(raw))
        return [];
    const seen = new Set();
    for (const entry of raw) {
        const tag = normalizeTag(entry);
        if (tag === '' || seen.has(tag))
            continue;
        seen.add(tag);
        if (seen.size >= LIMITS.tags)
            break;
    }
    return [...seen];
}
/**
 * The stored body for a submitted string.
 *
 * Line endings are normalized, and NOTHING ELSE is touched — in particular the
 * body is never trimmed. The card-height estimate walks this text line by line
 * and the file round-trip has to give back exactly what was written, so a stray
 * `.trim()` here would change every card's geometry and silently eat the blank
 * lines a user indented with.
 */
function readBody(raw) {
    return String(raw ?? '').replace(/\r\n?/g, '\n');
}
/** Validate the body length against {@link LIMITS.body}. */
function assertBodyLength(value) {
    if (value.length > LIMITS.body)
        throw new WallError('body-too-long', `A note is limited to ${LIMITS.body} characters.`, { limit: LIMITS.body, length: value.length });
}
/**
 * Validate a body for CREATE, where a note must actually say something.
 *
 * Emptiness is judged on the trimmed text so a note of three spaces is still
 * refused, but the STORED value keeps every character the caller sent.
 */
function normalizeBody(raw) {
    const value = readBody(raw);
    if (value.trim() === '')
        throw new WallError('empty-body', 'A note needs some text.');
    assertBodyLength(value);
    return value;
}
/**
 * Validate a body for an UPDATE.
 *
 * An existing note may be saved EMPTY. Deleting the last character of a note is
 * a legitimate edit — the user is clearing the card to retype it, or keeping a
 * card as a title only — and refusing it left the editor unable to save at all,
 * with the old text still on disk. Length is still capped.
 */
function normalizeBodyForUpdate(raw) {
    const value = readBody(raw);
    assertBodyLength(value);
    return value;
}
/** Validate and trim a title; an absent title is the empty string. */
function normalizeTitle(raw) {
    const value = String(raw ?? '').replace(/\r\n?/g, ' ').trim();
    if (value.length > LIMITS.title)
        throw new WallError('title-too-long', `A note title is limited to ${LIMITS.title} characters.`, { limit: LIMITS.title, length: value.length });
    return value;
}
/** Accept only a declared pastel key. */
function normalizeColor(raw) {
    const value = String(raw ?? '');
    const match = COLORS.find((color) => color === value);
    if (match === undefined)
        throw new WallError('invalid-color', `Unknown note color ${JSON.stringify(value)}.`, { colors: [...COLORS] });
    return match;
}
/** Validate and clamp a submitted placement; `null` clears it back to derived. */
function normalizeLayout(raw) {
    if (raw === null || raw === undefined)
        return null;
    if (typeof raw !== 'object')
        throw new WallError('invalid-layout', 'A note placement must be an object.');
    const value = raw;
    const x = Number(value.x);
    const y = Number(value.y);
    const rotate = Number(value.rotate ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(rotate)) {
        throw new WallError('invalid-layout', 'A note placement needs finite x, y and rotate values.');
    }
    return clampLayout({ x, y, rotate, width: normalizeWidth(value.width) });
}
/**
 * Reject ids that cannot name a note file before anything is touched.
 *
 * The id is now a BASENAME, so this is also the path-traversal guard: `../x`
 * must never reach `pathOf`.
 */
function assertIds(raw) {
    if (!Array.isArray(raw) || raw.length === 0)
        throw new WallError('invalid-ids', 'Select at least one note.');
    if (raw.length > LIMITS.bulk)
        throw new WallError('too-many-ids', `At most ${LIMITS.bulk} notes per request.`, { limit: LIMITS.bulk });
    const ids = [...new Set(raw.map((id) => String(id ?? '')))];
    if (ids.some((id) => !isNoteId(id)))
        throw new WallError('invalid-ids', 'One of the selected note ids is invalid.');
    return ids;
}
/**
 * One note's sort weight: pinned first, then the requested ordering, with the
 * id as a final tiebreaker so two notes written in the same millisecond still
 * render in a stable order.
 */
function compareNotes(sort) {
    return (left, right) => {
        if (left.pinned !== right.pinned)
            return left.pinned ? -1 : 1;
        if (sort === 'created') {
            return right.createdAt.localeCompare(left.createdAt) || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
        }
        return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
    };
}
/** The store facade the Host endpoint and the agent tool share. */
export class StickyWallStore {
    /** Absolute directory the notes live in. */
    notesDir;
    notes = new Map();
    maxNotes;
    now;
    log;
    /** Backing counter for {@link revision}. */
    counter = 0;
    closed = false;
    /**
     * Store-level mutation chain.
     *
     * A read-then-write pair (the `maxNotes` check followed by the file write) is
     * two steps, and two concurrent creates at the boundary would both read the
     * pre-write count and both succeed. Every mutation therefore runs on this
     * chain, so each check and its write are one indivisible step.
     */
    chain = Promise.resolve();
    constructor(options) {
        this.notesDir = resolve(options.notesDir);
        this.maxNotes = options.maxNotes;
        this.now = options.now ?? (() => new Date());
        this.log = options.log ?? (() => { });
    }
    /**
     * Open the notes directory and load every note.
     *
     * Order matters: the one-time migration runs BEFORE the directory is created,
     * because the migration publishes its result with a single atomic `rename` of
     * a staging directory and would otherwise have to rename over a directory this
     * method had just made. Once the directory and the cache agree, the store is
     * usable; every later read is served from memory.
     */
    static async open(options) {
        const store = new StickyWallStore(options);
        if (options.readLegacy !== undefined) {
            const result = await migrateNotes({
                notesDir: store.notesDir,
                readLegacy: options.readLegacy,
                ...(options.now === undefined ? {} : { now: options.now }),
            });
            if (!result.migrated && result.reason === 'failed') {
                // The legacy wall is untouched and the next start retries, so the plugin
                // still opens — empty rather than broken. Say so loudly enough that the
                // Host log explains why the user's notes are missing.
                store.log(`sticky-wall: legacy migration failed, opening an empty wall: ${result.error ?? 'unknown error'}`);
            }
        }
        await mkdir(store.notesDir, { recursive: true });
        await store.load();
        if (options.seedWelcomeNote)
            await store.seedWelcomeNote();
        return store;
    }
    /**
     * Monotonic change counter; bumps once per mutation that actually changed
     * something.
     *
     * The Client cannot be pushed to, so it polls. An unchanged number means the
     * caller must not touch component state at all — that is what keeps a
     * background refresh from interrupting someone mid-composition in the editor.
     */
    get revision() {
        return this.counter;
    }
    /**
     * Close the store: drain queued writes, then refuse new ones.
     *
     * Draining is the point. A mutation that started before `close()` may still be
     * writing its file; dropping the chain would acknowledge a note to the Client
     * and then lose it on shutdown.
     */
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        await this.chain;
    }
    assertOpen() {
        if (this.closed)
            throw new WallError('closed', 'The note wall is shutting down.');
    }
    /** Queue one mutation so its checks and writes cannot interleave with another. */
    mutate(job) {
        const result = this.chain.then(job);
        this.chain = result.then(() => undefined, () => undefined);
        return result;
    }
    /** Absolute `.md` path for a note id. */
    pathOf(id) {
        if (!isNoteId(id))
            throw new WallError('invalid-ids', `Note id ${JSON.stringify(id)} cannot be a file name.`, { id });
        return join(this.notesDir, fileNameOf(id));
    }
    /**
     * Read every note file into the cache.
     *
     * The directory is the source of truth, so this is deliberately forgiving: a
     * subdirectory, a file that is not named after a valid note id, a file too
     * large to be a note, or one that cannot be read is skipped with a log line
     * and the rest of the wall still opens.
     */
    async load() {
        let entries;
        try {
            entries = await readdir(this.notesDir, { withFileTypes: true });
        }
        catch (error) {
            // The directory was removed between `mkdir` and here; an empty wall is the
            // right answer, and the first write recreates it.
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            const id = idOfFile(entry.name);
            if (id === null)
                continue;
            const path = join(this.notesDir, entry.name);
            try {
                // Size is checked BEFORE the read: the point of the cap is not to hand a
                // 200 MB accidental paste to the parser at all.
                const info = await stat(path);
                if (info.size > LIMITS.fileBytes) {
                    this.log(`sticky-wall: skipping oversized note file ${entry.name} (${String(info.size)} bytes)`);
                    continue;
                }
                const parsed = parseNoteFile(await readFile(path, 'utf8'), {
                    fallbackId: id,
                    // The file's own mtime is the only honest timestamp a hand-written
                    // note has; a note WITH frontmatter keeps its authored `created`.
                    fallbackTime: info.mtime.toISOString(),
                });
                // The file name is the identity on disk. A frontmatter `id` that
                // disagrees (a hand-copied file, a rename) must not become a second
                // address for the same note: the next write would then land in a
                // different file and leave the loaded one behind.
                this.notes.set(id, { ...parsed.note, id });
            }
            catch (error) {
                this.log(`sticky-wall: skipping unreadable note file ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    /**
     * Persist one note.
     *
     * The bytes go to a sibling temp file and are then `rename`d over the target:
     * within one directory that is atomic, so a reader — or a crash — sees either
     * the old note or the new one and never a half-written file. Writing the
     * target directly would truncate it first, and a crash in that window loses
     * the note outright.
     */
    async writeNote(note) {
        const target = this.pathOf(note.id);
        const temporary = `${target}.tmp`;
        await mkdir(this.notesDir, { recursive: true });
        // The temp name never ends in `.md`, so a crash that strands one here is
        // skipped by {@link load} as "not a note file" instead of being read back as
        // a half-written note or a duplicate.
        try {
            await writeFile(temporary, serializeNoteFile(note), 'utf8');
            await rename(temporary, target);
        }
        catch (error) {
            // A failed write must not leave debris beside a note the user can see.
            await rm(temporary, { force: true }).catch(() => { });
            throw error;
        }
    }
    /** Remove one note file; already gone is not an error. */
    async dropFile(id) {
        await rm(this.pathOf(id), { force: true });
    }
    liveCount() {
        let count = 0;
        for (const note of this.notes.values())
            if (!note.archived)
                count += 1;
        return count;
    }
    /**
     * Reject a write that would take the live (non-archived) note count past
     * `maxNotes`.
     *
     * Every path that can make a note live goes through this — `create`, an
     * `update` that unarchives, and a batch restore — because the documented cap
     * is an invariant of the wall, not a hint on the create form.
     */
    assertRoom(incomingLive) {
        if (incomingLive <= 0)
            return;
        const projected = this.liveCount() + incomingLive;
        if (projected > this.maxNotes) {
            throw new WallError('wall-full', `The wall already holds ${this.maxNotes} notes; archive or delete one first.`, {
                limit: this.maxNotes,
                projected,
            });
        }
    }
    /** Write the one-time welcome note on a brand-new wall. */
    async seedWelcomeNote() {
        if (this.notes.size > 0)
            return;
        const stamp = this.now().toISOString();
        const note = {
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
        };
        await this.writeNote(note);
        this.notes.set(note.id, note);
        this.counter += 1;
    }
    /** One note by id, or `null` when the wall has no such note. */
    read(id) {
        this.assertOpen();
        return this.notes.get(id) ?? null;
    }
    /** Every stored note, newest-relevant first; archived ones only on request. */
    list(includeArchived = false, sort = 'pinned') {
        this.assertOpen();
        return this.gathered(includeArchived, sort);
    }
    /**
     * The snapshot the store's own mutations work from.
     *
     * Deliberately does NOT check `closed`: {@link close} drains queued writes
     * AFTER flipping the flag, so a mutation that was already acknowledged still
     * has to run to completion — refusing it here would lose a note the caller
     * was told was saved. It is private for exactly that reason: an outside caller
     * always goes through {@link list}, which does check.
     */
    gathered(includeArchived, sort) {
        const notes = [];
        for (const note of this.notes.values()) {
            if (note.archived && !includeArchived)
                continue;
            notes.push(note);
        }
        return notes.sort(compareNotes(sort));
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
    async create(input, id, options = {}) {
        this.assertOpen();
        return this.mutate(() => this.createNow(input, id, options));
    }
    async createNow(input, id, options = {}) {
        const body = normalizeBody(input?.body);
        const title = normalizeTitle(input?.title);
        // An explicit id becomes a file name, so it has to be one we would accept
        // from disk as well; a generated UUID already satisfies this.
        if (id !== undefined && !isNoteId(id))
            throw new WallError('invalid-ids', `Note id ${JSON.stringify(id)} cannot be a file name.`, { id });
        if (id !== undefined) {
            // The FILE is the identity, not the cache entry: a note file big enough to
            // be skipped at load, or one written by another tool while this store was
            // open, is not in `notes` but is very much on disk. Overwriting it with a
            // fresh note would destroy a file the user still has.
            if (this.notes.has(id))
                throw new WallError('duplicate-id', `A note with id ${JSON.stringify(id)} already exists.`);
            const taken = await stat(this.pathOf(id)).then(() => true, () => false);
            if (taken)
                throw new WallError('duplicate-id', `A note file named ${JSON.stringify(fileNameOf(id))} already exists.`, { id });
        }
        this.assertRoom(1);
        const stamp = this.now().toISOString();
        const note = {
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
        };
        // A note with no explicit placement gets the nearest free spot on the wall,
        // not `null`. `null` means "derive a position from my index", and that spiral
        // grows outward — so the user's tenth capture could land a screen away from
        // where they were looking, which reads as the capture having failed.
        if (note.layout === null) {
            note.layout = findFreeLayout(note, this.gathered(true, 'pinned'), { centreReserve: normalizeReserve(options.centreReserve ?? CENTRE_RESERVE) });
        }
        // Disk first, then the cache: a resolution means the note exists as a file.
        await this.writeNote(note);
        this.notes.set(note.id, note);
        this.counter += 1;
        return note;
    }
    /** Apply one patch; `updatedAt` moves only when a field actually changed. */
    async update(id, patch) {
        this.assertOpen();
        return this.mutate(() => this.updateNow(id, patch));
    }
    async updateNow(id, patch) {
        const current = this.notes.get(id);
        if (current === undefined)
            throw new WallError('not-found', `No note with id ${JSON.stringify(id)}.`, { id });
        // The patch is applied OVER the current note, so `extra` (unknown
        // frontmatter keys the user or a newer build owns) and `metaError` (why this
        // file's frontmatter is suspect) ride through untouched.
        const next = { ...current };
        if (patch?.body !== undefined)
            next.body = normalizeBodyForUpdate(patch.body);
        if (patch?.title !== undefined)
            next.title = normalizeTitle(patch.title);
        if (patch?.tags !== undefined)
            next.tags = normalizeTags(patch.tags);
        if (patch?.color !== undefined)
            next.color = normalizeColor(patch.color);
        if (patch?.pinned !== undefined)
            next.pinned = patch.pinned === true;
        if (patch?.archived !== undefined)
            next.archived = patch.archived === true;
        // Restoring an archived note makes it live again, so it must fit the cap.
        if (current.archived && !next.archived)
            this.assertRoom(1);
        const changed = ['body', 'title', 'color', 'pinned', 'archived'].some((key) => next[key] !== current[key]) ||
            JSON.stringify(next.tags) !== JSON.stringify(current.tags);
        // A patch that changes nothing writes nothing: no file churn, no revision
        // bump, so a polling Client sees no reason to re-render.
        if (!changed)
            return current;
        next.updatedAt = this.now().toISOString();
        await this.writeNote(next);
        this.notes.set(id, next);
        this.counter += 1;
        return next;
    }
    /**
     * Flip the archived flag on a batch; returns the notes that actually moved.
     *
     * Every id is resolved BEFORE the first write: a missing id rejects the whole
     * request, so a bad batch cannot leave half the selection archived while the
     * Client still believes the mutation failed.
     */
    async setArchived(ids, archived) {
        this.assertOpen();
        return this.mutate(() => this.setArchivedNow(ids, archived));
    }
    async setArchivedNow(ids, archived) {
        const selected = assertIds(ids);
        const targets = [];
        for (const id of selected) {
            const current = this.notes.get(id);
            if (current === undefined)
                throw new WallError('not-found', `No note with id ${JSON.stringify(id)}.`, { id });
            if (current.archived !== archived)
                targets.push(current);
        }
        // A restore batch makes every target live; check the whole batch up front so
        // a partial restore can never exceed the cap.
        if (!archived)
            this.assertRoom(targets.length);
        const changed = [];
        const stamp = this.now().toISOString();
        for (const current of targets) {
            const next = { ...current, archived, updatedAt: stamp };
            await this.writeNote(next);
            this.notes.set(next.id, next);
            changed.push(next);
        }
        if (changed.length > 0)
            this.counter += 1;
        return changed;
    }
    /**
     * Delete a batch; returns the ids that were removed.
     *
     * The whole selection is resolved before the first delete, so a request
     * naming an absent note changes nothing: a caller is never told the batch
     * failed while part of it was already applied. Batch semantics match
     * {@link setArchived}.
     */
    async remove(ids) {
        this.assertOpen();
        return this.mutate(() => this.removeNow(ids));
    }
    async removeNow(ids) {
        const selected = assertIds(ids);
        for (const id of selected) {
            if (!this.notes.has(id))
                throw new WallError('not-found', `No note with id ${JSON.stringify(id)}.`, { id });
        }
        const removed = [];
        for (const id of selected) {
            await this.dropFile(id);
            this.notes.delete(id);
            removed.push(id);
        }
        if (removed.length > 0)
            this.counter += 1;
        return removed;
    }
    /**
     * Move one card on the free canvas.
     *
     * Moving is its own operation rather than an `update` patch: it deliberately
     * does NOT bump `updatedAt`, because rearranging a wall is not editing a
     * note's content and must not reshuffle a "by updated" sort. The write is
     * still serialised on the mutation chain so two drags cannot race.
     */
    async move(id, layout) {
        this.assertOpen();
        return this.mutate(() => this.moveNow(id, layout));
    }
    async moveNow(id, layout) {
        const current = this.notes.get(id);
        if (current === undefined)
            throw new WallError('not-found', `No note with id ${JSON.stringify(id)}.`, { id });
        const next = normalizeLayout(layout);
        // The same placement again is a no-op: no write, no revision bump.
        if (sameLayout(current.layout, next))
            return current;
        const moved = { ...current, layout: next };
        await this.writeNote(moved);
        this.notes.set(id, moved);
        this.counter += 1;
        return moved;
    }
    /**
     * Tidy the wall: repack every note into a deterministic shelf arrangement.
     *
     * Returns only the notes that actually moved, so the Client can reconcile
     * without refetching the whole wall, and pressing tidy on an already-tidy
     * wall is a no-op instead of a write storm.
     */
    async arrange(options = {}) {
        this.assertOpen();
        return this.mutate(() => this.arrangeNow(options));
    }
    async arrangeNow(options = {}) {
        // Every note, archived ones included. Packing only the live set left an
        // archived-but-visible card at its dragged position, on top of the freshly
        // tidied ones — the wall has to be tidy in every filter, not just the
        // default one.
        const current = this.gathered(true, 'pinned');
        const planned = arrangeLayouts(current, { centreReserve: normalizeReserve(options.centreReserve ?? CENTRE_RESERVE) });
        const changed = [];
        for (const note of current) {
            const target = planned.get(note.id);
            if (target === undefined || sameLayout(note.layout, target))
                continue;
            const moved = { ...note, layout: target };
            await this.writeNote(moved);
            this.notes.set(note.id, moved);
            changed.push(moved);
        }
        if (changed.length > 0)
            this.counter += 1;
        return changed;
    }
    /**
     * Permanently remove every archived note.
     *
     * The archived set is read once and deleted in order; a delete failure stops
     * the sweep and surfaces, leaving the remaining archived notes intact rather
     * than reporting a clean sweep that did not happen.
     */
    async clearArchived() {
        this.assertOpen();
        return this.mutate(() => this.clearArchivedNow());
    }
    async clearArchivedNow() {
        const archived = this.gathered(true, 'pinned').filter((note) => note.archived).map((note) => note.id);
        const removed = [];
        for (const id of archived) {
            await this.dropFile(id);
            this.notes.delete(id);
            removed.push(id);
        }
        if (removed.length > 0)
            this.counter += 1;
        return removed;
    }
    /** Compact plain-text digest of the wall for the model-facing tool. */
    summary(limit = 20) {
        this.assertOpen();
        const all = this.list(true, 'updated');
        return {
            total: all.length,
            archived: all.filter((note) => note.archived).length,
            notes: all.slice(0, Math.max(1, Math.min(limit, LIMITS.listLimit))),
        };
    }
}
