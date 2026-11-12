/**
 * Host entry of the sticky wall.
 *
 * Ownership split: this half owns durable notes (storage domain) and the
 * Connection route the Client renders from; the Client half owns only view
 * state. Everything registered here — the domain handle, the exact Fetch
 * route, and the optional agent tool — belongs to this plugin's Fiber, so
 * stopping or updating the row releases all three with no residue.
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
import type { WallConfig } from './config.js';
import { StickyWallStore } from './store.js';
export { Config, StickyWallStore };
export declare const name = "skillre-sticky-wall";
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
export declare const inject: string[];
export declare function apply(ctx: Context, rawConfig?: Partial<WallConfig>): void;
