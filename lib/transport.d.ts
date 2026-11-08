/**
 * Host ↔ Client transport: one exact Fetch route inside Connection's fence.
 *
 * Connection owns the Host/Origin check, the browser-session authentication and
 * the Peer scope; this module registers one exact `POST /api/<endpoint>` route
 * and only has to validate its own envelope and payload. No physical server, no
 * Express, and no second RPC channel is claimed.
 *
 * The wire envelope is the inspected Connection unary shape:
 * `{ type: 'client-request', rpcId, method, payload }` in and
 * `{ type: 'server-response', rpcId, result: { ok: true, value } | { ok: false, error } }`
 * out. A non-owner Peer is rejected by Connection before this handler runs.
 */
import { type CentreReserve, type Note, type NoteInput, type NoteLayout, type NotePatch, type NoteSort, type WallResult } from './types.js';
/** Path of the exact route, under the shared `/api` channel. */
export declare const EXECUTE_PATH = "/api/skillre-sticky-wall/execute";
/** One buffered exact Fetch route as the Connection registry accepts it. */
export interface FetchRoute {
    readonly path: string;
    readonly methods: readonly ['POST'];
    readonly requestBody: 'buffered';
    readonly fetch: (request: Request) => Promise<Response>;
}
/** The Host Connection face this plugin depends on. */
export interface HostConnection {
    readonly fetch: {
        register(route: FetchRoute): () => Promise<void>;
    };
}
/** The store operations the route dispatches onto. */
export interface WallActions {
    list(includeArchived?: boolean, sort?: NoteSort): Note[];
    create(input: NoteInput): Promise<Note>;
    update(id: string, patch: NotePatch): Promise<Note>;
    setArchived(ids: string[], archived: boolean): Promise<Note[]>;
    remove(ids: string[]): Promise<string[]>;
    clearArchived(): Promise<string[]>;
    move(id: string, layout: NoteLayout): Promise<Note>;
    arrange(options?: {
        centreReserve?: CentreReserve | undefined;
    }): Promise<Note[]>;
    create(input: NoteInput, id?: string, options?: {
        centreReserve?: CentreReserve | undefined;
    }): Promise<Note>;
}
/**
 * Build the exact route Connection registers; every failure stays inside the
 * envelope. `ready` resolves the store lazily so a storage-open failure is
 * reported on the first request instead of at registration time.
 */
export declare function createExecuteRoute(ready: () => Promise<WallActions>): FetchRoute;
/** Re-export the result envelope type for the Client half's structural mirror. */
export type { WallResult };
