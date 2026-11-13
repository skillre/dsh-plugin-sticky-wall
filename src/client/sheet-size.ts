/**
 * Composer sheet geometry: the preferred size, its viewport clamp, and the
 * storage round trip.
 *
 * A note is often a paragraph or three of Markdown, but the sheet used to be a
 * fixed `min(560px, 100%)` box with an `86vh` ceiling, so writing anything longer
 * meant scrolling inside an 88px-tall textarea while two thirds of the window sat
 * empty behind the scrim. The sheet is now large by default and resizable.
 *
 * Three rules live here, deliberately free of DOM globals so they stay testable
 * in Node:
 *
 * 1. A **preferred** size is what the user chose. It is stored verbatim and is
 *    never overwritten by a small window.
 * 2. The **applied** size is the preferred size clamped against the viewport with
 *    a fixed margin, computed at render time. Squeezing the window therefore
 *    shrinks the sheet without destroying the preference, and growing it back
 *    restores the size the user actually picked.
 * 3. Storage is a plain string, validated on read: a corrupt or foreign value
 *    falls back to the default instead of producing a zero-sized modal. A merely
 *    LARGE value is kept, because rule 2 is what handles it — dropping it in the
 *    parser would lose a preference the user set on a bigger screen.
 */

/** A sheet's outer width and height, in CSS pixels. */
export interface SheetSize {
  width: number
  height: number
}

/** The viewport the sheet has to fit inside, in CSS pixels. */
export interface Viewport {
  width: number
  height: number
}

/** The slice of `localStorage` this module needs, so it never reaches for a global. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * What a new user gets.
 *
 * Wide enough for a full Markdown line without wrapping (the old 560px wrapped a
 * ~60-character line twice) and tall enough that the textarea, the two inputs and
 * the swatch row are all visible at once. On a 1440x900 window this is 61% x 76%.
 */
export const SHEET_DEFAULT: Readonly<SheetSize> = { width: 880, height: 680 }

/**
 * The floor a resize may not cross.
 *
 * Below this the toolbar wraps and the footer buttons collide, so the sheet stops
 * being usable long before it stops fitting.
 */
export const SHEET_MIN: Readonly<SheetSize> = { width: 460, height: 380 }

/**
 * Gap kept between the sheet and the viewport edge, per side.
 *
 * Mirrors the scrim's own padding, so a maximised sheet never touches the window
 * chrome and the dialog's rounded corners stay visible.
 */
export const SHEET_MARGIN = 24

/** Where the preference lives. Namespaced like every other key this plugin owns. */
export const SHEET_STORAGE_KEY = 'skillre-sticky-wall.sheet-size'

/** One keyboard resize step, in CSS pixels. */
export const SHEET_KEY_STEP = 16
/** The step a Shift-modified arrow key takes. */
export const SHEET_KEY_STEP_LARGE = 64

/**
 * Clamp one axis.
 *
 * `lo` is reduced to `hi` when the viewport is too small for the declared
 * minimum: overflowing a 300px-wide window by 160px would push the sheet's
 * controls off screen, which is strictly worse than being cramped. A non-finite
 * request falls back to the lower bound rather than propagating `NaN` into a
 * `style` attribute — React would then render nothing usable at all.
 */
function clampAxis(value: number, min: number, max: number): number {
  // A non-finite `max` cannot mean "infinitely large": it means the viewport
  // measurement failed, and an infinite sheet is worse than a cramped one. Fall
  // back to the floor, which is always finite.
  const hi = Number.isFinite(max) ? Math.max(1, Math.round(max)) : Math.max(1, Math.round(min))
  const lo = Math.min(Math.round(min), hi)
  // NaN and ±Infinity both mean "no usable request". NaN takes the floor because
  // a `NaNpx` style is dropped by React and collapses the modal entirely;
  // Infinity takes the ceiling because a user asking for "as large as possible"
  // is asking for the maximum, not the minimum.
  if (Number.isNaN(value)) return lo
  if (value === Number.POSITIVE_INFINITY) return hi
  if (value === Number.NEGATIVE_INFINITY) return lo
  return Math.min(hi, Math.max(lo, Math.round(value)))
}

