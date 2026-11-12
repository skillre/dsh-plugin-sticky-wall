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
import { COLORS, FRONTMATTER_SCHEMA, LIMITS, WIDTHS, } from './types.js';
/** Frontmatter keys this build understands and re-serializes itself. */
const KNOWN_KEYS = new Set([
    'id',
    'schema',
    'title',
    'color',
    'tags',
    'pinned',
    'archived',
    'width',
    'x',
    'y',
    'rotate',
    'created',
    'updated',
]);
/** The opening/closing delimiter. `---` opens; either form closes. */
const DELIMITER = '---';
/** Zero-pad a number to two digits. */
function pad(value) {
    return String(value).padStart(2, '0');
}
/** Normalize a timestamp to ISO-8601; unparseable input falls back. */
export function normalizeTime(raw, fallback) {
    if (typeof raw === 'string' && raw.trim() !== '') {
        const trimmed = raw.trim();
        // An unquoted YAML timestamp parses as a Date; keep the authored string when
        // it is already a valid instant so timezone information is not lost.
        const stamp = new Date(trimmed);
        if (!Number.isNaN(stamp.getTime()))
            return trimmed;
    }
    return fallback;
}
/** Build a local ISO timestamp (with offset) for a fresh note. */
export function nowIso(at = new Date()) {
    const offset = -at.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const absolute = Math.abs(offset);
    return (`${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
        `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
        `.${String(at.getMilliseconds()).padStart(3, '0')}` +
        `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`);
}
/**
 * Strip a surrounding pair of quotes, if present.
 *
 * Both double and single quotes are accepted. A double-quoted scalar also has its
 * backslash escapes unescaped, because {@link quote} writes them that way and the
 * pair must round-trip.
 */
function unquote(raw) {
    const text = raw.trim();
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        const inner = text.slice(1, -1);
        try {
            return JSON.parse(`"${inner}"`);
        }
        catch {
            return inner;
        }
    }
    if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
        // YAML single quotes escape an inner quote by doubling it.
        return text.slice(1, -1).replace(/''/g, "'");
    }
    return text;
}
/** Read one scalar as a boolean, accepting the YAML spellings. */
function asBoolean(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const value = raw.trim().toLowerCase();
    if (value === 'true' || value === 'yes' || value === 'on')
        return true;
    if (value === 'false' || value === 'no' || value === 'off')
        return false;
    return undefined;
}
/** Read one scalar as a finite number, or `undefined`. */
function asNumber(raw) {
    if (typeof raw !== 'string' || raw.trim() === '')
        return undefined;
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value : undefined;
}
/**
 * Split an inline YAML list (`[a, b, c]`) into its items.
 *
 * A bare scalar is treated as a one-item list, which is what a hand-written
 * `tags: work` means. An empty `[]` is an empty list.
 */
function parseList(raw) {
    const text = raw.trim();
    if (text === '')
        return [];
    if (text.startsWith('[') && text.endsWith(']')) {
        const inner = text.slice(1, -1).trim();
        if (inner === '')
            return [];
        return splitInline(inner).map((item) => unquote(item)).filter((item) => item !== '');
    }
    const single = unquote(text);
    return single === '' ? [] : [single];
}
/**
 * Split a comma-separated inline list, honouring quotes.
 *
 * A naive `split(',')` breaks `tags: ["a,b", c]`, so the scan tracks quote state.
 */
function splitInline(text) {
    const items = [];
    let current = '';
    let quote = null;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index] ?? '';
        if (quote !== null) {
            current += char;
            if (char === quote)
                quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }
        if (char === ',') {
            items.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    if (current.trim() !== '')
        items.push(current);
    return items;
}
/** Locate the frontmatter block; returns `null` when the file has none. */
export function findFrontmatter(text) {
    // Only the FIRST line may open the block. A `---` further down is a horizontal
    // rule in the body, and treating it as a delimiter would swallow real content.
    const firstBreak = text.indexOf('\n');
    const firstLine = (firstBreak === -1 ? text : text.slice(0, firstBreak)).replace(/\r$/, '').trim();
    if (firstLine !== DELIMITER)
        return null;
    if (firstBreak === -1)
        return null;
    const rest = text.slice(firstBreak + 1);
    const lines = rest.split('\n');
    let offset = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] ?? '').replace(/\r$/, '');
        const trimmed = line.trim();
        // An opening delimiter with no closing one is not frontmatter: the user is
        // writing a document that starts with a rule. Fall back to plain body.
        if (trimmed === DELIMITER || trimmed === '...') {
            const bodyStart = offset + line.length + 1;
            return { raw: rest.slice(0, offset), body: rest.slice(bodyStart) };
        }
        offset += line.length + 1;
    }
    return null;
}
/**
 * Parse a frontmatter block into its key/value pairs, last writer winning.
 *
 * `malformed` collects top-level lines that are not `key: value`, so the caller
 * can flag the note while still keeping every value it did understand.
 */
