/**
 * Plugin configuration.
 *
 * Schemastery is the loader-facing schema: DSH resolves a row's `config`
 * through it before `apply` runs, so every tunable value has a declared
 * default and an out-of-range value fails loudly at mount time instead of
 * corrupting a wall silently.
 */

import Schema from '@deepseek-ai/schemastery'

/** Effective plugin configuration after schema resolution. */
export interface WallConfig {
  /** Reject writes whose note count would exceed this cap. */
  maxNotes: number
  /** Register the `sticky_wall` model tool so an agent can capture notes. */
  enableAgentTool: boolean
  /** Skip the built-in welcome note on an empty wall. */
  seedWelcomeNote: boolean
}

/** The schema DSH resolves a `skillre-sticky-wall` row's config through. */
export const Config: Schema<WallConfig> = Schema.object({
  maxNotes: Schema.number().min(1).max(5000).step(1).default(400),
  enableAgentTool: Schema.boolean().default(true),
  seedWelcomeNote: Schema.boolean().default(true),
})

/** Resolve raw row config, keeping the declared defaults authoritative. */
export function resolveConfig(raw: unknown = {}): WallConfig {
  // Schemastery fills every declared default, so the resolved value always
  // carries the full shape; the cast states that instead of re-declaring it.
  return Config(raw as WallConfig) as WallConfig
}
