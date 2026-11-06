import { describe, expect, it } from 'vitest'
import {
  arrangeLayouts,
  clampLayout,
  estimateHeight,
  MAX_CARD_HEIGHT,
  layoutOf,
  previewLayout,
  previewWidth,
  sameLayout,
} from '../src/layout.js'
import { LAYOUT_LIMITS, WIDTH_PX, type Note, type NoteLayout } from '../src/types.js'

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
      return { x: layout.x, y: layout.y, w: WIDTH_PX[layout.width], h: estimateHeight(note, layout.width) }
    })
    for (const [index, left] of boxes.entries()) {
      for (const right of boxes.slice(index + 1)) {
        const overlapX = left.x < right.x + right.w && right.x < left.x + left.w
        const overlapY = left.y < right.y + right.h && right.y < left.y + left.h
        expect(overlapX && overlapY).toBe(false)
      }
    }
  })

  it('keeps the arrangement inside the world bounds and starts near the origin', () => {
    const notes = Array.from({ length: 20 }, (_, index) => makeNote({ id: `n${index}`, body: `body ${index}` }))
    const planned = arrangeLayouts(notes)
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    for (const layout of planned.values()) {
      expect(Math.abs(layout.x)).toBeLessThanOrEqual(LAYOUT_LIMITS.coord)
      expect(Math.abs(layout.y)).toBeLessThanOrEqual(LAYOUT_LIMITS.coord)
      minX = Math.min(minX, layout.x)
      minY = Math.min(minY, layout.y)
    }
    // The packing is shifted so the top-left card lands in the positive
    // quadrant, which keeps the canvas scroll extent predictable.
    expect(minX).toBeGreaterThanOrEqual(0)
    expect(minY).toBeGreaterThanOrEqual(0)
    expect(minX).toBeLessThan(80)
    expect(minY).toBeLessThan(80)
  })

  it('counts CJK text at two columns so a Chinese wall does not pack too tightly', () => {
    // Regression: a Chinese note was estimated at half its rendered height, so
    // the shelf packing put the next card on top of it. The estimate must
    // account for the double-width glyphs, not the code-point count.
    const chinese = makeNote({ body: '随手记下一闪而过的灵感，或一件临时的工作。点右下角的新建一张便签；按快捷键保存。' })
    const latin = makeNote({ body: 'Jot down a passing idea or a piece of temporary work and save it.' })
    // Same character count, but the CJK body occupies twice the columns.
    expect(estimateHeight(chinese, 'md')).toBeGreaterThanOrEqual(estimateHeight(latin, 'md'))
    expect(estimateHeight(chinese, 'sm')).toBeGreaterThanOrEqual(estimateHeight(latin, 'sm'))
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
    // Worst case: every card is the largest preset and the tallest allowed body.
    const notes = Array.from({ length: 10 }, (_, index) =>
      makeNote({ id: `n${index}`, body: 'word '.repeat(400), layout: { x: 0, y: 0, rotate: 0, width: 'lg' } }),
    )
    const planned = arrangeLayouts(notes)
    const boxes = notes.map((note) => {
      const layout = planned.get(note.id)!
      return { x: layout.x, y: layout.y, w: WIDTH_PX[layout.width], h: estimateHeight(note, layout.width) }
    })
    for (const [index, left] of boxes.entries()) {
      for (const right of boxes.slice(index + 1)) {
        const overlapX = left.x < right.x + right.w && right.x < left.x + left.w
        const overlapY = left.y < right.y + right.h && right.y < left.y + left.h
        expect(overlapX && overlapY).toBe(false)
      }
    }
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
