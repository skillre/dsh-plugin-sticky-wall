/**
 * Host entry of the sticky wall.
 *
 * Ownership split: this half owns durable notes (storage domain) and the
 * Connection route the Client renders from; the Client half owns only view
 * state. Everything registered here — the domain handle, the exact Fetch
 * route, and the optional agent tool — belongs to this plugin's Fiber, so
 * stopping or updating the row releases all three with no residue.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { Config, resolveConfig, resolveNotesDir } from './config.js';
import { StickyWallStore } from './store.js';
import { createExecuteRoute } from './transport.js';
import { COLORS, LEGACY_DOMAIN_NAME, LEGACY_DOMAIN_VERSION, LIMITS, WIDTHS } from './types.js';
export { Config, StickyWallStore };
export const name = 'skillre-sticky-wall';
/**
 * Required services.
 *
 * `connection` provides the authenticated Client route and is a hard dependency:
 * without it the wall could never be reached, so mounting should fail loudly.
 *
 * `storageDomain` is deliberately NOT listed. Notes live on disk now, and the
 * domain is consulted only when a 0.7.x install still needs migrating, so it is
 * read through `ctx.get()` and its absence is a normal, supported state (a fresh
 * install has nothing to migrate).
 */
export const inject = ['connection'];
/** Read an optional Cordis service without declaring it required. */
function service(ctx, key) {
    return ctx.get(key);
}
/**
 * The record schema the legacy domain validates every stored note against.
 *
 * This MUST be a real schema. `storageDomain` runs
 * `tableSpec.valueSchema.parse(raw)` on every record while opening the domain,
 * so declaring the table as a bare `{}` makes `valueSchema` undefined, throws on
 * the first record, and — because the spec asks for `invalidRecords:
 * 'backup-and-skip'` — makes the backend move EVERY note aside as
 * `<id>.json.bak.<stamp>` and treat it as absent. That is exactly what shipped
 * in 0.8.0: the migration reported zero notes, seeded a welcome note, and the
 * user's wall appeared empty while the data sat renamed on disk.
 *
 * It is deliberately permissive (`passthrough`, every field optional) because
 * its job is to LOAD a retired format, not to police it: a record missing a
 * field must still migrate with a sane default rather than be quarantined.
 */
const LegacyNoteSchema = z
    .object({
    id: z.string().min(1),
    title: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    color: z.string().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    layout: z
        .object({
        x: z.number(),
        y: z.number(),
        rotate: z.number(),
        width: z.string(),
    })
        .nullable()
        .optional(),
})
    .passthrough();
/**
 * Drain a 0.7.x install's storage-domain notes so they can be migrated.
 *
 * The domain's `notes` table is the ONLY thing read here: the migration writes
 * `.md` files and never writes back, so a failed migration leaves the legacy
 * records untouched and the next start retries. The handle is always closed,
 * even when reading throws, because an open domain reserves its name for the
 * whole process.
 */
async function readLegacyNotes(facility) {
    const domain = await facility.open({
        name: LEGACY_DOMAIN_NAME,
        version: LEGACY_DOMAIN_VERSION,
        layout: 'per-record',
        // `backup-and-skip` is kept: it is the only accepted value, and with a real
        // schema it now means what it was meant to mean — one genuinely corrupt
        // record is set aside instead of sinking the whole migration.
        invalidRecords: 'backup-and-skip',
        tables: { notes: { valueSchema: LegacyNoteSchema } },
    });
    try {
        const notes = [];
        for (const [key, value] of domain.table('notes').entries()) {
            const record = value;
            if (record === null || typeof record !== 'object')
                continue;
            const stamp = new Date().toISOString();
            notes.push({
                // The storage key IS the note id; trust it over a disagreeing field so a
                // half-written record still migrates under the identity the wall stored.
                id: typeof record.id === 'string' && record.id !== '' ? record.id : key,
                title: typeof record.title === 'string' ? record.title : '',
                body: typeof record.body === 'string' ? record.body : '',
                tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
                color: COLORS.includes(String(record.color)) ? record.color : 'yellow',
                pinned: record.pinned === true,
                archived: record.archived === true,
                createdAt: typeof record.createdAt === 'string' ? record.createdAt : stamp,
                updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : stamp,
                layout: record.layout === null || record.layout === undefined
                    ? null
                    : {
                        x: Number(record.layout.x) || 0,
                        y: Number(record.layout.y) || 0,
                        rotate: Number(record.layout.rotate) || 0,
                        width: WIDTHS.includes(String(record.layout.width))
                            ? record.layout.width
                            : 'md',
                    },
            });
        }
        return notes;
    }
    finally {
        await domain.close();
    }
}
/**
 * The directory a 0.7.x install's storage domain wrote its records into.
 *
 * It sits beside the notes directory, under the same DSH home, so it is derived
 * rather than configured: `storages/<domain name>/notes`. The recovery path uses
 * it to find the `<id>.json.bak.<stamp>` files a broken 0.8.0 run left behind.
 */
