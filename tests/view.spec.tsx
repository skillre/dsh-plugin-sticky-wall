// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientApi } from '../src/client/api.js'
import { ActionError } from '../src/client/api.js'
import type { ClientLocaleLike } from '../src/client/contracts.js'
import { en, textOf } from '../src/client/text.js'
import type { Translate } from '../src/client/text.js'
import { ConfirmDialog, WallPage } from '../src/client/view.jsx'
import { WIDTH_PX, type Note } from '../src/types.js'
import { WALL_CSS } from '../src/client/styles.js'

/**
 * Client component behavior tests.
 *
 * These cover the failure modes a bundle-level test cannot see: double submit,
 * the archived filter's data scope, reload-after-failure, and the destructive
 * dialog's keyboard contract.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Translate through the shipped English dictionary so copy is stable. */
const t: Translate = (key, params) => {
  const template = textOf(en, key)
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

/** Dictionary value as a plain string for assertions. */
const copy = (key: string): string => textOf(en, key)

/** A locale service double that never switches locale. */
const locale: ClientLocaleLike = {
  getSnapshot: () => ({ active: 'en', locales: [{ id: 'en' }], revision: 0 }),
  subscribe: () => () => {},
  register: () => () => {},
  bind: () => t,
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    title: '',
    body: 'hello',
    tags: [],
    color: 'yellow',
    pinned: false,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    layout: null,
    ...overrides,
  }
}

/** One recorded call: the method name, the payload it carried and its options. */
interface RecordedCall {
  method: string
  args: unknown
  options: unknown
}

/** A ClientApi double recording every call, with overridable behavior. */
function makeApi(overrides: Partial<ClientApi> = {}): ClientApi & { calls: string[]; arguments: RecordedCall[] } {
  const calls: string[] = []
  const recorded: RecordedCall[] = []
  const api: ClientApi = {
    async list(includeArchived, sort) {
      calls.push(`list:${String(includeArchived)}:${sort}`)
      return overrides.list ? await overrides.list(includeArchived, sort) : [makeNote()]
    },
    async create(input, signal, options) {
      calls.push('create')
      recorded.push({ method: 'create', args: input, options })
      if (overrides.create) return overrides.create(input, signal, options)
      return makeNote({ id: 'created', body: input.body })
    },
    async update(id, patch) {
      calls.push('update')
      if (overrides.update) return overrides.update(id, patch)
      return makeNote({ id, ...(patch as Partial<Note>) })
    },
    async archive(ids, archived) {
      calls.push('archive')
      if (overrides.archive) return overrides.archive(ids, archived)
      return ids.map((id) => makeNote({ id, archived }))
    },
    async remove(ids) {
      calls.push('remove')
      if (overrides.remove) return overrides.remove(ids)
      return ids
    },
    async clearArchived() {
      calls.push('clearArchived')
      if (overrides.clearArchived) return overrides.clearArchived()
      return []
    },
    async move(id, layout) {
      calls.push('move')
      recorded.push({ method: 'move', args: { id, layout }, options: undefined })
      ;(api as unknown as { lastMove: { id: string; layout: unknown } }).lastMove = { id, layout }
      if (overrides.move) return overrides.move(id, layout)
      return makeNote({ id, layout })
    },
    async arrange(signal, options) {
      calls.push('arrange')
      recorded.push({ method: 'arrange', args: undefined, options })
      if (overrides.arrange) return overrides.arrange(signal)
      return []
    },
  }
  return Object.assign(api, { calls, arguments: recorded })
}

/** Open the composer and fill its body, then press the save shortcut. */
async function composeAndSave(body: string): Promise<void> {
  // The dock's create button is the circular "+"; its accessible name is "New".
  fireEvent.click(screen.getByRole('button', { name: copy('new') }))
  await waitFor(() => expect(document.querySelector('.skw-textarea')).not.toBeNull())
  fireEvent.change(document.querySelector('.skw-textarea')!, { target: { value: body } })
}

