/**
 * Wire and storage vocabulary shared by the Host and Client halves.
 *
 * Everything here is plain, lossless JSON: the Host and the Client live in
 * different runtimes and only these shapes cross the Connection RPC boundary.
 * Both halves are compiled from this file, so the Client bundle carries the
 * same literals without importing Host code.
 */
/** RPC endpoint path under the shared `/api` channel. */
export declare const ENDPOINT = "skillre-sticky-wall/execute";
/** Sidebar panel id, main panel key, and locale namespace. */
export declare const PANEL_ID = "skillre-sticky-wall";
export declare const LOCALE_NAMESPACE = "skillreStickyWall";
/** Storage domain name; the per-record layout gives one file per note. */
export declare const DOMAIN_NAME = "skillre_sticky_wall";
export declare const DOMAIN_VERSION = 1;
/** Hard limits, enforced on both halves so a bad payload never reaches storage. */
export declare const LIMITS: Readonly<{
    /** One note's body, in characters. */
    body: 4000;
    /** One note's title, in characters. */
    title: 120;
    /** A note's free-form tag list. */
    tags: 8;
    /** One tag, in characters. */
    tag: 32;
    /** Live (non-archived) notes a wall may hold. */
    notes: 400;
    /** Note ids accepted in one request. */
    bulk: 200;
}>;
/** Pastel note colors the wall offers; the Client renders them as literal hex. */
export declare const COLORS: readonly ["yellow", "pink", "green", "blue", "purple", "orange"];
export type NoteColor = (typeof COLORS)[number];
/** Sort orders the wall exposes. */
export declare const SORTS: readonly ["pinned", "created", "updated"];
export type NoteSort = (typeof SORTS)[number];
/** One sticky note as stored and as sent over the wire. */
export interface Note {
    /** Stable id; `crypto.randomUUID()` for locally created notes. */
    id: string;
    /** Optional short heading; the body alone is enough for a quick capture. */
    title: string;
    /** The note text. Never empty for a live note. */
    body: string;
    /** Normalized lowercase tags, deduplicated, at most {@link LIMITS.tags}. */
    tags: string[];
    /** Pastel key from {@link COLORS}. */
    color: NoteColor;
    /** Pinned notes sort first and survive `archive` sweeps. */
    pinned: boolean;
    /** Archived notes are kept but hidden by the default wall. */
    archived: boolean;
    /** ISO-8601 creation time. */
    createdAt: string;
    /** ISO-8601 last-write time. */
    updatedAt: string;
}
/** The complete wall state a Client renders. */
export interface WallSnapshot {
    notes: Note[];
    /** Schema marker so a Client never renders an unknown future shape. */
    domain: {
        name: string;
        version: number;
    };
}
/** Request kinds accepted by the Host endpoint. */
export type WallRequest = {
    action: 'list';
    includeArchived?: boolean;
    sort?: NoteSort;
} | {
    action: 'create';
    note: NoteInput;
} | {
    action: 'update';
    id: string;
    patch: NotePatch;
} | {
    action: 'archive';
    ids: string[];
    archived: boolean;
} | {
    action: 'delete';
    ids: string[];
} | {
    action: 'clear-archived';
};
/** The fields a Client may submit when creating a note. */
export interface NoteInput {
    body: string;
    title?: string;
    tags?: string[];
    color?: NoteColor;
    pinned?: boolean;
}
/** The fields a Client may change on an existing note. */
export interface NotePatch {
    body?: string;
    title?: string;
    tags?: string[];
    color?: NoteColor;
    pinned?: boolean;
    archived?: boolean;
}
/** One endpoint outcome, mirroring the Connection RPC result envelope. */
export type WallResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
        details: Record<string, unknown>;
    };
};
/** Result of one mutation, echoed back so the Client can reconcile in place. */
export interface MutationResult {
    action: string;
    /** Every note the mutation created or changed, in its post-write state. */
    changed: Note[];
    /** Ids the mutation removed. */
    removed: string[];
}
