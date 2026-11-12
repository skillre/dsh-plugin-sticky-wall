/**
 * Wire and storage vocabulary shared by the Host and Client halves.
 *
 * Everything here is plain, lossless JSON: the Host and the Client live in
 * different runtimes and only these shapes cross the Connection RPC boundary.
 * Both halves are compiled from this file, so the Client bundle carries the
 * same literals without importing Host code.
 */
/** RPC endpoint path under the shared `/api` channel. */
export const ENDPOINT = 'skillre-sticky-wall/execute';
/** Sidebar panel id, main panel key, and locale namespace. */
export const PANEL_ID = 'skillre-sticky-wall';
export const LOCALE_NAMESPACE = 'skillreStickyWall';
/**
 * LEGACY storage-domain identity, kept only so the one-time migration can still
 * open the JSON domain a 0.7.x install left behind.
 *
 * 0.8.0 moved the notes onto real `.md` files under the notes directory, so
 * nothing else reads this any more. Removing it would strand an existing user's
 * wall in a format the plugin can no longer name, so it stays until the
 * migration is retired.
 */
export const LEGACY_DOMAIN_NAME = 'skillre_sticky_wall';
export const LEGACY_DOMAIN_VERSION = 1;
/** The private directory, under the DSH home, that holds one `.md` per note. */
export const NOTES_DIR_NAME = 'sticky-notes';
/** Every note file carries this suffix; the id alone is the basename. */
export const NOTE_FILE_SUFFIX = '.md';
/** Marker written once, after a successful migration, beside the notes. */
export const MIGRATION_MARKER = 'migration.json';
/**
 * The frontmatter schema generation this build writes.
 *
 * `schema:` is a forward-compatibility marker, not a migration trigger: a file
 * written by a NEWER build parses with its known keys and keeps the rest in
 * `extra` rather than being silently rewritten.
 */
export const FRONTMATTER_SCHEMA = 1;
/** Hard limits, enforced on both halves so a bad payload never reaches storage. */
export const LIMITS = Object.freeze({
    /**
     * One note's body, in characters.
     *
     * 0.8.0 lifted the old 4000-character cap, because the body now lives in a
     * plain `.md` file rather than a JSON record and a note is allowed to be a
     * real document. This is a resource guard against a pathological file, not a
     * product limit: at 200k characters a note is a short book.
     */
    body: 200_000,
    /** One note's title, in characters. */
    title: 120,
    /** A note's free-form tag list. */
    tags: 8,
    /** One tag, in characters. */
    tag: 32,
    /** Live (non-archived) notes a wall may hold. */
    notes: 400,
    /** Note ids accepted in one request. */
    bulk: 200,
    /** One note file's size on disk, in bytes; larger files are refused unread. */
    fileBytes: 4 * 1024 * 1024,
    /** Newest notes the agent `list` action returns. */
    listLimit: 50,
});
/** Pastel note colors the wall offers; the Client renders them as literal hex. */
export const COLORS = Object.freeze([
    'yellow',
    'pink',
    'green',
    'blue',
    'purple',
    'orange',
]);
/** Sort orders the wall exposes. */
export const SORTS = Object.freeze(['pinned', 'created', 'updated']);
/**
 * Card width presets.
 *
 * A free canvas looks dead when every card is the same width, so the wall keeps
 * three sizes. They are presets rather than arbitrary pixels: the card's text
 * metrics, the auto-arrange packing and the drag handles all assume a known
 * width, and a preset keeps the stored layout small and legible.
 */
export const WIDTHS = Object.freeze(['sm', 'md', 'lg']);
/** Rendered card width for each preset, in world pixels at zoom 1. */
export const WIDTH_PX = Object.freeze({
    sm: 178,
    md: 222,
    lg: 276,
});
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
export const CENTRE_RESERVE = Object.freeze({ halfWidth: 330, halfHeight: 136 });
/** Bounds of the free canvas: a note may sit anywhere inside this square. */
export const LAYOUT_LIMITS = Object.freeze({
    /** Absolute value of x and y, in world pixels. */
    coord: 20_000,
    /** Absolute rotation, in degrees. */
    rotate: 12,
});
