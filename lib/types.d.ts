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
/**
 * Card width presets.
 *
 * A free canvas looks dead when every card is the same width, so the wall keeps
 * three sizes. They are presets rather than arbitrary pixels: the card's text
 * metrics, the auto-arrange packing and the drag handles all assume a known
 * width, and a preset keeps the stored layout small and legible.
 */
export declare const WIDTHS: readonly ["sm", "md", "lg"];
export type NoteWidth = (typeof WIDTHS)[number];
/** Rendered card width for each preset, in world pixels at zoom 1. */
export declare const WIDTH_PX: Readonly<Record<NoteWidth, number>>;
/** Bounds of the free canvas: a note may sit anywhere inside this square. */
export declare const LAYOUT_LIMITS: Readonly<{
    /** Absolute value of x and y, in world pixels. */
    coord: 20000;
    /** Absolute rotation, in degrees. */
    rotate: 12;
}>;
/**
 * Where one note sits on the free canvas.
 *
 * `null` on a note means "never placed": the Client derives a stable preview
 * position from the note id so a wall written before the canvas existed still
 * opens as a scattered wall instead of a single stack. Dragging or arranging
 * writes a real layout, so the Host stays the only owner of the arrangement.
 */
export interface NoteLayout {
    /** World x of the card's top-left corner, in pixels at zoom 1. */
    x: number;
    /** World y of the card's top-left corner, in pixels at zoom 1. */
    y: number;
    /** Rotation in degrees, clamped to {@link LAYOUT_LIMITS.rotate}. */
    rotate: number;
    /** Card width preset. */
    width: NoteWidth;
}
/** One sticky note as stored and as sent over the wire. */
export interface Note {
    /** Stable id; `crypto.randomUUID()` for locally created notes. */
    id: string;
    /** Optional short heading; the body alone is enough for a quick capture. */
    title: string;
    /** The note text. Never empty for a live note. Markdown is rendered, not stored away. */
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
    /** ISO-8601 last-write time. Moving a card does not bump this. */
    updatedAt: string;
    /** Free-canvas placement, or `null` for a note the user never positioned. */
    layout: NoteLayout | null;
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
} | {
    action: 'move';
    id: string;
    layout: NoteLayout;
} | {
    action: 'arrange';
};
/** The fields a Client may submit when creating a note. */
export interface NoteInput {
    body: string;
    title?: string;
    tags?: string[];
    color?: NoteColor;
    pinned?: boolean;
    layout?: NoteLayout | null;
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