describe('wall page', () => {
  it('loads the archived set when the archived filter is selected', async () => {
    const api = makeApi({ list: async () => [makeNote({ id: 'a', archived: true })] })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(api.calls).toContain('list:false:pinned'))
    fireEvent.click(screen.getByRole('button', { name: /Archive/ }))
    await waitFor(() => expect(api.calls).toContain('list:true:pinned'))
    // The archived note is visible, so the "empty archive" copy is not shown.
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBeGreaterThan(0))
    expect(screen.queryByText(copy('emptyArchived'))).toBeNull()
  })

  it('offers clear-archived from the dock menu whenever an archived note exists', async () => {
    // The sweep is a mode, not a frequent click, so it moved into the dock's
    // overflow menu rather than occupying a permanent slot in the strip.
    const api = makeApi({ list: async () => [makeNote({ id: 'a', archived: true })] })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelector('.skw-dock')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: copy('more') }))
    await waitFor(() => expect(screen.getByRole('menuitem', { name: copy('clearArchived') })).toBeTruthy())
  })

  it('reloads after a failed mutation so a partial write cannot stay hidden', async () => {
    const api = makeApi({ update: async () => { throw new ActionError('sticky-wall/internal', 'nope') } })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    const before = api.calls.filter((call) => call.startsWith('list:')).length
    // The filter segment also carries the "Pin" label; the card action is the
    // one inside a note card.
    const card = document.querySelector('.skw-note')!
    fireEvent.click(card.querySelector('button[aria-label="' + copy('pin') + '"]')!)
    await waitFor(() => expect(api.calls.filter((call) => call.startsWith('list:')).length).toBeGreaterThan(before))
    await waitFor(() => expect(document.querySelector('.skw-error')).not.toBeNull())
  })

  it('submits a note once even when the save shortcut fires twice', async () => {
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await composeAndSave('double submit check')
    const sheet = document.querySelector('.skw-sheet')!
    fireEvent.keyDown(sheet, { key: 'Enter', metaKey: true })
    fireEvent.keyDown(sheet, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(api.calls.filter((call) => call === 'create')).toHaveLength(1))
  })

  it('ignores an auto-repeated save shortcut', async () => {
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await composeAndSave('repeat check')
    fireEvent.keyDown(document.querySelector('.skw-sheet')!, { key: 'Enter', metaKey: true, repeat: true })
    expect(api.calls.filter((call) => call === 'create')).toHaveLength(0)
  })

  it('renders a distinct message when a search matches nothing', async () => {
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz-no-match' } })
    // On the canvas the centrepiece stays put and explains WHY it is empty
    // ("No matching notes" rather than a bare zero), and the capture field stays
    // available instead of the whole surface being replaced by an empty state.
    await waitFor(() => expect(document.querySelector('.skw-centre-tally')?.textContent).toBe(copy('noResults')))
    expect(document.querySelector('.skw-centre-tally')?.getAttribute('data-empty')).toBe('true')
    expect(document.querySelector('.skw-capture')).not.toBeNull()
    expect(document.querySelectorAll('.skw-note').length).toBe(0)
  })
})

