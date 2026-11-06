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
import { z } from 'zod';
import { type Note, type NoteInput, type NoteLayout, type NotePatch } from './types.js';
/** Failure carrying a stable code the transport maps onto the RPC envelope. */
export declare class WallError extends Error {
    readonly code: string;
    readonly details: Record<string, unknown>;
    constructor(code: string, message: string, details?: Record<string, unknown>);
}
/** The domain declaration handed to `ctx.storageDomain.open()`. */
export declare const DOMAIN_SPEC: {
    name: string;
    version: number;
    layout: "per-record";
    invalidRecords: "backup-and-skip";
    tables: {
        notes: {
            valueSchema: z.ZodObject<{
                id: z.ZodString;
                title: z.ZodDefault<z.ZodString>;
                body: z.ZodString;
                tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
                color: z.ZodDefault<z.ZodEnum<{
                    yellow: "yellow";
                    pink: "pink";
                    green: "green";
                    blue: "blue";
                    purple: "purple";
                    orange: "orange";
                }>>;
                pinned: z.ZodDefault<z.ZodBoolean>;
                archived: z.ZodDefault<z.ZodBoolean>;
                createdAt: z.ZodString;
                updatedAt: z.ZodString;
                layout: z.ZodDefault<z.ZodNullable<z.ZodObject<{
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    rotate: z.ZodNumber;
                    width: z.ZodEnum<{
                        sm: "sm";
                        md: "md";
                        lg: "lg";
                    }>;
                }, z.core.$strip>>>;
            }, z.core.$loose>;
        };
    };
};
/** The minimal domain table face this store uses; the rest is unused here. */
export interface DomainTable {
    get(key: string): unknown;
    entries(): Iterable<[string, unknown]>;
    keys(): Iterable<string>;
    readonly size: number;
    put(key: string, value: Note): Promise<void>;
    update(key: string, transform: (value: Note) => Note): Promise<Note>;
    delete(key: string): Promise<boolean>;
}
/** The opened-domain handle the facility returns. */
export interface DomainHandle {
    table(name: string): DomainTable;
    close(): Promise<void>;
}
/** The store facade the Host endpoint and the agent tool share. */
export declare class StickyWallStore {
    private readonly domain;
    private readonly maxNotes;
    private readonly now;
    private readonly notes;
    private closed;
    /**
     * Store-level mutation chain.
     *
     * The storage domain serializes its own writes, but a read-then-write pair
     * (the `maxNotes` check followed by the `put`) is two steps: two concurrent
     * creates at the boundary would both read the pre-write count and both
     * succeed. Every mutation therefore runs on this chain, so each check and its
     * write are one indivisible step.
     */
    private chain;
    constructor(domain: DomainHandle, maxNotes: number, now?: () => Date);
    /** Open one domain and wrap it in a store. */
    static open(open: (spec: typeof DOMAIN_SPEC) => Promise<DomainHandle>, options: {
        maxNotes: number;
        seedWelcomeNote: boolean;
        now?: () => Date;
    }): Promise<StickyWallStore>;
    /** Release the domain handle; later writes fail instead of silently dropping. */
    close(): Promise<void>;
    private assertOpen;
    /** Queue one mutation so its checks and writes cannot interleave with another. */
    private mutate;
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
    /** Every stored note, newest-relevant first; archived ones only on request. */
    list(includeArchived?: boolean, sort?: 'pinned' | 'created' | 'updated'): Note[];
    /** Create one note from a Client or agent submission. */
    create(input: NoteInput, id?: string): Promise<Note>;
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
    arrange(): Promise<Note[]>;
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