function legacyNotesDirOf(notesDir) {
    const home = dirname(dirname(notesDir));
    return join(home, 'storages', LEGACY_DOMAIN_NAME, 'notes');
}
/** Model-facing text for one tool result; short, deterministic and readable. */
function renderWall(value) {
    const data = (value ?? {});
    const action = typeof data.action === 'string' ? data.action : 'result';
    if (action === 'list') {
        const notes = Array.isArray(data.notes) ? data.notes : [];
        if (notes.length === 0)
            return 'The note wall is empty.';
        const lines = notes.map((note) => {
            const pin = note.pinned ? '📌 ' : '';
            const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '';
            const archived = note.archived ? ' (archived)' : '';
            const heading = note.title ? `${note.title}: ` : '';
            return `- ${pin}${note.id}${archived}${tags} ${heading}${note.body.replace(/\s+/g, ' ').slice(0, 140)}`;
        });
        return [`${String(data.total ?? notes.length)} notes (${String(data.archived ?? 0)} archived):`, ...lines].join('\n');
    }
    if (action === 'read') {
        // The whole point of this action: the model gets the note's FULL text, not a
        // 140-character head. Without it an agent asked to expand a note had to ask
        // the user to paste it back, which is exactly the friction this removes.
        const note = data.note;
        if (note === undefined)
            return 'No such note.';
        const meta = [
            `id: ${note.id}`,
            note.title !== '' ? `title: ${note.title}` : '',
            `color: ${note.color}${note.pinned ? ' · pinned' : ''}${note.archived ? ' · archived' : ''}`,
            note.tags.length > 0 ? `tags: ${note.tags.join(', ')}` : '',
            typeof data.path === 'string' ? `file: ${data.path}` : '',
        ].filter((line) => line !== '');
        return [...meta, '', note.body].join('\n');
    }
    if (action === 'arrange') {
        const notes = Array.isArray(data.changed) ? data.changed : [];
        return notes.length === 0 ? 'The wall was already tidy.' : `Tidied ${notes.length} note${notes.length === 1 ? '' : 's'} into the shelf arrangement.`;
    }
    if (action === 'delete' || action === 'clear-archived') {
        const removed = Array.isArray(data.removed) ? data.removed.length : 0;
        return `Removed ${removed} note${removed === 1 ? '' : 's'}.`;
    }
    if (action === 'archive') {
        const notes = Array.isArray(data.notes) ? data.notes : [];
        return notes.length === 0 ? 'No note changed.' : notes.map((note) => `${note.id} ${note.archived ? 'archived' : 'restored'}`).join('\n');
    }
    const note = data.note;
    if (note) {
        const where = note.layout === null ? '' : ` at (${String(note.layout.x)}, ${String(note.layout.y)})`;
        return `${action === 'create' ? 'Created' : 'Updated'} note ${note.id}${note.title ? ` (${note.title})` : ''}${where}: ${note.body.replace(/\s+/g, ' ').slice(0, 140)}`;
    }
    return 'Done.';
}
/** Register the model-facing capture tool when the registry is present. */
function registerAgentTool(ctx, ready) {
    const tools = service(ctx, 'tools');
    if (!tools)
        return;
    ctx.effect(() => {
        const disposer = tools.register({
            name: 'sticky_wall',
            description: "Capture and manage sticky notes on the user's DSH note wall (便签墙): quick inspiration, temporary tasks and short reminders. " +
                'Each note is a real Markdown file under the notes directory: its attributes (title, colour, tags, pin, size, canvas position) live in the YAML frontmatter block at the top, and everything after that block is the note body. ' +
                "Use `read` to get a note's full text, `list` to scan titles, `create`/`update` to write attributes or text, and `move` to place a card on the canvas. " +
                "To revise a note's PROSE you may edit the backing file directly with the file tools — but never modify the frontmatter between the `---` lines; change attributes with this tool's `update` action instead.",
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['action'],
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'read', 'create', 'update', 'move', 'archive', 'delete', 'clear-archived', 'arrange'],
                        description: 'list: scan notes. read: one note in full. create/update: write attributes or text. move: place one card on the canvas. archive/delete: batch state changes. clear-archived: permanent sweep. arrange: tidy the whole wall.',
                    },
                    id: { type: 'string', description: 'Exact note id; required by read, update and move.' },
                    ids: { type: 'array', items: { type: 'string' }, description: `Note ids; required by archive and delete (1–${LIMITS.bulk} entries).` },
                    body: { type: 'string', description: `The note text. Required by create; optional patch field for update. Max ${LIMITS.body} characters.` },
                    title: { type: 'string', description: `Short heading (max ${LIMITS.title} characters); '' clears it.` },
                    tags: { type: 'array', items: { type: 'string' }, description: `Lowercase tags (max ${LIMITS.tags}, each max ${LIMITS.tag} characters); [] clears them.` },
                    color: { type: 'string', enum: ['yellow', 'pink', 'green', 'blue', 'purple', 'orange'], description: 'Pastel note colour.' },
                    pinned: { type: 'boolean', description: 'Pin the note to the top of the wall.' },
                    archived: {
                        type: 'boolean',
                        // Required rather than defaulted: a model asked to RESTORE a note that
                        // merely omits this field used to re-archive it, silently doing the
                        // opposite of the request. A destructive flag must never default.
                        description: 'Required by archive: true archives, false restores. Never omitted.',
                    },
                    includeArchived: { type: 'boolean', description: 'list only: include archived notes (default false).' },
                    x: { type: 'number', description: 'Canvas horizontal position of the card, in canvas pixels. Used by create and move.' },
                    y: { type: 'number', description: 'Canvas vertical position of the card, in canvas pixels. Used by create and move.' },
                    width: { type: 'string', enum: ['sm', 'md', 'lg'], description: 'Card width preset. Used by create and move.' },
                    rotate: { type: 'number', description: 'Card tilt in degrees, clamped to ±12. Used by create and move.' },
                    limit: { type: 'integer', description: `list only: how many notes to return (1–${LIMITS.listLimit}, default 20).` },
                },
            },
            timeoutMs: 20_000,
            isConcurrencySafe(args) {
                if (typeof args !== 'object' || args === null)
                    return false;
                const action = args.action;
                return action === 'list' || action === 'read';
            },
            output: {
                schema: { type: 'object', additionalProperties: true },
                render(_args, value) {
                    return [{ type: 'text', text: renderWall(value) }];
                },
            },
            async execute(raw, execution) {
                execution.signal.throwIfAborted();
                const store = await ready;
                const args = (raw ?? {});
                /** A complete placement from the flat coordinates, when all of them exist. */
                const layoutFrom = () => {
                    if (typeof args.x !== 'number' || typeof args.y !== 'number')
                        return undefined;
                    const width = args.width === 'sm' || args.width === 'md' || args.width === 'lg' ? args.width : 'md';
                    return { x: args.x, y: args.y, rotate: typeof args.rotate === 'number' ? args.rotate : 0, width };
                };
                switch (args.action) {
                    case 'list': {
                        // `includeArchived` was declared but ignored: `summary()` always read
                        // every note, so the tool's own description was false. Filter here so
                        // the flag means what it says.
                        const summary = store.summary(typeof args.limit === 'number' ? args.limit : 20);
                        const notes = args.includeArchived === true ? summary.notes : summary.notes.filter((note) => !note.archived);
                        return { action: 'list', ...summary, notes, archived: summary.archived, total: summary.total };
                    }
                    case 'read': {
                        const id = String(args.id ?? '');
                        const note = store.read(id);
                        if (note === null)
                            throw new Error(`No note with id ${JSON.stringify(id)}.`);
                        return { action: 'read', note, path: store.pathOf(id) };
                    }
                    case 'create': {
                        const placement = layoutFrom();
                        return {
                            action: 'create',
                            note: await store.create({
                                body: String(args.body ?? ''),
                                ...(typeof args.title === 'string' ? { title: args.title } : {}),
                                ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
                                ...(typeof args.color === 'string' ? { color: args.color } : {}),
                                ...(typeof args.pinned === 'boolean' ? { pinned: args.pinned } : {}),
                                ...(placement === undefined ? {} : { layout: placement }),
                            }),
                        };
                    }
                    case 'update':
                        return {
                            action: 'update',
                            note: await store.update(String(args.id ?? ''), {
                                ...(typeof args.body === 'string' ? { body: args.body } : {}),
                                ...(typeof args.title === 'string' ? { title: args.title } : {}),
                                ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
                                ...(typeof args.color === 'string' ? { color: args.color } : {}),
                                ...(typeof args.pinned === 'boolean' ? { pinned: args.pinned } : {}),
                                ...(typeof args.archived === 'boolean' ? { archived: args.archived } : {}),
                            }),
                        };
                    case 'move': {
                        const id = String(args.id ?? '');
                        const current = store.read(id);
                        if (current === null)
                            throw new Error(`No note with id ${JSON.stringify(id)}.`);
                        // A move keeps whatever the caller did not restate, so positioning a
                        // card does not silently change its size or straighten its tilt.
                        const base = current.layout;
                        const layout = {
                            x: typeof args.x === 'number' ? args.x : base?.x ?? 0,
                            y: typeof args.y === 'number' ? args.y : base?.y ?? 0,
                            rotate: typeof args.rotate === 'number' ? args.rotate : base?.rotate ?? 0,
                            width: args.width === 'sm' || args.width === 'md' || args.width === 'lg' ? args.width : base?.width ?? 'md',
                        };
                        return { action: 'move', note: await store.move(id, layout) };
                    }
                    case 'archive':
                        // A destructive flag must be stated, never inferred.
                        if (typeof args.archived !== 'boolean')
                            throw new Error('archive requires `archived: true` to archive or `archived: false` to restore.');
                        return { action: 'archive', notes: await store.setArchived(args.ids ?? [], args.archived) };
                    case 'delete':
                        return { action: 'delete', removed: await store.remove(args.ids ?? []) };
                    case 'clear-archived':
                        return { action: 'clear-archived', removed: await store.clearArchived() };
                    case 'arrange':
                        return { action: 'arrange', changed: await store.arrange() };
                    default:
                        throw new Error(`Unknown sticky_wall action ${JSON.stringify(args.action)}.`);
                }
            },
        });
        return disposer;
    }, 'skillre-sticky-wall agent tool');
}
export function apply(ctx, rawConfig = {}) {
    const config = resolveConfig(rawConfig);
    const connection = service(ctx, 'connection');
    if (!connection?.fetch?.register)
        throw new Error('Sticky wall requires the current DSH Connection exact Fetch-route registry.');
    const notesDir = resolveNotesDir(config.notesDir, process.env, homedir());
    // The legacy storage domain is now OPTIONAL: notes live on disk, and the
    // domain is only opened once, to drain a 0.7.x install's records into `.md`
    // files. A profile that never had the domain simply has nothing to migrate.
    const facility = service(ctx, 'storageDomain');
    const ready = StickyWallStore.open({
        notesDir,
        maxNotes: config.maxNotes,
        seedWelcomeNote: config.seedWelcomeNote,
        readLegacy: facility?.open === undefined ? undefined : () => readLegacyNotes(facility),
        // Where a broken 0.8.0 run quarantined the legacy records, so the corrected
        // migration can recover them from `.bak` files instead of reporting an
        // already-migrated wall and leaving the user's notes stranded.
        legacyNotesDir: facility?.open === undefined ? undefined : legacyNotesDirOf(notesDir),
        log: (message) => ctx.logger?.warn?.(`sticky-wall: ${message}`),
    });
    ready.catch((error) => {
        // The route and the tool both await `ready`, so the failure also reaches the
        // first caller; log it once so it is never silent in the Host log.
        ctx.logger?.error?.(`sticky-wall: notes directory failed to open: ${error instanceof Error ? error.message : String(error)}`);
    });
    ctx.effect(() => () => {
        void ready.then((store) => store.close()).catch(() => { });
    }, 'skillre-sticky-wall storage lifetime');
    ctx.effect(() => connection.fetch.register(createExecuteRoute(async () => {
        const store = await ready;
        return {
            list: (includeArchived, sort) => store.list(includeArchived, sort),
            revisionOf: () => store.revision,
            notesDir: store.notesDir,
            create: (input, id, options) => store.create(input, id, options),
            update: (id, patch) => store.update(id, patch),
            setArchived: (ids, archived) => store.setArchived(ids, archived),
            remove: (ids) => store.remove(ids),
            clearArchived: () => store.clearArchived(),
            move: (id, layout) => store.move(id, layout),
            arrange: (options) => store.arrange(options),
        };
    })), 'skillre-sticky-wall client route');
    if (config.enableAgentTool)
        registerAgentTool(ctx, ready);
}