describe('note card layout', () => {
  it('puts the actions on their own row so the title keeps the full width', async () => {
    // Regression 1: an absolute overlay covered a long title.
    // Regression 2: sharing one line made a long title wrap early, because the
    // buttons consumed the right half of the row.
    const api = makeApi({
      list: async () => [makeNote({ title: '一个很长很长很长很长很长很长的便签标题', body: '正文' })],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    const card = document.querySelector('.skw-note')!
    const bar = card.querySelector('.skw-note-bar')!
    const tools = card.querySelector('.skw-note-tools')!
    const head = card.querySelector('.skw-note-head')!
    const title = head.querySelector('.skw-note-title')!
    // The actions sit in the top bar, never in the title row.
    expect(bar.contains(tools)).toBe(true)
    expect(head.contains(tools)).toBe(false)
    expect(head.contains(title)).toBe(true)
    // Not absolutely positioned, so it cannot sit on top of the text.
    expect(getComputedStyle(tools).position).not.toBe('absolute')
    // The bar reserves height even while the buttons are hidden on hover.
    expect(getComputedStyle(bar).minHeight).not.toBe('')
  })

  it('keeps the title row, body and footer out of the action bar', async () => {
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    const card = document.querySelector('.skw-note')!
    const bar = card.querySelector('.skw-note-bar')!
    expect(bar.contains(card.querySelector('.skw-note-head'))).toBe(false)
    expect(bar.contains(card.querySelector('.skw-note-body'))).toBe(false)
    expect(bar.contains(card.querySelector('.skw-note-foot'))).toBe(false)
  })
})

describe('view modes and the free canvas', () => {
  it('renders each card at the placement the Host stored', async () => {
    const api = makeApi({
      list: async () => [
        makeNote({ id: 'a', body: 'placed', layout: { x: 140, y: 90, rotate: -3, width: 'lg' } }),
        makeNote({ id: 'b', body: 'derived' }),
      ],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(2))
    // The card itself carries the id now: the old full-size slot wrapper was an
    // extra element per note that existed only to hold an attribute.
    const placed = document.querySelector('[data-note-id="a"]') as HTMLElement
    expect(placed.classList.contains('skw-note')).toBe(true)
    expect(placed.style.left).toBe('140px')
    expect(placed.style.top).toBe('90px')
    // The stored preset drives the rendered width, not a responsive guess.
    expect(placed.style.width).toBe(`${WIDTH_PX.lg}px`)
    expect(placed.style.transform).toContain('rotate(-3deg)')
    // A never-placed note still lands somewhere distinct instead of at (0,0).
    const derived = document.querySelector('[data-note-id="b"]') as HTMLElement
    expect(derived.style.left).not.toBe('0px')
  })

  it('switches to the grid and list views without losing the note set', async () => {
    const api = makeApi({ list: async () => [makeNote({ id: 'a', title: 'A note', body: 'body' })] })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelector('.skw-canvas')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: copy('view_grid') }))
    await waitFor(() => expect(document.querySelector('.skw-grid')).not.toBeNull())
    expect(document.querySelectorAll('.skw-note').length).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: copy('view_list') }))
    await waitFor(() => expect(document.querySelector('.skw-list')).not.toBeNull())
    expect(document.querySelectorAll('.skw-row').length).toBe(1)
    // The canvas and its camera belong to the canvas view only.
    expect(document.querySelector('.skw-canvas')).toBeNull()
    expect(document.querySelector('.skw-cameras')).toBeNull()
  })

  it('tidies the wall through the Host and does not arrange from the grid view', async () => {
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: copy('arrange') }))
    await waitFor(() => expect(api.calls).toContain('arrange'))
    fireEvent.click(screen.getByRole('button', { name: copy('view_grid') }))
    await waitFor(() => expect(document.querySelector('.skw-grid')).not.toBeNull())
    // In grid view the cards are laid out by CSS, so tidying is meaningless.
    expect(screen.queryByRole('button', { name: copy('arrange') })).toBeNull()
  })

  it('cycles a card width through the Host so the preset is persisted', async () => {
    const api = makeApi({
      list: async () => [makeNote({ id: 'a', body: 'x', layout: { x: 10, y: 10, rotate: 0, width: 'sm' } })],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    fireEvent.click(document.querySelector('button[aria-label="' + copy('resize') + '"]')!)
    await waitFor(() => expect(api.calls).toContain('move'))
    // sm -> md, keeping the existing position.
    const moved = (api as unknown as { lastMove?: { layout: { width: string; x: number } } }).lastMove
    expect(moved?.layout.width).toBe('md')
    expect(moved?.layout.x).toBe(10)
  })

  it('renders Markdown in the card body instead of literal asterisks', async () => {
    const api = makeApi({ list: async () => [makeNote({ body: '**bold** and `code`' })] })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    const body = document.querySelector('.skw-note-body')!
    expect(body.querySelector('strong')?.textContent).toBe('bold')
    expect(body.querySelector('code')?.textContent).toBe('code')
    expect(body.textContent).not.toContain('**')
  })

  it('keeps a legacy note in place when the search box filters the list', async () => {
    // Blocker regression: the derived preview position was keyed off the
    // FILTERED list, so typing in the search box shifted every legacy note.
    // The index must come from the unfiltered snapshot.
    const api = makeApi({
      list: async () => [
        makeNote({ id: 'a', title: 'alpha', body: 'first' }),
        makeNote({ id: 'b', title: 'beta', body: 'second' }),
      ],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(2))
    const beforeLeft = (document.querySelector('[data-note-id="b"]') as HTMLElement).style.left
    // Filter down to just "b": if the index came from the filtered list it
    // would now be index 0 and jump.
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'beta' } })
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    const afterLeft = (document.querySelector('[data-note-id="b"]') as HTMLElement).style.left
    expect(afterLeft).toBe(beforeLeft)
  })

  it('preserves a card rotation when it is dragged', async () => {
    // Blocker regression: every drag wrote rotate: 0, silently straightening the
    // tilt that tidy had just applied.
    const api = makeApi({
      list: async () => [makeNote({ id: 'a', body: 'tilted', layout: { x: 40, y: 40, rotate: -3, width: 'md' } })],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    const card = document.querySelector('[data-note-id="a"]') as HTMLElement
    expect(card.style.transform).toContain('rotate(-3deg)')
    // Drive a real drag through the pointer handlers the component installs.
    // jsdom has no PointerEvent constructor, so build a plain Event and attach
    // the pointer fields the handlers read.
    const pointer = (type: string, x: number, y: number): Event => {
      const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>
      event.pointerId = 1
      event.clientX = x
      event.clientY = y
      event.button = 0
      return event
    }
    // Dispatch through the DOM directly: `fireEvent.pointerDown` drops
    // `pointerId` in jsdom, and the handler correlates the move against it.
    act(() => {
      card.dispatchEvent(pointer('pointerdown', 100, 100))
    })
    act(() => {
      window.dispatchEvent(pointer('pointermove', 160, 150))
      window.dispatchEvent(pointer('pointerup', 160, 150))
    })
    await waitFor(() => expect(api.calls).toContain('move'))
    const moved = (api as unknown as { lastMove?: { layout: { rotate: number; x: number } } }).lastMove
    expect(moved?.layout.rotate).toBe(-3)
    expect(moved?.layout.x).not.toBe(40)
  })

  it('does not transition the canvas card transform, so a drag tracks the pointer', async () => {
    // Regression: `transition: transform .16s ease` on the canvas card made every
    // per-frame transform write an animation target, so the card lagged the
    // pointer by ~160ms — the "sticky" drag feel. Only the shadow may animate.
    const api = makeApi({
      list: async () => [makeNote({ id: 'a', body: 'x', layout: { x: 10, y: 10, rotate: 0, width: 'md' } })],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelector('.skw-canvas .skw-note')).not.toBeNull())
    // jsdom does not apply an injected <style> sheet to getComputedStyle, so the
    // assertion reads the stylesheet source, which is the actual contract.
    const rule = WALL_CSS.slice(
      WALL_CSS.indexOf('.skw-canvas .skw-note {'),
      WALL_CSS.indexOf('.skw-canvas .skw-note[data-width'),
    )
    // The transition must not name `transform` (will-change is fine and
    // desirable: it promotes the card to its own layer once).
    const transition = rule.match(/transition:\s*([^;]+);/)?.[1] ?? ''
    expect(transition).toContain('box-shadow')
    expect(transition).not.toContain('transform')
  })

  it('restores the card tilt on drop instead of clearing its transform', async () => {
    // Regression: the drop cleared the inline transform, which React had also
    // written `rotate(...)` into, so every dropped card lost its tilt until the
    // next render — a visible snap. The UI harness caught this; this test keeps
    // it caught without a browser.
    const api = makeApi({
      list: async () => [makeNote({ id: 'a', body: 'x', layout: { x: 420, y: 300, rotate: -3, width: 'md' } })],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    const card = document.querySelector('.skw-canvas .skw-note') as HTMLElement
    const pointer = (type: string, x: number, y: number): Event => {
      const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>
      event.pointerId = 1
      event.clientX = x
      event.clientY = y
      event.button = 0
      event.isPrimary = true
      return event
    }
    act(() => { card.dispatchEvent(pointer('pointerdown', 100, 100)) })
    act(() => {
      window.dispatchEvent(pointer('pointermove', 140, 130))
      window.dispatchEvent(pointer('pointerup', 140, 130))
    })
    await waitFor(() => expect(api.calls).toContain('move'))
    // The drop hands the drag offset over to left/top and keeps the tilt: the
    // card must never straighten, and it must never snap back to the corner it
    // started from while the Host round-trip is in flight.
    expect(card.style.transform).toContain('rotate(-3deg)')
    expect(card.style.transform).not.toContain('translate3d')
    const moved = (api as unknown as { lastMove?: { layout: { x: number; y: number } } }).lastMove
    // 40px/30px of travel at zoom 1, on top of the stored 420/300. The card is
    // clear of the centrepiece reserve, so the drop is exactly the pointer delta.
    expect(moved?.layout.x).toBe(460)
    expect(moved?.layout.y).toBe(330)
  })

  it('writes the dropped position optimistically, before the Host answers', async () => {
    // Regression: the card used to snap back to its old corner on drop and only
    // jump forward once the reload landed, which read as the drag "not sticking".
    // The drop now writes left/top on the node AND the note list immediately.
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const api = makeApi({
      list: async () => [makeNote({ id: 'a', body: 'x', layout: { x: 420, y: 300, rotate: 0, width: 'md' } })],
      move: async (id, layout) => {
        await gate
        return makeNote({ id, layout })
      },
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    const card = document.querySelector('.skw-canvas .skw-note') as HTMLElement
    const pointer = (type: string, x: number, y: number): Event => {
      const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>
      event.pointerId = 1
      event.clientX = x
      event.clientY = y
      event.button = 0
      event.isPrimary = true
      return event
    }
    act(() => { card.dispatchEvent(pointer('pointerdown', 100, 100)) })
    act(() => {
      window.dispatchEvent(pointer('pointermove', 150, 140))
      window.dispatchEvent(pointer('pointerup', 150, 140))
    })
    // The Host has not answered yet (the move is gated), so this is purely the
    // optimistic write: without it the card would sit at 420px.
    await waitFor(() => expect(card.style.left).toBe('470px'))
    expect(card.style.top).toBe('340px')
    release?.()
  })

  it('marks the dragged card on the node instead of re-rendering the wall', async () => {
    // Regression: the drag flag was React state, so every press and release
    // re-rendered the whole wall. It is now a data attribute on the node.
    const api = makeApi({
      list: async () => [makeNote({ id: 'a', body: 'x', layout: { x: 10, y: 10, rotate: 0, width: 'md' } })],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    const card = document.querySelector('.skw-canvas .skw-note') as HTMLElement
    const pointer = (type: string, x: number, y: number): Event => {
      const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>
      event.pointerId = 1
      event.clientX = x
      event.clientY = y
      event.button = 0
      event.isPrimary = true
      return event
    }
    act(() => { card.dispatchEvent(pointer('pointerdown', 100, 100)) })
    // The attribute appears synchronously on press, before any React render.
    expect(card.getAttribute('data-dragging')).toBe('true')
    act(() => { window.dispatchEvent(pointer('pointerup', 100, 100)) })
    await waitFor(() => expect(card.getAttribute('data-dragging')).toBeNull())
  })

  it('opens the canvas looking at the middle of the wall, not a corner', async () => {
    // The complaint this fixes: the wall opened on its top-left corner, so the
    // first thing a user saw was empty paper with the notes off to one side.
    // The camera now centres on the visible wall's centroid.
    const api = makeApi({
      list: async () => [
        makeNote({ id: 'a', body: 'x', layout: { x: 400, y: 300, rotate: 0, width: 'md' } }),
        makeNote({ id: 'b', body: 'y', layout: { x: 800, y: 500, rotate: 0, width: 'md' } }),
      ],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-canvas .skw-note').length).toBe(2))
    const world = document.querySelector('.skw-world') as HTMLElement
    // jsdom reports a zero-sized viewport, so the centre offset is exactly the
    // negated centroid: (400+222/2 + 800+222/2)/2 = 711, (300+h + 500+h)/2.
    const match = world.style.transform.match(/translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\(([\d.]+)\)/)
    expect(match).not.toBeNull()
    const panX = Number.parseFloat(match![1]!)
    const panY = Number.parseFloat(match![2]!)
    expect(panX).toBeLessThan(-500)
    expect(panX).toBeGreaterThan(-900)
    expect(panY).toBeLessThan(-300)
    expect(panY).toBeGreaterThan(-700)
    expect(Number.parseFloat(match![3]!)).toBe(1)
  })

  it('keeps the zoom anchored so the wall does not jump', async () => {
    // Zoom used to scale from the world origin, which threw the visible content
    // off screen at every step. The anchor point now stays fixed.
    const api = makeApi({
      list: async () => [makeNote({ id: 'a', body: 'x', layout: { x: 400, y: 300, rotate: 0, width: 'md' } })],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-canvas .skw-note').length).toBe(1))
    const world = document.querySelector('.skw-world') as HTMLElement
    const read = (): { panX: number; panY: number; zoom: number } => {
      const match = world.style.transform.match(/translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\(([\d.]+)\)/)!
      return { panX: Number.parseFloat(match[1]!), panY: Number.parseFloat(match[2]!), zoom: Number.parseFloat(match[3]!) }
    }
    const before = read()
    // The world point under the (zero-sized) viewport's top-left corner.
    const worldX = (0 - before.panX) / before.zoom
    const worldY = (0 - before.panY) / before.zoom
    fireEvent.click(screen.getByRole('button', { name: copy('zoomIn') }))
    await waitFor(() => expect(document.querySelector('.skw-camera-value')?.textContent).toBe('115%'))
    const after = read()
    expect(after.zoom).toBeCloseTo(1.15, 5)
    // Same world point under the same anchor: pan == -world * newZoom.
    expect(after.panX).toBeCloseTo(-worldX * after.zoom, 3)
    expect(after.panY).toBeCloseTo(-worldY * after.zoom, 3)
  })

  it('pans by dragging empty paper and recentres on reset', async () => {
    const api = makeApi({
      list: async () => [makeNote({ id: 'a', body: 'x', layout: { x: 300, y: 200, rotate: 0, width: 'md' } })],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-canvas .skw-note').length).toBe(1))
    const canvas = document.querySelector('.skw-canvas') as HTMLElement
    const world = document.querySelector('.skw-world') as HTMLElement
    const panX = (): number => Number.parseFloat(world.style.transform.match(/translate3d\((-?[\d.]+)px/)![1]!)
    const before = panX()
    const pointer = (type: string, x: number, y: number): Event => {
      const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>
      event.pointerId = 7
      event.clientX = x
      event.clientY = y
      event.button = 0
      event.isPrimary = true
      return event
    }
    act(() => { canvas.dispatchEvent(pointer('pointerdown', 500, 400)) })
    act(() => {
      window.dispatchEvent(pointer('pointermove', 560, 430))
      window.dispatchEvent(pointer('pointerup', 560, 430))
    })
    // rAF drives the paint; wait for the world transform to move.
    await waitFor(() => expect(panX()).toBe(before + 60))
    // A pan is not a note mutation: dragging paper must not write to the Host.
    expect(api.calls).not.toContain('move')
    fireEvent.click(screen.getByRole('button', { name: copy('zoomReset') }))
    await waitFor(() => expect(document.querySelector('.skw-camera-value')?.textContent).toBe('100%'))
    expect(panX()).toBe(before)
  })

  it('does not start a pan when the press lands on a card', async () => {
    const api = makeApi({
      list: async () => [makeNote({ id: 'a', body: 'x', layout: { x: 300, y: 200, rotate: 0, width: 'md' } })],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-canvas .skw-note').length).toBe(1))
    const canvas = document.querySelector('.skw-canvas') as HTMLElement
    const card = document.querySelector('.skw-canvas .skw-note') as HTMLElement
    const pointer = (type: string, x: number, y: number): Event => {
      const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>
      event.pointerId = 9
      event.clientX = x
      event.clientY = y
      event.button = 0
      event.isPrimary = true
      return event
    }
    // A press on the card bubbles up to the canvas; the canvas must ignore it.
    act(() => { card.dispatchEvent(pointer('pointerdown', 320, 220)) })
    expect(canvas.getAttribute('data-panning')).toBeNull()
    expect(card.getAttribute('data-dragging')).toBe('true')
    act(() => { window.dispatchEvent(pointer('pointerup', 320, 220)) })
  })

  it('puts the greeting, the tally and the capture field at the centre of the wall', async () => {
    // The complaint this fixes: the wall had no middle. The centre is now the
    // wall's centrepiece — a screen-space overlay that stays put under pan/zoom.
    const api = makeApi({
      list: async () => [
        makeNote({ id: 'a', body: 'one', layout: { x: 600, y: 400, rotate: 0, width: 'md' } }),
        makeNote({ id: 'b', body: 'two', archived: true, layout: { x: 900, y: 400, rotate: 0, width: 'md' } }),
      ],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelector('.skw-centre')).not.toBeNull())
    const centre = document.querySelector('.skw-centre') as HTMLElement
    // It is a child of the canvas, but NOT of the transformed world: if it were
    // inside `.skw-world` a pan would drag the greeting off screen with the wall.
    expect(centre.parentElement?.classList.contains('skw-canvas')).toBe(true)
    expect(document.querySelector('.skw-world')?.contains(centre)).toBe(false)
    // The wrapper must not swallow pointer events; the field itself must.
    expect(getComputedStyle(centre).pointerEvents).toBe('none')
    expect(getComputedStyle(document.querySelector('.skw-capture') as HTMLElement).pointerEvents).toBe('auto')
    // The tally counts what the wall shows, and mentions the archive separately.
    expect(document.querySelector('.skw-centre-tally')?.textContent).toBe(t('centreTally', { count: 1, archived: 1 }))
  })

  it('creates a note from the centre capture field and clears it', async () => {
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelector('.skw-capture-input')).not.toBeNull())
    const field = document.querySelector('.skw-capture-input') as HTMLInputElement
    const form = document.querySelector('.skw-capture') as HTMLFormElement
    const go = document.querySelector('.skw-capture-go') as HTMLButtonElement
    // Empty input cannot submit: the button is disabled and the form is inert.
    expect(go.disabled).toBe(true)
    fireEvent.change(field, { target: { value: '记下一个灵感' } })
    expect(go.disabled).toBe(false)
    act(() => { fireEvent.submit(form) })
    await waitFor(() => expect(api.calls).toContain('create'))
    // The field clears so the next capture starts fresh, without opening the sheet.
    await waitFor(() => expect((document.querySelector('.skw-capture-input') as HTMLInputElement).value).toBe(''))
    expect(document.querySelector('.skw-sheet')).toBeNull()
  })

  it('keeps the whole wall on one dock instead of a toolbar row', async () => {
    // The wall now uses the entire window: no header row and no toolbar row above
    // the canvas, and the dock is a floating overlay rather than a layout row.
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelector('.skw-dock')).not.toBeNull())
    expect(document.querySelector('.skw-head')).toBeNull()
    expect(document.querySelector('.skw-toolbar')).toBeNull()
    const dock = document.querySelector('.skw-dock') as HTMLElement
    expect(getComputedStyle(dock).position).toBe('absolute')
    // Every control the toolbar used to hold is still reachable in the dock.
    expect(document.querySelector('.skw-dock .skw-search')).not.toBeNull()
    expect(document.querySelectorAll('.skw-dock .skw-seg').length).toBe(2)
    expect(document.querySelector('.skw-dock-new')).not.toBeNull()
    expect(document.querySelector('.skw-dock-zoom')).not.toBeNull()
    expect(document.querySelector('.skw-dock .skw-count')?.textContent).toBe(t('count', { count: 1 }))
  })

  it('keeps the camera controls usable and bounded', async () => {
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelector('.skw-dock-zoom')).not.toBeNull())
    const zoomIn = screen.getByRole('button', { name: copy('zoomIn') })
    for (let step = 0; step < 12; step += 1) fireEvent.click(zoomIn)
    await waitFor(() => expect(document.querySelector('.skw-camera-value')?.textContent).toBe('200%'))
    fireEvent.click(screen.getByRole('button', { name: copy('zoomReset') }))
    await waitFor(() => expect(document.querySelector('.skw-camera-value')?.textContent).toBe('100%'))
  })
})

describe('the dock menu and the arrival reveal', () => {
  it('keeps the mode controls in one overflow menu instead of the dock row', async () => {
    // The complaint: too many buttons, and on a narrow window they overflowed the
    // background they were drawn on. The dock now carries only the frequent
    // controls; sort and the archive sweep live in a menu that opens upward.
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelector('.skw-dock')).not.toBeNull())
    expect(document.querySelector('.skw-menu')).toBeNull()
    const more = screen.getByRole('button', { name: copy('more') })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    await waitFor(() => expect(document.querySelector('.skw-menu')).not.toBeNull())
    expect(more.getAttribute('aria-expanded')).toBe('true')
    // The sort choices are menuitemradio, so their selected state is announced.
    const sortItems = document.querySelectorAll('.skw-menu [role="menuitemradio"]')
    expect(sortItems.length).toBe(3)
    expect(sortItems[0]?.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sortItems[1] as HTMLElement)
    // The sort is a Host query, so choosing one refetches with the new order.
    await waitFor(() => expect(api.calls).toContain('list:false:created'))
    // Choosing an option closes the menu: the user asked for one thing.
    expect(document.querySelector('.skw-menu')).toBeNull()
  })

  it('closes the dock menu on Escape and on a press outside it', async () => {
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelector('.skw-dock')).not.toBeNull())
    const more = screen.getByRole('button', { name: copy('more') })
    fireEvent.click(more)
    await waitFor(() => expect(document.querySelector('.skw-menu')).not.toBeNull())
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    await waitFor(() => expect(document.querySelector('.skw-menu')).toBeNull())
    fireEvent.click(more)
    await waitFor(() => expect(document.querySelector('.skw-menu')).not.toBeNull())
    act(() => { fireEvent.pointerDown(document.querySelector('.skw-canvas') as HTMLElement) })
    await waitFor(() => expect(document.querySelector('.skw-menu')).toBeNull())
  })

  it('creates a note at the free spot the Host returns and marks it as arrived', async () => {
    // Creating from the centre field used to leave the placement to an
    // index-derived spiral, which could put the new card a screen away — the wall
    // then looked like the capture had silently failed. The Host now places the
    // card in the nearest free gap and the Client flags it for the arrival pop.
    //
    // The double's list must include the created note: the arrival effect looks
    // the card up in the committed snapshot, which is what a real reload returns.
    let created: Note | null = null
    const api = makeApi({
      list: async () => (created === null ? [] : [created]),
      create: async (input) => {
        created = makeNote({ id: 'created', body: input.body, layout: { x: 420, y: 300, rotate: 0, width: 'md' } })
        return created
      },
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelector('.skw-capture-input')).not.toBeNull())
    const field = document.querySelector('.skw-capture-input') as HTMLInputElement
    fireEvent.change(field, { target: { value: '记下一个灵感' } })
    act(() => { fireEvent.submit(document.querySelector('.skw-capture') as HTMLFormElement) })
    await waitFor(() => expect(api.calls).toContain('create'))
    // The create call carries the zoom-corrected reserve, so the Host places the
    // card in a gap that is genuinely free on the current view.
    const createCall = api.arguments.find((entry) => entry.method === 'create')
    expect(createCall?.options).toBeDefined()
    expect((createCall?.options as { centreReserve?: { halfWidth: number } }).centreReserve?.halfWidth).toBeGreaterThan(0)
    // The new card is rendered with the arrival flag so it can be found.
    await waitFor(() => expect(document.querySelector('.skw-note[data-arrived="true"]')).not.toBeNull())
  })

  it('drags a card out of the centrepiece instead of letting it cover the field', async () => {
    // The reserve is a magnetic edge during a drag too: a card parked over the
    // capture field hides the wall's own controls behind itself.
    const api = makeApi({
      list: async () => [makeNote({ id: 'a', body: 'x', layout: { x: 300, y: 200, rotate: 0, width: 'md' } })],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-canvas .skw-note').length).toBe(1))
    const card = document.querySelector('.skw-canvas .skw-note') as HTMLElement
    const pointer = (type: string, x: number, y: number): Event => {
      const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>
      event.pointerId = 11
      event.clientX = x
      event.clientY = y
      event.button = 0
      event.isPrimary = true
      return event
    }
    act(() => { card.dispatchEvent(pointer('pointerdown', 400, 300)) })
    // Drag the card so its top-left lands on the world origin: squarely over the
    // centrepiece, which must be refused.
    act(() => {
      window.dispatchEvent(pointer('pointermove', 400 - 300, 300 - 200))
      window.dispatchEvent(pointer('pointerup', 400 - 300, 300 - 200))
    })
    await waitFor(() => expect(api.calls).toContain('move'))
    const moveCall = api.arguments.find((entry) => entry.method === 'move')
    const layout = (moveCall?.args as { layout?: { x: number; y: number } } | undefined)?.layout
    expect(layout).toBeDefined()
    // Not at the origin: the drop was pushed clear of the reserved rectangle.
    expect(Math.abs(layout!.x) > 0 || Math.abs(layout!.y) > 0).toBe(true)
  })
})

describe('confirm dialog', () => {
  it('is a labelled modal that Escape dismisses', () => {
    const onCancel = vi.fn()
    render(
      <ConfirmDialog title={copy('delete')} message={copy('confirmDelete')} confirmLabel={copy('delete')} cancelLabel={copy('cancel')} busy={false}
        onConfirm={() => {}} onCancel={onCancel} />,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe(copy('delete'))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('focuses Cancel on open and restores the previous focus on close', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const { unmount } = render(
      <ConfirmDialog title={copy('delete')} message={copy('confirmDelete')} confirmLabel={copy('delete')} cancelLabel={copy('cancel')} busy={false}
        onConfirm={() => {}} onCancel={() => {}} />,
    )
    await waitFor(() => expect(document.activeElement?.textContent).toBe(copy('cancel')))
    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('does not confirm twice on a repeated click', () => {
    let confirmed = 0
    render(
      <ConfirmDialog title={copy('delete')} message={copy('confirmDelete')} confirmLabel={copy('delete')} cancelLabel={copy('cancel')} busy={true}
        onConfirm={() => { confirmed += 1 }} onCancel={() => {}} />,
    )
    const button = screen.getByRole('button', { name: copy('delete') })
    act(() => { fireEvent.click(button) })
    expect(confirmed).toBe(0)
  })
})
