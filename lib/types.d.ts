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
/**
 * LEGACY storage-domain identity, kept only so the one-time migration can still
 * open the JSON domain a 0.7.x install left behind.
 *
 * 0.8.0 moved the notes onto real `.md` files under the notes directory, so
 * nothing else reads this any more. Removing it would strand an existing user's
 * wall in a format the plugin can no longer name, so it stays until the
 * migration is retired.
 */
export declare const LEGACY_DOMAIN_NAME = "skillre_sticky_wall";
export declare const LEGACY_DOMAIN_VERSION = 1;
/** The private directory, under the DSH home, that holds one `.md` per note. */
export declare const NOTES_DIR_NAME = "sticky-notes";
/** Every note file carries this suffix; the id alone is the basename. */
export declare const NOTE_FILE_SUFFIX = ".md";
/** Marker written once, after a successful migration, beside the notes. */
export declare const MIGRATION_MARKER = "migration.json";
/**
 * The frontmatter schema generation this build writes.
 *
 * `schema:` is a forward-compatibility marker, not a migration trigger: a file
 * written by a NEWER build parses with its known keys and keeps the rest in
 * `extra` rather than being silently rewritten.
 */
export declare const FRONTMATTER_SCHEMA = 1;
/** Hard limits, enforced on both halves so a bad payload never reaches storage. */
export declare const LIMITS: Readonly<{
    /**
     * One note's body, in characters.
     *
     * 0.8.0 lifted the old 4000-character cap, because the body now lives in a
     * plain `.md` file rather than a JSON record and a note is allowed to be a
     * real document. This is a resource guard against a pathological file, not a
     * product limit: at 200k characters a note is a short book.
     */
    body: 200000;
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
    /** One note file's size on disk, in bytes; larger files are refused unread. */
    fileBytes: number;
    /** Newest notes the agent `list` action returns. */
    listLimit: 50;
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
/**
 * The clear RECTANGLE the wall leaves around its centrepiece.
 *
 * The middle of the wall is not empty space — it holds the greeting, the running
 * tally and the quick-capture field. Those three are one stacked block, roughly
 * twice as wide as it is tall, so a circular reserve was the wrong shape: it
 * wasted a tall column of paper above and below the field while still letting a
 * wide card reach in from the side.
 *
 * The numbers are the shipped centrepiece at zoom 1 (560px wide, ~140px tall)
 * plus a margin, in world pixels. The Client re-derives a zoom-corrected version
 * of this rectangle from the rendered DOM before it asks the Host to tidy, so a
 * zoomed-out wall reserves proportionally more world space — see
 * `WallPage.centreReserve`.
 */
export declare const CENTRE_RESERVE: Readonly<{
    halfWidth: 330;
    halfHeight: 136;
}>;
/**
 * A clear rectangle around the wall's centrepiece, in WORLD pixels.
 *
 * The size is fixed, but the POSITION is not, and that distinction is the whole
 * point. The centrepiece is a screen-space overlay: it stays at the middle of
 * the viewport while the paper pans and zooms underneath it, so the patch of
 * world it covers moves with the camera even though the patch keeps its size.
 *
 * A reserve that only carried half-extents therefore described the wrong place
 * as soon as the camera moved: the Host kept the world ORIGIN clear while the
 * field sat somewhere else, and a note captured from the field was placed —
 * and then revealed — directly behind it. `x`/`y` are that missing position;
 * they default to the origin, which is exactly where a freshly framed wall puts
 * the field.
 */
export interface CentreReserve {
    /** World x of the reserve's centre; defaults to the origin. */
    x?: number | undefined;
    /** World y of the reserve's centre; defaults to the origin. */
    y?: number | undefined;
    /** Half-width in world pixels. */
    halfWidth: number;
    /** Half-height in world pixels. */
    halfHeight: number;
}
/** A reserve with its position resolved: what the geometry actually works on. */
export interface ReserveRect {
    /** World x of the reserve's centre. */
    x: number;
    /** World y of the reserve's centre. */
    y: number;
    /** Half-width in world pixels. */
    halfWidth: number;
    /** Half-height in world pixels. */
    halfHeight: number;
}
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
    /** Stable id; `crypto.randomUUID()` for locally created notes. Also the file's basename. */
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
    /**
     * Why this note's frontmatter could not be read, when it could not.
     *
     * A note with a broken frontmatter block is NOT dropped and NOT rejected: the
     * body still renders and the card keeps default attributes, with this message
     * carried so the wall can flag it. Losing a user's note because they (or the
     * model) mangled a YAML line would be far worse than showing it with the
     * wrong color — this is the fail-soft contract the storage domain used to
     * provide through `invalidRecords: 'backup-and-skip'`.
     */
    metaError?: string | undefined;
    /**
     * Frontmatter keys this build does not understand, preserved verbatim.
     *
     * A newer build may add keys, or the user may hand-add their own (a `due:`
     * date, a link). Rewriting the file without them would silently destroy that
     * data, so they are carried through every read/write cycle untouched.
     */
    extra?: Readonly<Record<string, string>> | undefined;
}
/** The complete wall state a Client renders. */
export interface WallSnapshot {
    notes: Note[];
    /**
     * Monotonic change counter.
     *
     * The Client cannot be pushed to (the Connection envelope has no
     * server-initiated variant), so it polls. This is what makes a poll cheap and
     * SAFE: an unchanged revision means the caller must not touch component state
     * at all, which is what stops a background refresh from interrupting someone
     * mid-composition in the editor.
     */
    revision: number;
    /** Absolute directory the notes live in, so the UI can reveal/copy it. */
    notesDir: string;
    /** Schema marker so a Client never renders an unknown future shape. */
    domain: {
        name: string;
        version: number;
    };
}
/** Everything the agent-side `read` action returns for one note. */
export interface NoteDocument {
    note: Note;
    /** Absolute path of the backing `.md` file, for native `read`/`edit`. */
    path: string;
}
/** Request kinds accepted by the Host endpoint. */
export type WallRequest = {
    action: 'list';
    includeArchived?: boolean;
    sort?: NoteSort;
}
/**
 * The cheap poll.
 *
 * The wall refreshes while visible, and a refresh that re-sends every note
 * body just to learn that nothing changed would dominate the channel. This
 * action returns the revision and the note count only; the Client refetches
 * the wall solely when the number it gets back differs from what it holds.
 */
 | {
    action: 'revision';
} | {
    action: 'create';
    note: NoteInput;
    centreReserve?: CentreReserve;
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
    centreReserve?: CentreReserve;
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
