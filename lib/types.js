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
/** Storage domain name; the per-record layout gives one file per note. */
export const DOMAIN_NAME = 'skillre_sticky_wall';
export const DOMAIN_VERSION = 1;
/** Hard limits, enforced on both halves so a bad payload never reaches storage. */
export const LIMITS = Object.freeze({
    /** One note's body, in characters. */
    body: 4000,
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
