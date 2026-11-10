import { describe, expect, it } from 'vitest'
import {
  arrangeLayouts,
  clampLayout,
  estimateHeight,
  findFreeLayout,
  footprintOf,
  intersectsReserve,
  MAX_CARD_HEIGHT,
  noteBox,
  normalizeReserve,
  rotatedExtent,
  layoutOf,
  previewLayout,
  previewWidth,
  pushOutOfReserve,
  sameLayout,
} from '../src/layout.js'
import { CENTRE_RESERVE, LAYOUT_LIMITS, LIMITS, WIDTH_PX, type Note, type NoteLayout } from '../src/types.js'

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
    // Measured along the ELLIPSE the spiral is stretched onto, not a circle: the
    // derived wall is deliberately wider than it is tall so a wide window can
    // frame it without zooming out for empty corners.
    const SQUASH = 1.4
    const radii = layouts.map((layout) =>
      Math.hypot((layout.x + WIDTH_PX[layout.width] / 2) / SQUASH, layout.y + 100),
    )
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
    // The camera opens on the wall's BOUNDING BOX centre, so that is what must sit
    // on the origin — not merely "somewhere near the middle".
    //
    // This is a correctness property, not a cosmetic one: the centrepiece is a
    // screen-space block at the viewport's middle and the packer's reserved
    // rectangle is centred on the origin, so a box off the origin puts the capture
    // field off its own reserve and a card legitimately ends up behind it.
    const notes = Array.from({ length: 20 }, (_, index) => makeNote({ id: `n${index}`, body: `body ${index}` }))
    const planned = arrangeLayouts(notes)
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const [id, layout] of planned) {
      expect(Math.abs(layout.x)).toBeLessThanOrEqual(LAYOUT_LIMITS.coord)
      expect(Math.abs(layout.y)).toBeLessThanOrEqual(LAYOUT_LIMITS.coord)
      const note = notes.find((candidate) => candidate.id === id)!
      const box = footprintOf(note, layout)
      minX = Math.min(minX, box.x)
      maxX = Math.max(maxX, box.x + box.width)
      minY = Math.min(minY, box.y)
      maxY = Math.max(maxY, box.y + box.height)
    }
    // Tight: the shift is applied exactly, so the box centre lands on the origin.
    expect(Math.abs((minX + maxX) / 2)).toBeLessThan(2)
    expect(Math.abs((minY + maxY) / 2)).toBeLessThan(2)
  })

  it('packs a fourteen-card wall tightly against the centrepiece, not far away', () => {
    // The complaint this fixes: the tidied wall looked SMALL. Rings were dense
    // per ring but the first ring's radius is the reserve's half-DIAGONAL, so the
    // innermost cards sat at the rectangle's corner distance in all four
    // directions — including the four where the rectangle is barely a card away.
    // Fourteen cards then filled 1645x1794, which a 1160x780 canvas can only
    // frame at 36%. Packing against the rectangle's own CONTOUR keeps each card
    // one half-size from the reserve instead.
    const notes = Array.from({ length: 14 }, (_, index) => makeNote({ id: `n${index}`, body: `body ${index}` }))
    const planned = arrangeLayouts(notes)
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const [id, layout] of planned) {
      const note = notes.find((candidate) => candidate.id === id)!
      const box = footprintOf(note, layout)
      minX = Math.min(minX, box.x)
      maxX = Math.max(maxX, box.x + box.width)
      minY = Math.min(minY, box.y)
      maxY = Math.max(maxY, box.y + box.height)
    }
    const width = maxX - minX
    const height = maxY - minY
    // The measured failure was 1645x1794. A contour-packed wall of the same
    // fourteen notes is ~1290x670, so these bounds are the old shape's floor.
    expect(width).toBeLessThan(1400)
    expect(height).toBeLessThan(900)
    // And the camera can now frame it at a legible size instead of 36%.
    const fit = Math.min((1160 - 96) / width, (780 - 48 - 68) / height, 1)
    expect(fit).toBeGreaterThan(0.7)
  })

  it('packs a large wall into a wide cluster, not a column or a square disc', () => {
    // A shelf packer grew one dimension: a 300-card wall became a kilometre-tall
    // column. A circle stays square, which wastes the left and right of a window
    // that is wider than it is tall — the wall then frames at a smaller zoom than
    // it needs to. The packer scores each slot by the zoom the whole wall would
    // need in a reference viewport, so the shape converges on that window's own
    // aspect: wide, and never a strip.
    for (const count of [60, 150, 300]) {
      const notes = Array.from({ length: count }, (_, index) => makeNote({ id: `n${index}`, body: `body ${index}` }))
      const planned = arrangeLayouts(notes)
      let minX = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      for (const [id, layout] of planned) {
        const note = notes.find((candidate) => candidate.id === id)!
        const box = footprintOf(note, layout)
        minX = Math.min(minX, box.x)
        maxX = Math.max(maxX, box.x + box.width)
        minY = Math.min(minY, box.y)
        maxY = Math.max(maxY, box.y + box.height)
      }
      const ratio = (maxX - minX) / (maxY - minY)
      // Wider than tall, but never a strip: the reference viewport is 1.6:1 and
      // the packer is allowed to overshoot it rather than distort the wall.
      expect(ratio).toBeGreaterThan(1.0)
      expect(ratio).toBeLessThan(2.0)
    }
  })

  it('leaves a clear rectangle in the middle for the centrepiece', () => {
    // The centre holds the greeting, the tally and the quick-capture field. A
    // card packed there would sit on top of the wall's own controls — and the
    // reserve is a RECTANGLE because that centrepiece is a wide, short stack: a
    // circle either wasted a tall column of paper or let wide cards in sideways.
    for (const count of [3, 12, 60]) {
      const notes = Array.from({ length: count }, (_, index) => makeNote({ id: `n${index}`, body: `body ${index}` }))
      const planned = arrangeLayouts(notes)
      for (const [id, layout] of planned) {
        const note = notes.find((candidate) => candidate.id === id)!
        // No card's FOOTPRINT may intersect the reserved rectangle. Measured on
        // the box, not the centre: a card whose centre clears the reserve can
        // still reach over the capture field by half its own width.
        expect(intersectsReserve(footprintOf(note, layout), CENTRE_RESERVE)).toBe(false)
      }
    }
  })

  it('honours an explicit centre reserve and defaults to the shipped one', () => {
    const notes = Array.from({ length: 8 }, (_, index) => makeNote({ id: `n${index}` }))
    const defaulted = arrangeLayouts(notes)
    const explicit = arrangeLayouts(notes, { centreReserve: CENTRE_RESERVE })
    expect([...defaulted.entries()]).toEqual([...explicit.entries()])
    // A larger reserve pushes every card further out.
    const wide = arrangeLayouts(notes, { centreReserve: { halfWidth: 620, halfHeight: 400 } })
    const minRadius = (planned: Map<string, { x: number; y: number }>): number =>
      Math.min(...[...planned.values()].map((layout) => Math.hypot(layout.x, layout.y)))
    expect(minRadius(wide)).toBeGreaterThan(minRadius(defaulted))
  })

  it('clamps a nonsensical reserve instead of leaving no paper for the cards', () => {
    // The Client sends a positioned, zoom-corrected reserve, so it can arrive with
    // Infinity or a negative number in ANY field, or with an absurdly large one.
    // None of those may make the packer throw or push every card past the world
    // bounds. A missing position resolves to the origin.
    expect(normalizeReserve({ halfWidth: Number.NaN, halfHeight: -5 })).toEqual({ x: 0, y: 0, halfWidth: 0, halfHeight: 0 })
    expect(normalizeReserve({ x: Number.NaN, y: Number.POSITIVE_INFINITY, halfWidth: 10, halfHeight: 10 }))
      .toEqual({ x: 0, y: 0, halfWidth: 10, halfHeight: 10 })
    const capped = normalizeReserve({ halfWidth: 10_000_000, halfHeight: 10_000_000 })
    expect(capped.halfWidth).toBe(LAYOUT_LIMITS.coord / 4)
    // A position is clamped to the world bounds, not snapped to the origin: a
    // panned wall legitimately puts the field far away, and snapping it back would
    // reintroduce the bug the position exists to fix.
    expect(normalizeReserve({ x: 10_000_000, y: -10_000_000, halfWidth: 10, halfHeight: 10 }))
      .toEqual({ x: LAYOUT_LIMITS.coord, y: -LAYOUT_LIMITS.coord, halfWidth: 10, halfHeight: 10 })
    const notes = Array.from({ length: 6 }, (_, index) => makeNote({ id: `n${index}` }))
    const planned = arrangeLayouts(notes, { centreReserve: capped })
    expect(planned.size).toBe(6)
    for (const layout of planned.values()) {
      expect(Math.abs(layout.x)).toBeLessThanOrEqual(LAYOUT_LIMITS.coord)
      expect(Math.abs(layout.y)).toBeLessThanOrEqual(LAYOUT_LIMITS.coord)
    }
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

describe('free spot for a new card', () => {
  /** Whether two footprints share any area. */
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

  it('places the first card just outside the centrepiece, not off in the distance', () => {
    // The complaint this fixes: a note created from the centre capture field
    // landed far away — the derived spiral grows with the note's index, so the
    // tenth capture could be more than a screen from where the user was looking,
    // and the wall looked like the capture had silently failed.
    const fresh = makeNote({ id: 'fresh', body: 'a new idea' })
    const layout = findFreeLayout(fresh, [])
    const box = noteBox({ ...fresh, layout }, 0)
    // Outside the reserved middle ...
    const inside =
      box.x < CENTRE_RESERVE.halfWidth &&
      box.x + box.width > -CENTRE_RESERVE.halfWidth &&
      box.y < CENTRE_RESERVE.halfHeight &&
      box.y + box.height > -CENTRE_RESERVE.halfHeight
    expect(inside).toBe(false)
    // ... and close to it: the nearest legal ring, not a far hole.
    const distance = Math.hypot(box.x + box.width / 2, box.y + box.height / 2)
    expect(distance).toBeLessThan(560)
  })

  it('never puts a new card on top of an existing one', () => {
    const existing = Array.from({ length: 12 }, (_, index) =>
      makeNote({ id: `n${index}`, body: `body ${index}`, layout: { x: index * 40, y: index * 30, rotate: 0, width: 'md' } }),
    )
    const fresh = makeNote({ id: 'fresh', body: 'a new idea' })
    const layout = findFreeLayout(fresh, existing)
    const box = noteBox({ ...fresh, layout }, 0)
    for (const note of existing) {
      expect(overlaps(box, noteBox(note, 0))).toBe(false)
    }
  })

  it('is deterministic, so two windows agree on where the card goes', () => {
    const existing = Array.from({ length: 5 }, (_, index) => makeNote({ id: `n${index}`, body: `body ${index}` }))
    const fresh = makeNote({ id: 'fresh' })
    expect(findFreeLayout(fresh, existing)).toEqual(findFreeLayout(fresh, existing))
  })

  it('places a new card beside the field where the field ACTUALLY is', () => {
    // The reported defect: capturing from the centre field put the card behind
    // that field. The field is a screen-space overlay, so on a panned wall the
    // world patch it covers is nowhere near the origin — and a reserve that only
    // carried half-extents kept the origin clear instead, placing the card next
    // to a point the user could not see.
    const fresh = makeNote({ id: 'fresh', body: 'captured while panned' })
    // A wall panned far from the origin: the field now covers (1800, -1200).
    const positioned = { x: 1800, y: -1200, halfWidth: CENTRE_RESERVE.halfWidth, halfHeight: CENTRE_RESERVE.halfHeight }
    const layout = findFreeLayout(fresh, [], { centreReserve: positioned })
    const box = noteBox({ ...fresh, layout }, 0)
    // Clear of the field's REAL rectangle ...
    const insideField =
      box.x < positioned.x + positioned.halfWidth &&
      box.x + box.width > positioned.x - positioned.halfWidth &&
      box.y < positioned.y + positioned.halfHeight &&
      box.y + box.height > positioned.y - positioned.halfHeight
    expect(insideField).toBe(false)
    // ... and NEXT TO it, not next to the origin: the whole point of the position
    // is that the card lands where the user is looking.
    const distance = Math.hypot(
      box.x + box.width / 2 - positioned.x,
      box.y + box.height / 2 - positioned.y,
    )
    expect(distance).toBeLessThan(620)
    // It must be nowhere near the origin, or the field's position was ignored.
    const fromOrigin = Math.hypot(box.x + box.width / 2, box.y + box.height / 2)
    expect(fromOrigin).toBeGreaterThan(1200)
  })

  it('places a panned-wall capture on the same side regardless of the origin', () => {
    // Determinism plus position-awareness: the SAME field position must always
    // produce the SAME card position, and two different field positions must not
    // produce the same answer (which would mean the position is being dropped).
    const fresh = makeNote({ id: 'fresh', body: 'same id, different field' })
    const here = findFreeLayout(fresh, [], { centreReserve: { x: 0, y: 0, halfWidth: 330, halfHeight: 136 } })
    const there = findFreeLayout(fresh, [], { centreReserve: { x: 2400, y: 900, halfWidth: 330, halfHeight: 136 } })
    expect(findFreeLayout(fresh, [], { centreReserve: { x: 2400, y: 900, halfWidth: 330, halfHeight: 136 } })).toEqual(there)
    expect(here).not.toEqual(there)
    // The offset between them is the field's own offset: the card follows the field.
    expect(there.x - here.x).toBeCloseTo(2400, 0)
    expect(there.y - here.y).toBeCloseTo(900, 0)
  })

  it('keeps a dragged card clear of a field that is not at the origin', () => {
    // The drag path uses `pushOutOfReserve`, which must also honour the position:
    // a card dropped onto a panned field has to be pushed off THAT field.
    const note = makeNote({ id: 'dragged', body: 'dropped on the field' })
    const field = { x: 900, y: 400, halfWidth: 330, halfHeight: 136 }
    const onField = { x: field.x - 60, y: field.y - 40, rotate: 0, width: 'md' as const }
    const pushed = pushOutOfReserve(note, onField, field)
    const box = footprintOf(note, pushed)
    expect(intersectsReserve(box, field)).toBe(false)
    // A card that was already clear must not be moved at all.
    const clear = { x: field.x + 2000, y: field.y + 2000, rotate: 0, width: 'md' as const }
    expect(pushOutOfReserve(note, clear, field)).toEqual(clear)
  })

  it('finds a gap between existing cards instead of always the outermost ring', () => {
    // A wall with a deliberate hole in the middle ring: the new card belongs in
    // the hole, which is nearer the middle than the next free ring outside.
    const existing = Array.from({ length: 16 }, (_, index) => {
      const theta = (index / 16) * Math.PI * 2
      return makeNote({
        id: `ring${index}`,
        body: 'x',
        layout: { x: Math.cos(theta) * 620 - 111, y: Math.sin(theta) * 620 - 100, rotate: 0, width: 'md' },
      })
    })
    const fresh = makeNote({ id: 'fresh', body: 'gap' })
    const layout = findFreeLayout(fresh, existing)
    const box = noteBox({ ...fresh, layout }, 0)
    // It must not have been pushed outside the ring it could have fit inside.
    const distance = Math.hypot(box.x + box.width / 2, box.y + box.height / 2)
    expect(distance).toBeLessThan(620)
    for (const note of existing) expect(overlaps(box, noteBox(note, 0))).toBe(false)
  })
})
