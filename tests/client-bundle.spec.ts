import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * Integration test for the built browser artifact.
 *
 * `npm test` builds `lib/client.js` first, and this test loads it the way the
 * shell does: one `window.__ModuleLoader__.load` registration whose factory
 * receives a `require` that can only resolve the browser module table. It
 * fails if the build smuggles in a second module dependency — the exact failure
 * that would otherwise surface only as an empty slot in the page.
 */

const BUNDLE_PATH = new URL('../lib/client.js', import.meta.url)

interface LoadedModule {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => Record<string, unknown>
}

function readBundle(): string {
  try {
    return readFileSync(BUNDLE_PATH, 'utf8')
  } catch {
    throw new Error('lib/client.js is missing: run `npm run build:client` (or `npm test`) first')
  }
}

function loadBundle(): LoadedModule {
  const loaded: LoadedModule[] = []
  runInNewContext(readBundle(), {
    window: { __ModuleLoader__: { load: (entry: LoadedModule) => { loaded.push(entry) } } },
    document: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    AbortController,
    AbortSignal,
    console,
  })
  expect(loaded).toHaveLength(1)
  const entry = loaded[0]
  if (!entry) throw new Error('the bundle registered no module')
  return entry
}

/**
 * The baseline React face the shipped module table provides.
 *
 * It is deliberately complete for what the bundle uses: a hook missing here is a
 * real defect, not a test gap, because the browser module table would throw the
 * same TypeError at runtime. `memo` is identity here (it is called at module
 * scope), which is enough to prove the bundle resolves and registers.
 */
const REACT_STUB = {
  createElement: () => null,
  Fragment: () => null,
  memo: <T,>(component: T): T => component,
  useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => ({ current: value }),
  jsx: () => null,
  jsxs: () => null,
  jsxDEV: () => null,
}

describe('client bundle', () => {
  it('registers exactly one module under the package name', () => {
    expect(loadBundle().id).toBe('@skillre/dsh-plugin-sticky-wall')
  })

  it('requires only the baseline react modules the module table seeds', () => {
    // `react` and `react/jsx-runtime` are both platform seed words: the shipped
    // renderer itself requires them, so they resolve from the static table and
    // need no `dsh.client.external` declaration.
    const required: string[] = []
    loadBundle().factory((id) => { required.push(id); return REACT_STUB })
    expect([...new Set(required)]).toEqual(['react', 'react/jsx-runtime'])
  })

  it('exports the Cordis client plugin contract', () => {
    const plugin = loadBundle().factory(() => REACT_STUB)
    expect(plugin.apply).toBeTypeOf('function')
    expect(plugin.inject).toEqual(['slots', 'locale', 'connection'])
  })

  it('registers the sidebar entry and the keyed main page on apply', () => {
    const plugin = loadBundle().factory(() => REACT_STUB)
    const registrations: Array<{ slot: string; options: Record<string, unknown> }> = []
    const dictionaries: Array<{ namespace: string; locales: string[] }> = []
    const effects: string[] = []
    const ctx = {
      effect: (callback: () => unknown, label?: string) => {
        effects.push(label ?? '')
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      locale: {
        getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh' }, { id: 'en' }], revision: 0 }),
        subscribe: () => () => {},
        register: (namespace: string, locales: Record<string, unknown>) => {
          dictionaries.push({ namespace, locales: Object.keys(locales) })
          return () => {}
        },
        bind: () => (key: string) => key,
      },
      connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
      slots: {
        inject: (slot: string, callback: () => unknown) => callback(),
        register: (options: Record<string, unknown>) => {
          registrations.push({ slot: String(options.name), options })
          return () => {}
        },
      },
    }
    ;(plugin.apply as (context: unknown) => void)(ctx)
    // ONE registration carrying both shipped locales: two calls for the same
    // namespace would risk the second replacing the first.
    expect(dictionaries).toEqual([{ namespace: 'skillreStickyWall', locales: ['zh', 'en'] }])
    expect(registrations.map((entry) => entry.slot)).toEqual(['sidebar.panellist', 'main'])
    expect(registrations[0]?.options).toMatchObject({ id: 'skillre-sticky-wall', order: 30 })
    expect(registrations[1]?.options).toMatchObject({ key: 'skillre-sticky-wall' })
    expect(effects).toHaveLength(3)
  })
})