/** Fit a preferred size inside a viewport, keeping the sheet fully visible. */
export function clampSheetSize(size: SheetSize, viewport: Viewport): SheetSize {
  return {
    width: clampAxis(size.width, SHEET_MIN.width, viewport.width - SHEET_MARGIN * 2),
    height: clampAxis(size.height, SHEET_MIN.height, viewport.height - SHEET_MARGIN * 2),
  }
}

/**
 * Apply a pointer drag delta to a starting size.
 *
 * Dragging the grip right or down grows the sheet; the pointer delta is applied to
 * the size the drag STARTED from, never accumulated frame by frame, so a drag that
 * hits the clamp and comes back returns to the size the user is pointing at
 * instead of losing the overshoot.
 */
export function resizeSheet(start: SheetSize, delta: { dx: number; dy: number }, viewport: Viewport): SheetSize {
  return clampSheetSize({ width: start.width + delta.dx, height: start.height + delta.dy }, viewport)
}

/**
 * Combine what the user can SEE with what they had CHOSEN.
 *
 * This is the rule that stops a viewport clamp from silently destroying a
 * preference, and it exists because the naive "store what we just rendered" is
 * wrong in two ways that a user notices:
 *
 * 1. **An axis the action did not touch must keep its own value.** A user with a
 *    1200x800 preference opens the wall in a 700px window, so the sheet renders
 *    652x800. Pressing Down to make it taller changes the height only — and if
 *    the width came along, their 1200px choice would be gone for good the moment
 *    they nudged the height.
 * 2. **An axis that could not move must not be overwritten either.** At the
 *    window's edge, Right produces the same 652px it started from. Storing that
 *    would look like a no-op on screen while permanently downgrading the
 *    preference.
 *
 * Both collapse into one condition: *an axis whose visible size did not change
 * keeps its stored preference*. An axis that did move is stored as the user now
 * sees it, because a visible resize is an explicit choice.
 */
export function mergePreference(previous: SheetSize, applied: SheetSize, next: SheetSize): SheetSize {
  return {
    width: next.width === applied.width ? previous.width : next.width,
    height: next.height === applied.height ? previous.height : next.height,
  }
}

/**
 * The delta one arrow key asks for, or null when the key is not a resize key.
 *
 * Horizontal keys drive width and vertical keys drive height, one axis per key:
 * a corner grip that scaled both axes at once made the last 2px of alignment
 * impossible to hit.
 */
export function arrowDelta(key: string, large: boolean): { dx: number; dy: number } | null {
  const step = large ? SHEET_KEY_STEP_LARGE : SHEET_KEY_STEP
  switch (key) {
    case 'ArrowLeft':
      return { dx: -step, dy: 0 }
    case 'ArrowRight':
      return { dx: step, dy: 0 }
    case 'ArrowUp':
      return { dx: 0, dy: -step }
    case 'ArrowDown':
      return { dx: 0, dy: step }
    default:
      return null
  }
}

/**
 * Parse a stored size.
 *
 * Every rejected shape is a real one: `null` for an absent key, a bare number for
 * a value some earlier build might have written, `""` for a cleared entry, and
 * `0` for the value a naive initialiser produces. All of them mean "no usable
 * preference", never "a 0x0 sheet".
 */
export function parseSheetSize(raw: string | null): SheetSize | null {
  if (raw === null) return null
  const text = raw.trim()
  if (text === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const width = record.width
  const height = record.height
  if (typeof width !== 'number' || typeof height !== 'number') return null
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width <= 0 || height <= 0) return null
  return { width: Math.round(width), height: Math.round(height) }
}

/** Serialize a size for storage. */
export function serializeSheetSize(size: SheetSize): string {
  return JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) })
}

/**
 * Read the stored preference.
 *
 * A private-mode or sandboxed surface throws on access rather than returning
 * null, and losing a size preference must never break the composer, so every
 * failure degrades to "no preference".
 */
export function readSheetSize(storage: StorageLike | null | undefined): SheetSize | null {
  if (storage === null || storage === undefined) return null
  try {
    return parseSheetSize(storage.getItem(SHEET_STORAGE_KEY))
  } catch {
    return null
  }
}

/** Persist a size; a refusal (quota, private mode) is silently non-fatal. */
export function writeSheetSize(storage: StorageLike | null | undefined, size: SheetSize): void {
  if (storage === null || storage === undefined) return
  try {
    storage.setItem(SHEET_STORAGE_KEY, serializeSheetSize(size))
  } catch {
    // A remembered size is a convenience, not data: never surface this.
  }
}
