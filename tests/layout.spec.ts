import { describe, expect, it } from 'vitest'
import {
  arrangeLayouts,
  clampLayout,
  estimateHeight,
  MAX_CARD_HEIGHT,
  rotatedExtent,
  layoutOf,
  previewLayout,
  previewWidth,
  sameLayout,
} from '../src/layout.js'
import { CENTRE_RADIUS, LAYOUT_LIMITS, LIMITS, WIDTH_PX, type Note, type NoteLayout } from '../src/types.js'

/**
 * Free-canvas geometry tests.
 *
 * The arrangement is a Host-side, headless operation, so it must be fully
 * assertable without a browser: deterministic, bounded, and non-overlapping.
 */

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

describe('layout geometry', () => {
  it('clamps coordinates and rotation into the declared world bounds', () => {
    const layout = clampLayout({ x: 99_999, y: -99_999, rotate: 400, width: 'md' })
    expect(layout.x).toBe(LAYOUT_LIMITS.coord)
    expect(layout.y).toBe(-LAYOUT_LIMITS.coord)
    expect(layout.rotate).toBe(LAYOUT_LIMITS.rotate)
  })

  it('treats non-finite coordinates as the origin instead of storing NaN', () => {
    const layout = clampLayout({ x: Number.NaN, y: Number.POSITIVE_INFINITY, rotate: 0, width: 'sm' })
    expect(layout.x).toBe(0)
    expect(layout.y).toBe(LAYOUT_LIMITS.coord)
  })

  it('compares layouts at stored precision, not at float precision', () => {
    const left: NoteLayout = { x: 10, y: 20, rotate: 1.5, width: 'md' }
    expect(sameLayout(left, { ...left, x: 10.04 })).toBe(true)
    expect(sameLayout(left, { ...left, x: 11 })).toBe(false)
    expect(sameLayout(null, null)).toBe(true)
    expect(sameLayout(null, left)).toBe(false)
  })

  it('derives a distinct preview position for every never-placed note', () => {
    const notes = Array.from({ length: 12 }, (_, index) => makeNote({ id: `n${index}` }))
    const seen = new Set<string>()
    for (const [index, note] of notes.entries()) {
      const layout = previewLayout(note, index)
      expect(layout.width).toBe(previewWidth(note.id))
      // Every preview sits inside the world bounds.
      expect(Math.abs(layout.x)).toBeLessThanOrEqual(LAYOUT_LIMITS.coord)
      expect(Math.abs(layout.y)).toBeLessThanOrEqual(LAYOUT_LIMITS.coord)
      expect(seen.has(`${layout.x}:${layout.y}`)).toBe(false)
      seen.add(`${layout.x}:${layout.y}`)
    }
  })

  it('spirals the derived positions around the origin instead of a grid', () => {
    // A legacy wall (every note unplaced) is the first thing a user upgrading
    // from a pre-canvas version sees, so it has to look like a wall with a
    // middle: a spiral is centred, a grid starts in a corner.
    const notes = Array.from({ length: 16 }, (_, index) => makeNote({ id: `n${index}` }))
    const layouts = notes.map((note, index) => previewLayout(note, index))
    const centreX = layouts.reduce((sum, layout) => sum + layout.x + WIDTH_PX[layout.width] / 2, 0) / layouts.length
    const centreY = layouts.reduce((sum, layout) => sum + layout.y + 100, 0) / layouts.length
    expect(Math.abs(centreX)).toBeLessThan(120)
    expect(Math.abs(centreY)).toBeLessThan(120)
    // Radius grows monotonically: index 0 is the middle, the rest surround it.
    const radii = layouts.map((layout) => Math.hypot(layout.x + WIDTH_PX[layout.width] / 2, layout.y + 100))
    for (let index = 1; index < radii.length; index += 1) {
      expect(radii[index]!).toBeGreaterThan(radii[index - 1]!)
    }
  })

  it('uses the stored layout when one exists and falls back to the preview otherwise', () => {
    const stored: NoteLayout = { x: 42, y: 84, rotate: 2, width: 'lg' }
    expect(layoutOf(makeNote({ layout: stored }), 0)).toEqual(stored)
    const derived = layoutOf(makeNote({ id: 'x', layout: null }), 3)
    expect(derived).toEqual(previewLayout(makeNote({ id: 'x' }), 3))
  })

  it('estimates taller cards for longer bodies and wider presets', () => {
    const short = makeNote({ body: 'one line' })
    const long = makeNote({ body: 'a word '.repeat(160) })
    expect(estimateHeight(long, 'sm')).toBeGreaterThan(estimateHeight(short, 'sm'))
    // A wider card fits more characters per line, so the same text is shorter.
    // Measured below the per-preset cap: past it each preset saturates at its
    // own budget, so a huge note is capped rather than unbounded.
    const medium = makeNote({ body: 'a word '.repeat(40) })
    expect(estimateHeight(medium, 'lg')).toBeLessThan(estimateHeight(medium, 'sm'))
    expect(estimateHeight(long, 'lg')).toBe(MAX_CARD_HEIGHT.lg)
    expect(estimateHeight(long, 'sm')).toBe(MAX_CARD_HEIGHT.sm)
  })
})

