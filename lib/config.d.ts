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
    /**
     * Directory holding one `.md` file per note.
     *
     * Empty means "follow the DSH home": `$DSH_HOME/sticky-notes`, falling back to
     * `~/.dsh/sticky-notes`. Following the harness home is what keeps an isolated
     * profile's notes inside that profile instead of in the user's real
     * installation, and it is also what makes the wall span workspaces.
     */
    notesDir: string;
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
/**
 * Resolve the notes directory for one deployment.
 *
 * Order: an explicit `notesDir` wins; otherwise the directory follows
 * `DSH_HOME` when the harness sets it, and only then falls back to `~/.dsh`.
 * This mirrors the fleet's other data-owning plugins, and it is the reason an
 * isolated test profile cannot read or clobber the user's real notes.
 */
export declare function resolveNotesDir(configured: string, env: NodeJS.ProcessEnv, home: string): string;
