/**
 * Client entry of the sticky wall.
 *
 * Registers two surfaces on the plugin's own Fiber:
 * - `sidebar.panellist` — the left-sidebar entry (a list slot, so the shell
 *   orders it among the shipped panels and selects it through `ctx.layout`);
 * - `main` — the wall page keyed by the same panel id, so selecting the entry
 *   swaps the centre column to the wall.
 *
 * The dictionaries are registered through the shared locale service, so the
 * wall follows the GUI language without a reload. The module imports nothing
 * but `react` from the browser module table; every relative import is bundled
 * by `scripts/build-client.mjs`.
 */

import { createApi } from './api.js'
import type { ClientApi } from './api.js'
import type { ClientContext, Disposer } from './contracts.js'
import { en, NAMESPACE, zh } from './text.js'
import type { Translate } from './text.js'
import { SidebarGlyph, WallPage } from './view.jsx'
import { PANEL_ID } from '../types.js'

/** Services this module cannot run without. */
export const inject = ['slots', 'locale', 'connection']

/** The sidebar entry slot (list) and the centre column slot (keyed). */
const SIDEBAR_SLOT = 'sidebar.panellist'
const MAIN_SLOT = 'main'

/** Register the plugin's dictionaries for both shipped locales. */
function registerDictionaries(ctx: ClientContext): Disposer[] {
  const disposers: Disposer[] = []
  for (const [locale, dict] of [['zh', zh], ['en', en]] as const) {
    try {
      disposers.push(ctx.locale.register(NAMESPACE, { [locale]: { ...dict } }))
    } catch {
      // A stale bundle generation can still hold (namespace, locale); losing
      // one dictionary degrades that language to readable key text, while
      // letting the throw escape would blank the whole page.
    }
  }
  return disposers
}

export function apply(ctx: ClientContext): void {
  const lifetime = new AbortController()
  const disposers = registerDictionaries(ctx)
  const t = ctx.locale.bind(NAMESPACE) as Translate
  const api: ClientApi = createApi(ctx.connection, lifetime.signal)

  ctx.effect(() => () => {
    lifetime.abort()
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // The Fiber may already have collected the dictionary.
      }
    }
  }, 'skillre-sticky-wall client lifetime')

  ctx.effect(
    () =>
      ctx.slots.inject(SIDEBAR_SLOT, () =>
        ctx.slots.register({ name: SIDEBAR_SLOT, id: PANEL_ID, order: 30, label: () => t('nav') }, SidebarGlyph),
      ),
    'skillre-sticky-wall sidebar entry',
  )

  ctx.effect(
    () => ctx.slots.inject(MAIN_SLOT, () => ctx.slots.register({ name: MAIN_SLOT, key: PANEL_ID }, () => <WallPage api={api} locale={ctx.locale} t={t} />)),
    'skillre-sticky-wall wall page',
  )
}
