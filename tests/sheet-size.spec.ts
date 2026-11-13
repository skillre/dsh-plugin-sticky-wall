import { describe, expect, it } from 'vitest'
import {
  SHEET_DEFAULT,
  SHEET_KEY_STEP,
  SHEET_KEY_STEP_LARGE,
  SHEET_MARGIN,
  SHEET_MIN,
  SHEET_STORAGE_KEY,
  arrowDelta,
  clampSheetSize,
  mergePreference,
  parseSheetSize,
  readSheetSize,
  resizeSheet,
  serializeSheetSize,
  writeSheetSize,
  type StorageLike,
} from '../src/client/sheet-size.js'

/**
 * Composer geometry tests.
 *
 * The size is the one piece of composer state that survives a reload, so a
 * defect here is sticky: a bad value is restored on every future open. The tests
 * therefore concentrate on the values a real session can produce — a window
 * smaller than the preference, a corrupt stored string, a drag that overshoots —
 * rather than on the happy path alone.
 */

const WIDE = { width: 1440, height: 900 }

/** An in-memory `Storage`, plus the ways a real one refuses to cooperate. */
function memoryStorage(initial?: Record<string, string>): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial ?? {}))
  return {
    data,
    getItem(key) {
      return data.get(key) ?? null
    },
    setItem(key, value) {
      data.set(key, value)
    },
  }
}

describe('clampSheetSize', () => {
  it('keeps a preference that already fits', () => {
    expect(clampSheetSize({ width: 800, height: 600 }, WIDE)).toEqual({ width: 800, height: 600 })
  })

  it('never exceeds the viewport minus the scrim margin', () => {
    const size = clampSheetSize({ width: 5000, height: 4000 }, WIDE)
    expect(size.width).toBe(WIDE.width - SHEET_MARGIN * 2)
    expect(size.height).toBe(WIDE.height - SHEET_MARGIN * 2)
  })

  it('applies the floor rather than shrinking to nothing', () => {
    expect(clampSheetSize({ width: 10, height: 10 }, WIDE)).toEqual({ width: SHEET_MIN.width, height: SHEET_MIN.height })
  })

  it('drops the floor when the window is smaller than the minimum', () => {
    // Being cramped beats overflowing: a 761px-wide sheet in a 400px window puts
    // the Save button off screen, which makes the composer unusable rather than
    // merely small.
    const tiny = { width: 400, height: 300 }
    const size = clampSheetSize({ width: 880, height: 680 }, tiny)
    expect(size.width).toBe(400 - SHEET_MARGIN * 2)
    expect(size.height).toBe(300 - SHEET_MARGIN * 2)
    expect(size.width).toBeLessThan(SHEET_MIN.width)
  })

  it('never returns a zero or negative dimension', () => {
    for (const viewport of [{ width: 1, height: 1 }, { width: 0, height: 0 }, { width: 30, height: 30 }]) {
      const size = clampSheetSize({ width: 880, height: 680 }, viewport)
      expect(size.width).toBeGreaterThan(0)
      expect(size.height).toBeGreaterThan(0)
    }
  })

  it('falls back to the floor instead of propagating NaN', () => {
    // A NaN in a style attribute renders no width at all, so the modal collapses.
    const size = clampSheetSize({ width: Number.NaN, height: Number.NaN }, WIDE)
    expect(size).toEqual({ width: SHEET_MIN.width, height: SHEET_MIN.height })
  })

  it('rounds fractional input so the style attribute stays clean', () => {
    expect(clampSheetSize({ width: 700.6, height: 500.4 }, WIDE)).toEqual({ width: 701, height: 500 })
  })
})

