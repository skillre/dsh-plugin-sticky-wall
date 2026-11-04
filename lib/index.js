/**
 * Host entry of the sticky wall.
 *
 * Ownership split: this half owns durable notes (storage domain) and the
 * Connection route the Client renders from; the Client half owns only view
 * state. Everything registered here — the domain handle, the exact Fetch
 * route, and the optional agent tool — belongs to this plugin's Fiber, so
 * stopping or updating the row releases all three with no residue.
 */
import { Config, resolveConfig } from './config.js';
import { StickyWallStore } from './store.js';
import { createExecuteRoute } from './transport.js';
import { LIMITS } from './types.js';
export { Config, StickyWallStore };
export const name = 'skillre-sticky-wall';
/**
 * Required services. `storageDomain` provides the durable note table;
 * `connection` provides the authenticated Client route. Both are declared hard
 * dependencies so a profile missing either fails loudly instead of mounting a
 * wall that can never persist or be reached.
 */
export const inject = ['storageDomain', 'connection'];
/** Read an optional Cordis service without declaring it required. */
function service(ctx, key) {
    return ctx.get(key);
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
    if (action === 'delete' || action === 'clear-archived') {
        const removed = Array.isArray(data.removed) ? data.removed.length : 0;
        return `Removed ${removed} note${removed === 1 ? '' : 's'}.`;
    }
    if (action === 'archive') {
        const notes = Array.isArray(data.notes) ? data.notes : [];
        return notes.length === 0 ? 'No note changed.' : notes.map((note) => `${note.id} ${note.archived ? 'archived' : 'restored'}`).join('\n');
    }
    const note = data.note;
    if (note)
        return `${action === 'create' ? 'Created' : 'Updated'} note ${note.id}${note.title ? ` (${note.title})` : ''}: ${note.body.replace(/\s+/g, ' ').slice(0, 140)}`;
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
            description: "Capture and manage sticky notes on the user's DSH note wall (便签墙): quick inspiration, temporary tasks and short reminders. Use it when the user asks to note something down, list their notes, update or pin one, or clean up archived notes.",
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['action'],
                properties: {
                    action: { type: 'string', enum: ['list', 'create', 'update', 'archive', 'delete', 'clear-archived'] },
                    id: { type: 'string', description: 'Exact note id; required by update.' },
                    ids: { type: 'array', items: { type: 'string' }, description: 'Note ids; required by archive and delete (1–200 entries).' },
                    body: { type: 'string', description: `The note text (1–${LIMITS.body} characters). Required by create; optional patch field for update.` },
                    title: { type: 'string', description: `Optional short heading (max ${LIMITS.title} characters).` },
                    tags: { type: 'array', items: { type: 'string' }, description: `Optional lowercase tags (max ${LIMITS.tags}).` },
                    color: { type: 'string', enum: ['yellow', 'pink', 'green', 'blue', 'purple', 'orange'], description: 'Optional pastel note color.' },
                    pinned: { type: 'boolean', description: 'Pin the note to the top of the wall.' },
                    archived: { type: 'boolean', description: 'Archive (true) or restore (false) one note on update.' },
                    includeArchived: { type: 'boolean', description: 'list only: include archived notes.' },
                    limit: { type: 'integer', description: 'list only: how many notes to return (1–50, default 20).' },
                },
            },
            timeoutMs: 20_000,
            isConcurrencySafe(args) {
                return typeof args === 'object' && args !== null && args.action === 'list';
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
                switch (args.action) {
                    case 'list':
                        return { action: 'list', ...store.summary(typeof args.limit === 'number' ? args.limit : 20) };
                    case 'create':
                        return {
                            action: 'create',
                            note: await store.create({
                                body: String(args.body ?? ''),
                                ...(typeof args.title === 'string' ? { title: args.title } : {}),
                                ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
                                ...(typeof args.color === 'string' ? { color: args.color } : {}),
                                ...(typeof args.pinned === 'boolean' ? { pinned: args.pinned } : {}),
                            }),
                        };
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
                    case 'archive':
                        return { action: 'archive', notes: await store.setArchived(args.ids ?? [], args.archived === true) };
                    case 'delete':
                        return { action: 'delete', removed: await store.remove(args.ids ?? []) };
                    case 'clear-archived':
                        return { action: 'clear-archived', removed: await store.clearArchived() };
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
    const facility = service(ctx, 'storageDomain');
    if (!facility?.open)
        throw new Error('Sticky wall requires the DSH storageDomain facility.');
    const ready = StickyWallStore.open((spec) => facility.open(spec), {
        maxNotes: config.maxNotes,
        seedWelcomeNote: config.seedWelcomeNote,
    });
    ready.catch((error) => {
        // The route and the tool both await `ready`, so the failure also reaches the
        // first caller; log it once so it is never silent in the Host log.
        ctx.logger?.error?.(`sticky-wall: storage domain failed to open: ${error instanceof Error ? error.message : String(error)}`);
    });
    ctx.effect(() => () => {
        void ready.then((store) => store.close()).catch(() => { });
    }, 'skillre-sticky-wall storage lifetime');
    ctx.effect(() => connection.fetch.register(createExecuteRoute(async () => {
        const store = await ready;
        return {
            list: (includeArchived, sort) => store.list(includeArchived, sort),
            create: (input) => store.create(input),
            update: (id, patch) => store.update(id, patch),
            setArchived: (ids, archived) => store.setArchived(ids, archived),
            remove: (ids) => store.remove(ids),
            clearArchived: () => store.clearArchived(),
        };
    })), 'skillre-sticky-wall client route');
    if (config.enableAgentTool)
        registerAgentTool(ctx, ready);
}
