/**
 * The `.md` file format: YAML frontmatter plus a free-text body.
 *
 * A note is a real file the user owns. The frontmatter carries the structured
 * attributes (id, colour, placement, timestamps); everything after the closing
 * delimiter is the body, which is ordinary Markdown that a person or a model can
 * edit with any tool.
 *
 * Three properties matter more than completeness here:
 *
 * 1. **Never throw on bad input.** `parse` always returns a document. A broken
 *    YAML block becomes a note with default attributes and a `metaError`, and the
 *    raw text is kept as the body rather than discarded. A wall must not lose a
 *    note because one line of YAML is malformed — that is the fail-soft contract
 *    the storage domain used to give us for free.
 *
 * 2. **The body is never the frontmatter.** The body is exactly the text after
 *    the closing delimiter. Nothing here normalizes, trims or reflows it: the
 *    card height estimate walks this text line by line, and a stray trim would
 *    change every card's geometry. It is also what keeps a round-trip lossless.
 *
 * 3. **Unknown keys survive.** A newer build, or the user's own hand-written
 *    `due:` field, is preserved in `extra` and written back. Silently dropping it
 *    would destroy data the plugin did not create.
 *
 * The parser deliberately implements a SMALL YAML subset — scalars, inline lists,
 * booleans, numbers and quoted strings — because that is the entire surface the
 * frontmatter uses. A full YAML engine would add weight and, worse, would accept
 * constructs this module cannot faithfully re-serialize.
 */
import { type Note } from './types.js';
/** One parsed note file: the note plus anything the round-trip must preserve. */
export interface ParsedNoteFile {
    note: Note;
    /** True when the file had a frontmatter block, readable or not. */
    hadFrontmatter: boolean;
}
/** Everything `parse` needs to know about the file it is reading. */
export interface ParseOptions {
    /** Fallback identity when the frontmatter has no `id` (the basename). */
    fallbackId: string;
    /** Fallback timestamps, normally the file's mtime. */
    fallbackTime: string;
}
/** Normalize a timestamp to ISO-8601; unparseable input falls back. */
export declare function normalizeTime(raw: unknown, fallback: string): string;
/** Build a local ISO timestamp (with offset) for a fresh note. */
export declare function nowIso(at?: Date): string;
/** Locate the frontmatter block; returns `null` when the file has none. */
export declare function findFrontmatter(text: string): {
    raw: string;
    body: string;
} | null;
/**
 * Parse a frontmatter block into its key/value pairs, last writer winning.
 *
 * `malformed` collects top-level lines that are not `key: value`, so the caller
 * can flag the note while still keeping every value it did understand.
 */
export declare function parseFrontmatter(raw: string, malformed?: string[]): Map<string, string>;
/**
 * Parse one note file.
 *
 * Never throws. A frontmatter block that cannot be read yields a note with
 * defaults, `metaError` set, and the WHOLE FILE as the body, so nothing typed is
 * lost and the wall still shows the card.
 */
export declare function parseNoteFile(text: string, options: ParseOptions): ParsedNoteFile;
/**
 * Serialize one note back to file text.
 *
 * The output is stable: the same note always produces the same bytes, so a
 * no-op save cannot churn the file's mtime and trigger a spurious refresh.
 */
export declare function serializeNoteFile(note: Note): string;
/** True when a file name is a plausible note id, so a path cannot escape. */
export declare function isNoteId(value: string): boolean;
/** The `.md` basename for a note id. */
export declare function fileNameOf(id: string): string;
/** Recover a note id from a file's basename; `null` when it is not one of ours. */
export declare function idOfFile(name: string): string | null;
