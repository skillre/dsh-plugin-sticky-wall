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
 * Required services. `storageDomain` provides the durable note table;
 * `connection` provides the authenticated Client route. Both are declared hard
 * dependencies so a profile missing either fails loudly instead of mounting a
 * wall that can never persist or be reached.
 */
export declare const inject: string[];
export declare function apply(ctx: Context, rawConfig?: Partial<WallConfig>): void;
