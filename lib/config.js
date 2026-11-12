/**
 * Plugin configuration.
 *
 * Schemastery is the loader-facing schema: DSH resolves a row's `config`
 * through it before `apply` runs, so every tunable value has a declared
 * default and an out-of-range value fails loudly at mount time instead of
 * corrupting a wall silently.
 */
import Schema from '@deepseek-ai/schemastery';
import { NOTES_DIR_NAME } from './types.js';
/** The schema DSH resolves a `skillre-sticky-wall` row's config through. */
export const Config = Schema.object({
    notesDir: Schema.string().default(''),
    maxNotes: Schema.number().min(1).max(5000).step(1).default(400),
    enableAgentTool: Schema.boolean().default(true),
    seedWelcomeNote: Schema.boolean().default(true),
});
/** Resolve raw row config, keeping the declared defaults authoritative. */
export function resolveConfig(raw = {}) {
    // Schemastery fills every declared default, so the resolved value always
    // carries the full shape; the cast states that instead of re-declaring it.
    return Config(raw);
}
/** Expand a leading `~/` against the user's home directory. */
function expandHome(configured, home) {
    if (configured === '~')
        return home;
    if (configured.startsWith('~/'))
        return `${home}/${configured.slice(2)}`;
    return configured;
}
/**
 * Resolve the notes directory for one deployment.
 *
 * Order: an explicit `notesDir` wins; otherwise the directory follows
 * `DSH_HOME` when the harness sets it, and only then falls back to `~/.dsh`.
 * This mirrors the fleet's other data-owning plugins, and it is the reason an
 * isolated test profile cannot read or clobber the user's real notes.
 */
export function resolveNotesDir(configured, env, home) {
    const value = configured.trim();
    if (value !== '')
        return expandHome(value, home).replace(/\/+$/, '');
    const dshHome = env['DSH_HOME']?.trim();
    if (dshHome !== undefined && dshHome !== '')
        return `${dshHome.replace(/\/+$/, '')}/${NOTES_DIR_NAME}`;
    return `${home.replace(/\/+$/, '')}/.dsh/${NOTES_DIR_NAME}`;
}
