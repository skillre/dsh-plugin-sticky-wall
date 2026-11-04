import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'
import { Config, resolveConfig } from '../src/config.js'

describe('@skillre/dsh-plugin-sticky-wall', () => {
  it('exports the Cordis function-plugin contract', () => {
    expect(plugin.name).toBe('skillre-sticky-wall')
    expect(plugin.apply).toBeTypeOf('function')
    expect('default' in plugin).toBe(false)
  })

  it('declares the storage and connection services it cannot run without', () => {
    expect(plugin.inject).toEqual(['storageDomain', 'connection'])
  })

  it('resolves declared config defaults and rejects an out-of-range cap', () => {
    expect(resolveConfig({})).toEqual({ maxNotes: 400, enableAgentTool: true, seedWelcomeNote: true })
    expect(resolveConfig({ maxNotes: 3, enableAgentTool: false }).maxNotes).toBe(3)
    // Schemastery's schema callable rejects a value outside the declared range.
    expect(() => (Config as unknown as (value: unknown) => unknown)({ maxNotes: 0 })).toThrow()
  })

  it('fails loudly instead of mounting without its required services', () => {
    const effects: string[] = []
    const ctx = { effect: (callback: () => unknown, label?: string) => { effects.push(label ?? ''); return callback() }, get: () => undefined }
    expect(() => (plugin.apply as (context: unknown, config?: unknown) => void)(ctx)).toThrow(/Connection exact Fetch-route registry/)
    expect(effects).toEqual([])
  })

  it('registers the model-facing tool when the tools service exists, and skips it otherwise', async () => {
    const definitions: Array<{ name: string; description: string; parameters: Record<string, unknown>; timeoutMs?: number }> = []
    const store = {
      table: () => ({ get: () => undefined, entries: () => [][Symbol.iterator](), keys: () => [][Symbol.iterator](), get size() { return 0 }, put: async () => {}, update: async () => undefined, delete: async () => false }),
      async close() {},
    }
    const makeContext = (withTools: boolean) => ({
      logger: { error: () => {} },
      get: (key: string) => {
        if (key === 'connection') return { fetch: { register: () => async () => {} } }
        if (key === 'storageDomain') return { open: async () => store }
        if (key === 'tools' && withTools) return { register: (definition: never) => { definitions.push(definition); return () => {} } }
        return undefined
      },
      effect: (callback: () => unknown) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    })
    ;(plugin.apply as (context: unknown, config?: unknown) => void)(makeContext(true), {})
    expect(definitions).toHaveLength(1)
    const definition = definitions[0]!
    expect(definition.name).toBe('sticky_wall')
    expect(definition.timeoutMs).toBe(20_000)
    const properties = definition.parameters.properties as Record<string, { enum?: string[] }>
    expect(properties.action?.enum).toEqual(['list', 'create', 'update', 'archive', 'delete', 'clear-archived'])
    expect((definition.parameters as { required: string[] }).required).toEqual(['action'])

    definitions.length = 0
    ;(plugin.apply as (context: unknown, config?: unknown) => void)(makeContext(false), {})
    expect(definitions).toHaveLength(0)
  })

  it('honours enableAgentTool:false and never registers the tool', () => {
    const definitions: string[] = []
    const ctx = {
      logger: { error: () => {} },
      get: (key: string) => {
        if (key === 'connection') return { fetch: { register: () => async () => {} } }
        if (key === 'storageDomain') return { open: async () => ({ table: () => ({}), close: async () => {} }) }
        if (key === 'tools') return { register: (definition: { name: string }) => { definitions.push(definition.name); return () => {} } }
        return undefined
      },
      effect: (callback: () => unknown) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    }
    ;(plugin.apply as (context: unknown, config?: unknown) => void)(ctx, { enableAgentTool: false })
    expect(definitions).toEqual([])
  })

  it('opens the domain, registers the route and releases both on disposal', async () => {
    const disposers: Array<() => void> = []
    const routes: Array<{ path: string }> = []
    const opened: unknown[] = []
    let closed = false
    const store = {
      table: () => ({
        get: () => undefined,
        entries: () => [][Symbol.iterator](),
        keys: () => [][Symbol.iterator](),
        get size() { return 0 },
        put: async () => {},
        update: async () => undefined,
        delete: async () => false,
      }),
      async close() { closed = true },
    }
    const ctx = {
      logger: { error: () => {} },
      get: (key: string) => {
        if (key === 'connection') return { fetch: { register: (route: { path: string }) => { routes.push(route); return async () => {} } } }
        if (key === 'storageDomain') return { open: async (spec: unknown) => { opened.push(spec); return store } }
        return undefined
      },
      effect: (callback: () => unknown) => {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose as () => void)
        return () => {}
      },
    }
    ;(plugin.apply as (context: unknown, config?: unknown) => void)(ctx, { enableAgentTool: false })
    expect(opened).toHaveLength(1)
    expect((opened[0] as { name: string }).name).toBe('skillre_sticky_wall')
    expect(routes.map((route) => route.path)).toEqual(['/api/skillre-sticky-wall/execute'])
    // Let the open promise settle, then dispose the Fiber and verify the domain closed.
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const dispose of disposers.reverse()) dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).toBe(true)
  })
})