describe('resizeSheet', () => {
  it('grows and shrinks by the drag delta', () => {
    expect(resizeSheet({ width: 700, height: 500 }, { dx: 40, dy: -30 }, WIDE)).toEqual({ width: 740, height: 470 })
  })

  it('measures every move from the start size, so overshoot is reversible', () => {
    // The hook passes the size the drag STARTED from plus the total delta. A drag
    // far past the clamp and back must land exactly where the pointer is.
    const start = { width: 700, height: 500 }
    expect(resizeSheet(start, { dx: 5000, dy: 5000 }, WIDE)).toEqual({ width: 1392, height: 852 })
    expect(resizeSheet(start, { dx: 20, dy: 20 }, WIDE)).toEqual({ width: 720, height: 520 })
  })

  it('clamps a shrink at the floor', () => {
    expect(resizeSheet({ width: 700, height: 500 }, { dx: -1000, dy: -1000 }, WIDE))
      .toEqual({ width: SHEET_MIN.width, height: SHEET_MIN.height })
  })
})

describe('mergePreference', () => {
  /**
   * The rule that stops a viewport clamp from destroying a preference. Every case
   * here is a scenario a real user hits: a large preference opened in a small
   * window, then nudged.
   */
  const SQUEEZED_PREFERENCE = { width: 1200, height: 800 }
  const SQUEEZED_APPLIED = { width: 652, height: 800 }

  it('keeps the width preference when only the height moved', () => {
    // The reported defect: ArrowDown in a 700px window stored 652x816, so the
    // 1200px width was gone and growing the window back could not restore it.
    const next = { width: 652, height: 816 }
    expect(mergePreference(SQUEEZED_PREFERENCE, SQUEEZED_APPLIED, next))
      .toEqual({ width: 1200, height: 816 })
  })

  it('keeps the height preference when only the width moved', () => {
    const stillSqueezed = { width: 652, height: 800 }
    expect(mergePreference(SQUEEZED_PREFERENCE, SQUEEZED_APPLIED, stillSqueezed))
      .toEqual({ width: 1200, height: 800 })
  })

  it('keeps both preferences when the clamp refused to move at all', () => {
    // ArrowRight at the window edge produced the same 652px. Nothing changed on
    // screen, so nothing about the preference may change either.
    expect(mergePreference(SQUEEZED_PREFERENCE, SQUEEZED_APPLIED, SQUEEZED_APPLIED))
      .toEqual(SQUEEZED_PREFERENCE)
  })

  it('stores the visible size for an axis that did move', () => {
    // A visible resize IS the user's choice: after shrinking from 880 to 780 the
    // preference must be 780, not 880.
    const previous = { width: 880, height: 680 }
    const applied = { width: 880, height: 680 }
    const next = { width: 780, height: 680 }
    expect(mergePreference(previous, applied, next)).toEqual({ width: 780, height: 680 })
  })

  it('is a no-op when nothing moved and nothing was clamped', () => {
    const size = { width: 880, height: 680 }
    expect(mergePreference(size, size, size)).toEqual(size)
  })

  it('stores a size the user grew to even inside a squeezed window', () => {
    // A small preference in a small window renders unchanged, so a drag to the
    // window's edge is a real, visible choice and must be stored.
    const previous = { width: 640, height: 500 }
    const applied = { width: 640, height: 500 }
    const next = { width: 652, height: 500 }
    expect(mergePreference(previous, applied, next)).toEqual({ width: 652, height: 500 })
  })
})

describe('arrowDelta', () => {
  it('drives one axis per key', () => {
    expect(arrowDelta('ArrowRight', false)).toEqual({ dx: SHEET_KEY_STEP, dy: 0 })
    expect(arrowDelta('ArrowLeft', false)).toEqual({ dx: -SHEET_KEY_STEP, dy: 0 })
    expect(arrowDelta('ArrowDown', false)).toEqual({ dx: 0, dy: SHEET_KEY_STEP })
    expect(arrowDelta('ArrowUp', false)).toEqual({ dx: 0, dy: -SHEET_KEY_STEP })
  })

  it('takes a larger step with Shift held', () => {
    expect(arrowDelta('ArrowRight', true)).toEqual({ dx: SHEET_KEY_STEP_LARGE, dy: 0 })
    expect(SHEET_KEY_STEP_LARGE).toBeGreaterThan(SHEET_KEY_STEP)
  })

  it('ignores every other key', () => {
    for (const key of ['Enter', 'Tab', 'Escape', 'a', '0', 'PageDown', 'Home']) {
      expect(arrowDelta(key, false)).toBeNull()
    }
  })
})