export function parseFrontmatter(raw, malformed = []) {
    const entries = new Map();
    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    let currentKey = null;
    let currentValue = '';
    const flush = () => {
        if (currentKey !== null)
            entries.set(currentKey, currentValue.trim());
        currentKey = null;
        currentValue = '';
    };
    for (const line of lines) {
        if (line.trim() === '' || line.trimStart().startsWith('#'))
            continue;
        // An indented line continues the previous key's value (a folded or block
        // scalar). The subset does not interpret YAML block syntax, but it must not
        // silently attribute a continuation to the wrong key.
        if (/^\s/.test(line) && currentKey !== null) {
            currentValue += ` ${line.trim()}`;
            continue;
        }
        const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (match === null) {
            // A top-level line that is neither `key: value` nor a continuation is
            // genuinely malformed for this subset. Record it so the caller can flag the
            // note instead of pretending the block was fully understood.
            flush();
            malformed.push(line.trim());
            continue;
        }
        flush();
        currentKey = match[1] ?? '';
        currentValue = match[2] ?? '';
    }
    flush();
    return entries;
}
/** Normalize a tag list to the stored shape. */
function normalizeTags(raw) {
    const seen = new Set();
    for (const entry of raw) {
        const tag = entry.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, LIMITS.tag);
        if (tag === '' || seen.has(tag))
            continue;
        seen.add(tag);
        if (seen.size >= LIMITS.tags)
            break;
    }
    return [...seen];
}
/** Accept only a declared pastel key. */
function normalizeColor(raw) {
    const value = (raw ?? '').trim();
    return COLORS.find((color) => color === value) ?? 'yellow';
}
/** Accept only a declared width preset. */
function normalizeWidth(raw) {
    const value = (raw ?? '').trim();
    return WIDTHS.find((width) => width === value) ?? 'md';
}
/**
 * Rebuild the layout from the four flat keys.
 *
 * All four absent means "never placed" — the Client derives a preview position
 * from the id. Any one present means the note HAS been placed, so the rest fall
 * back to defaults rather than producing a half-valid placement.
 */
function readLayout(entries) {
    const x = entries.has('x') ? asNumber(entries.get('x')) : undefined;
    const y = entries.has('y') ? asNumber(entries.get('y')) : undefined;
    const rotate = entries.has('rotate') ? asNumber(entries.get('rotate')) : undefined;
    const width = entries.has('width') ? entries.get('width') : undefined;
    if (x === undefined && y === undefined && rotate === undefined && width === undefined)
        return null;
    return {
        x: x ?? 0,
        y: y ?? 0,
        rotate: rotate ?? 0,
        width: normalizeWidth(width),
    };
}
/**
 * Parse one note file.
 *
 * Never throws. A frontmatter block that cannot be read yields a note with
 * defaults, `metaError` set, and the WHOLE FILE as the body, so nothing typed is
 * lost and the wall still shows the card.
 */
