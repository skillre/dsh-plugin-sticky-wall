import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../src/index.js'
import { Config, resolveConfig } from '../src/config.js'

describe('@skillre/dsh-plugin-sticky-wall', () => {
  it('exports the Cordis function-plugin contract', () => {
    expect(plugin.name).toBe('skillre-sticky-wall')
    expect(plugin.apply).toBeTypeOf('function')
    expect('default' in plugin).toBe(false)
  })

  it('declares only the connection service as a hard dependency', () => {
    // `storageDomain` became OPTIONAL in 0.8.0: notes live on disk, and the domain
    // is opened only when a 0.7.x install needs migrating. Declaring it required
    // would refuse to mount on a profile that never had it.
    expect(plugin.inject).toEqual(['connection'])
  })

  it('resolves declared config defaults and rejects an out-of-range cap', () => {
    expect(resolveConfig({})).toEqual({ notesDir: '', maxNotes: 400, enableAgentTool: true, seedWelcomeNote: true })
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
    expect(properties.action?.enum).toEqual(['list', 'read', 'create', 'update', 'move', 'archive', 'delete', 'clear-archived', 'arrange'])
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

  it('registers the route, opens the notes directory and releases it on disposal', async () => {
    const disposers: Array<() => void> = []
    const routes: Array<{ path: string }> = []
    const logs: string[] = []
    const ctx = {
      logger: { error: (message: string) => { logs.push(message) }, warn: (message: string) => { logs.push(message) } },
      get: (key: string) => {
        if (key === 'connection') return { fetch: { register: (route: { path: string }) => { routes.push(route); return async () => {} } } }
        return undefined
      },
      effect: (callback: () => unknown) => {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose as () => void)
        return () => {}
      },
    }
    // An explicit directory: an empty `notesDir` means "follow the DSH home", and
    // a test must never aim at the developer's real notes directory.
    const notesDir = await mkdtemp(join(tmpdir(), 'sw-plugin-'))
    ;(plugin.apply as (context: unknown, config?: unknown) => void)(ctx, { enableAgentTool: false, notesDir })
    // The route is registered synchronously; the directory is opened lazily, so a
    // filesystem failure surfaces on the first request instead of at mount time.
    expect(routes.map((route) => route.path)).toEqual(['/api/skillre-sticky-wall/execute'])
    // Let the open promise settle, then dispose the Fiber. Nothing should throw,
    // and no error should have been logged for an ordinary open.
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const dispose of disposers.reverse()) dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(logs.filter((line) => line.startsWith('sticky-wall: notes directory failed'))).toEqual([])
  })
})
