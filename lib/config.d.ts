/**
 * Plugin configuration.
 *
 * Schemastery is the loader-facing schema: DSH resolves a row's `config`
 * through it before `apply` runs, so every tunable value has a declared
 * default and an out-of-range value fails loudly at mount time instead of
 * corrupting a wall silently.
 */
import Schema from '@deepseek-ai/schemastery';
/** Effective plugin configuration after schema resolution. */
export interface WallConfig {
    /** Reject writes whose note count would exceed this cap. */
    maxNotes: number;
    /** Register the `sticky_wall` model tool so an agent can capture notes. */
    enableAgentTool: boolean;
    /** Skip the built-in welcome note on an empty wall. */
    seedWelcomeNote: boolean;
}
/** The schema DSH resolves a `skillre-sticky-wall` row's config through. */
export declare const Config: Schema<WallConfig>;
/** Resolve raw row config, keeping the declared defaults authoritative. */
export declare function resolveConfig(raw?: unknown): WallConfig;