export function parseNoteFile(text, options) {
    const source = text.replace(/\r\n?/g, '\n');
    const block = findFrontmatter(source);
    const fallback = options.fallbackTime;
    if (block === null) {
        // Either genuinely no frontmatter, or an unterminated opening delimiter that
        // is really body text. Both land here, and both keep the full text.
        return {
            hadFrontmatter: false,
            note: {
                id: options.fallbackId,
                title: '',
                body: source,
                tags: [],
                color: 'yellow',
                pinned: false,
                archived: false,
                createdAt: fallback,
                updatedAt: fallback,
                layout: null,
            },
        };
    }
    const malformed = [];
    const entries = parseFrontmatter(block.raw, malformed);
    const id = unquote(entries.get('id') ?? '').trim();
    const title = unquote(entries.get('title') ?? '').slice(0, LIMITS.title);
    const extra = {};
    for (const [key, value] of entries) {
        if (!KNOWN_KEYS.has(key))
            extra[key] = value;
    }
    const note = {
        // An explicit id wins; the filename is the fallback so a hand-created file
        // with no frontmatter still becomes a working note rather than a duplicate.
        id: id === '' ? options.fallbackId : id,
        title,
        // The body is exactly what follows the delimiter, minus the one newline that
        // separates the closing delimiter line from it. Nothing else is trimmed: the
        // height estimate and the round-trip both depend on byte fidelity, so the
        // separator is removed by exactly one newline and never by a `trim()`.
        body: stripLeadingBreak(block.body),
        tags: normalizeTags(parseList(entries.get('tags') ?? '')),
        color: normalizeColor(entries.get('color')),
        pinned: asBoolean(entries.get('pinned')) === true,
        archived: asBoolean(entries.get('archived')) === true,
        createdAt: normalizeTime(unquote(entries.get('created') ?? ''), fallback),
        updatedAt: normalizeTime(unquote(entries.get('updated') ?? ''), fallback),
        layout: readLayout(entries),
    };
    const parsed = { note, hadFrontmatter: true };
    const schema = asNumber(entries.get('schema'));
    if (schema !== undefined && schema > FRONTMATTER_SCHEMA) {
        // A newer build wrote this file. Parse what is understood, keep the rest, and
        // say so — never rewrite over a format this build does not fully know.
        note.metaError = `newer-schema:${String(schema)}`;
    }
    else if (malformed.length > 0) {
        // The block parsed only partially: every value it did yield is kept, but the
        // wall flags the card so a mangled frontmatter is visible instead of silently
        // dropping attributes the user expected.
        note.metaError = 'malformed-frontmatter';
    }
    if (Object.keys(extra).length > 0)
        parsed.note.extra = extra;
    return parsed;
}
/** Quote and escape a scalar so the parser reads back exactly this string. */
function quote(value) {
    // A JSON string is a valid YAML double-quoted scalar, and its escapes are the
    // ones `unquote` reverses. Cheap, exact, and it survives any punctuation.
    return JSON.stringify(value);
}
/** Serialize a scalar plain when it is unambiguous, quoted otherwise. */
function scalar(value) {
    if (value !== '' && !/^[\s"'[\]{#&*!|>%@`,:?\-]/.test(value) && !/\s$/.test(value) && !/^(true|false|null|yes|no|on|off|~)$/i.test(value) && !/^[+-]?\d/.test(value)) {
        return value;
    }
    return quote(value);
}
/** Serialize the layout's four flat keys; a `null` layout writes none of them. */
function layoutLines(layout) {
    if (layout === null)
        return [];
    return [
        `width: ${layout.width}`,
        `x: ${String(layout.x)}`,
        `y: ${String(layout.y)}`,
        `rotate: ${String(layout.rotate)}`,
    ];
}
/**
 * Serialize one note back to file text.
 *
 * The output is stable: the same note always produces the same bytes, so a
 * no-op save cannot churn the file's mtime and trigger a spurious refresh.
 */
export function serializeNoteFile(note) {
    const lines = [DELIMITER];
    lines.push(`id: ${scalar(note.id)}`);
    lines.push(`schema: ${String(FRONTMATTER_SCHEMA)}`);
    if (note.title !== '')
        lines.push(`title: ${quote(note.title)}`);
    lines.push(`color: ${note.color}`);
    if (note.tags.length > 0)
        lines.push(`tags: [${note.tags.map((tag) => quote(tag)).join(', ')}]`);
    if (note.pinned)
        lines.push('pinned: true');
    if (note.archived)
        lines.push('archived: true');
    lines.push(...layoutLines(note.layout));
    lines.push(`created: ${quote(note.createdAt)}`);
    lines.push(`updated: ${quote(note.updatedAt)}`);
    if (note.extra !== undefined) {
        for (const [key, value] of Object.entries(note.extra)) {
            // Never let an extra key shadow a managed one.
            if (KNOWN_KEYS.has(key))
                continue;
            lines.push(`${key}: ${scalar(value)}`);
        }
    }
    lines.push(DELIMITER);
    // One blank line between the delimiter and the body so the body never begins
    // with the delimiter itself, which `findFrontmatter` would otherwise treat as
    // the closing line of the frontmatter.
    return `${lines.join('\n')}\n\n${note.body}`;
}
/** True when a file name is a plausible note id, so a path cannot escape. */
export function isNoteId(value) {
    return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
/**
 * Remove the single newline that separates the closing delimiter from the body.
 *
 * Exactly one, and never a `trim()`: the body must round-trip byte for byte, and
 * a body that genuinely starts with a blank line has to keep it.
 */
function stripLeadingBreak(body) {
    return body.startsWith('\n') ? body.slice(1) : body;
}
/** The `.md` basename for a note id. */
export function fileNameOf(id) {
    return `${id}.md`;
}
/** Recover a note id from a file's basename; `null` when it is not one of ours. */
export function idOfFile(name) {
    if (!name.endsWith('.md'))
        return null;
    const id = name.slice(0, -3);
    return isNoteId(id) ? id : null;
}