describe('parseSheetSize', () => {
  it('round-trips a serialized size', () => {
    const size = { width: 812, height: 604 }
    expect(parseSheetSize(serializeSheetSize(size))).toEqual(size)
  })

  it.each([
    ['absent', null],
    ['empty', ''],
    ['blank', '   '],
    ['not json', 'not-json'],
    ['a bare number', '812'],
    ['a string payload', '"812x604"'],
    ['null payload', 'null'],
    ['an array', '[812,604]'],
    ['missing height', '{"width":812}'],
    ['string dimensions', '{"width":"812","height":"604"}'],
    ['zero dimensions', '{"width":0,"height":0}'],
    ['negative dimensions', '{"width":-40,"height":-40}'],
  ])('rejects %s', (_label, raw) => {
    expect(parseSheetSize(raw as string | null)).toBeNull()
  })

  it('rejects non-finite dimensions', () => {
    expect(parseSheetSize('{"width":null,"height":604}')).toBeNull()
    expect(parseSheetSize('{"width":1e999,"height":604}')).toBeNull()
  })

  it('keeps an out-of-range but positive size, so the clamp — not the parser — owns it', () => {
    // The stored preference is deliberately NOT clamped to the current window:
    // shrinking the window must not destroy it.
    expect(parseSheetSize('{"width":5000,"height":4000}')).toEqual({ width: 5000, height: 4000 })
  })
})

describe('storage round trip', () => {
  it('writes under the namespaced key', () => {
    const storage = memoryStorage()
    writeSheetSize(storage, { width: 800, height: 600 })
    expect(SHEET_STORAGE_KEY).toMatch(/^skillre-sticky-wall\./)
    expect(storage.data.get(SHEET_STORAGE_KEY)).toBe('{"width":800,"height":600}')
  })

  it('reads back what it wrote', () => {
    const storage = memoryStorage()
    writeSheetSize(storage, { width: 901, height: 641 })
    expect(readSheetSize(storage)).toEqual({ width: 901, height: 641 })
  })

  it('returns null when nothing is stored', () => {
    expect(readSheetSize(memoryStorage())).toBeNull()
    expect(readSheetSize(null)).toBeNull()
    expect(readSheetSize(undefined)).toBeNull()
  })

  it('survives a storage that throws on read', () => {
    // Safari private mode and a partitioned origin both throw on access rather
    // than returning null. Losing a size preference must never break the modal.
    const hostile: StorageLike = {
      getItem() { throw new Error('SecurityError') },
      setItem() { throw new Error('SecurityError') },
    }
    expect(readSheetSize(hostile)).toBeNull()
    expect(() => writeSheetSize(hostile, { width: 800, height: 600 })).not.toThrow()
  })

  it('survives a quota refusal on write', () => {
    const full: StorageLike = {
      getItem: () => null,
      setItem() { throw new Error('QuotaExceededError') },
    }
    expect(() => writeSheetSize(full, { width: 800, height: 600 })).not.toThrow()
  })
})

describe('defaults', () => {
  it('is larger than the sheet it replaced', () => {
    // The old sheet was a fixed 560px wide with an 86vh ceiling; both numbers are
    // the defect this change exists to fix, so they are pinned here.
    expect(SHEET_DEFAULT.width).toBeGreaterThan(560)
    expect(SHEET_DEFAULT.height).toBeGreaterThan(560)
  })

  it('fits a common laptop window without being clamped', () => {
    const applied = clampSheetSize(SHEET_DEFAULT, WIDE)
    expect(applied).toEqual({ width: SHEET_DEFAULT.width, height: SHEET_DEFAULT.height })
  })

  it('keeps the minimum below the default, so a user can shrink', () => {
    expect(SHEET_MIN.width).toBeLessThan(SHEET_DEFAULT.width)
    expect(SHEET_MIN.height).toBeLessThan(SHEET_DEFAULT.height)
  })
})