describe('tidy arrangement', () => {
  it('is deterministic: the same wall always packs to the same coordinates', () => {
    const notes = Array.from({ length: 9 }, (_, index) => makeNote({ id: `n${index}`, body: `body ${index}` }))
    const first = arrangeLayouts(notes)
    const second = arrangeLayouts(notes)
    expect([...first.entries()]).toEqual([...second.entries()])
  })

  it('never overlaps two cards on the same shelf', () => {
    const notes = Array.from({ length: 8 }, (_, index) => makeNote({ id: `n${index}`, body: `body ${index}` }))
    const planned = arrangeLayouts(notes)
    const boxes = notes.map((note) => {
      const layout = planned.get(note.id)!
      // Measure the ROTATED footprint, which is what actually occupies space on
      // screen; using the unrotated width let tilted cards clip each other.
      const extent = rotatedExtent(WIDTH_PX[layout.width], estimateHeight(note, layout.width), layout.rotate)
      return { x: layout.x, y: layout.y, w: extent.width, h: extent.height }
    })
    for (const [index, left] of boxes.entries()) {
      for (const right of boxes.slice(index + 1)) {
        const overlapX = left.x < right.x + right.w && right.x < left.x + left.w
        const overlapY = left.y < right.y + right.h && right.y < left.y + left.h
        expect(overlapX && overlapY).toBe(false)
      }
    }
  })

  it('centres the arrangement on the world origin instead of a top-left corner', () => {
    // The camera opens on the wall's middle, so the packing must have one. An
    // earlier version shifted everything into the positive quadrant, which put
    // the centre of gravity far from the origin and made the opening view show
    // a corner of empty paper.
    const notes = Array.from({ length: 20 }, (_, index) => makeNote({ id: `n${index}`, body: `body ${index}` }))
    const planned = arrangeLayouts(notes)
    let sumX = 0
    let sumY = 0
    for (const [id, layout] of planned) {
      expect(Math.abs(layout.x)).toBeLessThanOrEqual(LAYOUT_LIMITS.coord)
      expect(Math.abs(layout.y)).toBeLessThanOrEqual(LAYOUT_LIMITS.coord)
      const note = notes.find((candidate) => candidate.id === id)!
      sumX += layout.x + WIDTH_PX[layout.width] / 2
      sumY += layout.y + estimateHeight(note, layout.width) / 2
    }
    const centroidX = sumX / planned.size
    const centroidY = sumY / planned.size
    // The centroid sits on the origin: the spiral is inherently balanced, so
    // this is a tight bound rather than "somewhere near the middle".
    expect(Math.abs(centroidX)).toBeLessThan(60)
    expect(Math.abs(centroidY)).toBeLessThan(60)
  })

  it('grows a large wall into a disc, not a column or a strip', () => {
    // A shelf packer grew one dimension: a 300-card wall became a kilometre-tall
    // column. A phyllotaxis disc stays roughly square at every size, which is
    // what lets the camera frame it by zooming instead of by scrolling.
    //
    // Measured at 60+ cards: a small wall is an ARC around the reserved middle,
    // so its bounding box is legitimately narrow. From 60 up the ring closes and
    // the shape is what the framing depends on.
    for (const count of [60, 150, 300]) {
      const notes = Array.from({ length: count }, (_, index) => makeNote({ id: `n${index}`, body: `body ${index}` }))
      const planned = arrangeLayouts(notes)
      const xs = [...planned.values()].map((layout) => layout.x)
      const ys = [...planned.values()].map((layout) => layout.y)
      const width = Math.max(...xs) - Math.min(...xs)
      const height = Math.max(...ys) - Math.min(...ys)
      const ratio = width / height
      expect(ratio).toBeGreaterThan(0.7)
      expect(ratio).toBeLessThan(1.4)
    }
  })

  it('leaves the middle of the wall clear for the centrepiece', () => {
    // The centre holds the greeting, the tally and the quick-capture field. A
    // card packed there would sit on top of the wall's own controls.
    for (const count of [3, 12, 60]) {
      const notes = Array.from({ length: count }, (_, index) => makeNote({ id: `n${index}`, body: `body ${index}` }))
      const planned = arrangeLayouts(notes)
      for (const layout of planned.values()) {
        const centreX = layout.x + WIDTH_PX[layout.width] / 2
        const centreY = layout.y + estimateHeight({ ...makeNote(), layout }, layout.width) / 2
        // No card's centre may fall inside the reserved disc.
        expect(Math.hypot(centreX, centreY)).toBeGreaterThan(CENTRE_RADIUS - 1)
      }
    }
  })

  it('honours an explicit centre radius and defaults to the shipped one', () => {
    const notes = Array.from({ length: 8 }, (_, index) => makeNote({ id: `n${index}` }))
    const defaulted = arrangeLayouts(notes)
    const explicit = arrangeLayouts(notes, { centreRadius: CENTRE_RADIUS })
    expect([...defaulted.entries()]).toEqual([...explicit.entries()])
    // A larger reserve pushes every card further out.
    const wide = arrangeLayouts(notes, { centreRadius: 600 })
    const minRadius = (planned: Map<string, { x: number; y: number }>): number =>
      Math.min(...[...planned.values()].map((layout) => Math.hypot(layout.x, layout.y)))
    expect(minRadius(wide)).toBeGreaterThan(minRadius(defaulted))
  })

  it('counts CJK text at two columns so a Chinese wall does not pack too tightly', () => {
    // Regression: a Chinese note was estimated at half its rendered height, so
    // the shelf packing put the next card on top of it. The assertion is strict
    // (`>`): a single-width counter that merely tied would satisfy `>=` while
    // still under-estimating, which is exactly the bug being guarded against.
    const chinese = makeNote({ body: '随手记下一闪而过的灵感，或一件临时的工作。点右下角的新建一张便签；按快捷键保存。'.padEnd(65, '好') })
    const latin = makeNote({ body: 'Jot down a passing idea or a piece of temporary work and save it.'.padEnd(65, 'x') })
    // Same character count: the CJK string is padded to the Latin one's length
    // so the only variable is the glyph width.
    expect([...chinese.body].length).toBe([...latin.body].length)
    expect(estimateHeight(chinese, 'md')).toBeGreaterThan(estimateHeight(latin, 'md'))
    expect(estimateHeight(chinese, 'sm')).toBeGreaterThan(estimateHeight(latin, 'sm'))
  })

  it('charges a long title its real wrapped height instead of a flat allowance', () => {
    // Blocker regression: the title was charged a flat 1.4 lines no matter how
    // long it was, while a title is capped at LIMITS.title characters and wraps
    // like any other text. A 120-char CJK title estimated at 104px and rendered
    // at ~244px — under the CSS cap, so the cap could not hide it.
    const shortTitle = makeNote({ title: '短', body: 'x' })
    const longTitle = makeNote({ title: '便'.repeat(LIMITS.title), body: 'x' })
    const shortHeight = estimateHeight(shortTitle, 'sm')
    const longHeight = estimateHeight(longTitle, 'sm')
    expect(longHeight).toBeGreaterThan(shortHeight + 80)
    // And it must still respect the preset budget.
    expect(longHeight).toBeLessThanOrEqual(MAX_CARD_HEIGHT.sm)
  })

  it('charges tag pills by their label width, not a flat line', () => {
    const oneShortTag = makeNote({ tags: ['a'] })
    const manyLongTags = makeNote({ tags: Array.from({ length: LIMITS.tags }, () => '标签'.repeat(8).slice(0, LIMITS.tag)) })
    expect(estimateHeight(manyLongTags, 'sm')).toBeGreaterThan(estimateHeight(oneShortTag, 'sm'))
  })

  it('caps a long note at the preset budget so the estimate matches the rendered box', () => {
    // The Client applies the same cap as a CSS max-height; without it a very
    // long note would grow past the estimate and overlap the shelf below.
    const huge = makeNote({ body: 'word '.repeat(400) })
    for (const width of ['sm', 'md', 'lg'] as const) {
      expect(estimateHeight(huge, width)).toBe(MAX_CARD_HEIGHT[width])
      expect(estimateHeight(huge, width)).toBeLessThanOrEqual(MAX_CARD_HEIGHT[width])
    }
  })

  it('never overlaps two cards even when every card is at the height cap', () => {
    // Worst case: every card is the largest preset, at the height cap, with a
    // maximum-length CJK title AND a maximum-length body.
    const notes = Array.from({ length: 10 }, (_, index) =>
      makeNote({
        id: `n${index}`,
        title: '便'.repeat(LIMITS.title),
        body: '词 '.repeat(2000).slice(0, LIMITS.body),
        layout: { x: 0, y: 0, rotate: 0, width: 'lg' },
      }),
    )
    const planned = arrangeLayouts(notes)
    const boxes = notes.map((note) => {
      const layout = planned.get(note.id)!
      const extent = rotatedExtent(WIDTH_PX[layout.width], estimateHeight(note, layout.width), layout.rotate)
      return { x: layout.x, y: layout.y, w: extent.width, h: extent.height }
    })
    for (const [index, left] of boxes.entries()) {
      for (const right of boxes.slice(index + 1)) {
        const overlapX = left.x < right.x + right.w && right.x < left.x + left.w
        const overlapY = left.y < right.y + right.h && right.y < left.y + left.h
        expect(overlapX && overlapY).toBe(false)
      }
    }
  })

  it('stays inside the world bounds on a very large wall instead of piling cards on the edge', () => {
    // Blocker regression: the packer clamped every card past the coordinate
    // limit, which pinned them all to y=20000 and produced hundreds of
    // overlapping pairs. A large wall must either fit or fail loudly.
    // Maximum-height cards: 300 of them at the `lg` cap is the case that used
    // to run past the coordinate limit and pin cards to the same edge.
    const notes = Array.from({ length: 300 }, (_, index) =>
      makeNote({ id: `n${index}`, body: 'word '.repeat(400), layout: { x: 0, y: 0, rotate: 0, width: 'lg' } }),
    )
    const planned = arrangeLayouts(notes)
    const boxes = notes.map((note) => {
      const layout = planned.get(note.id)!
      expect(Math.abs(layout.y)).toBeLessThanOrEqual(LAYOUT_LIMITS.coord)
      const extent = rotatedExtent(WIDTH_PX[layout.width], estimateHeight(note, layout.width), layout.rotate)
      return { x: layout.x, y: layout.y, w: extent.width, h: extent.height }
    })
    // No two cards share a position, AND no two actually overlap. The position
    // check alone was not enough: silently clamping pins hundreds of cards to
    // the same y while their x still differs, so unique positions can coexist
    // with thousands of overlaps.
    expect(new Set(boxes.map((box) => `${box.x}:${box.y}`)).size).toBe(boxes.length)
    let overlaps = 0
    for (const [index, left] of boxes.entries()) {
      for (const right of boxes.slice(index + 1)) {
        const overlapX = left.x < right.x + right.w && right.x < left.x + left.w
        const overlapY = left.y < right.y + right.h && right.y < left.y + left.h
        if (overlapX && overlapY) overlaps += 1
      }
    }
    expect(overlaps).toBe(0)
  })

  it('preserves the width preset a card already had', () => {
    const notes = [
      makeNote({ id: 'a', layout: { x: 0, y: 0, rotate: 0, width: 'lg' } }),
      makeNote({ id: 'b', layout: { x: 0, y: 0, rotate: 0, width: 'sm' } }),
    ]
    const planned = arrangeLayouts(notes)
    expect(planned.get('a')?.width).toBe('lg')
    expect(planned.get('b')?.width).toBe('sm')
  })

  it('returns a placement for every note, including never-placed ones', () => {
    const notes = [makeNote({ id: 'a' }), makeNote({ id: 'b', layout: { x: 5, y: 5, rotate: 0, width: 'md' } })]
    const planned = arrangeLayouts(notes)
    expect(planned.size).toBe(2)
    expect(planned.has('a')).toBe(true)
    expect(planned.has('b')).toBe(true)
  })
})
