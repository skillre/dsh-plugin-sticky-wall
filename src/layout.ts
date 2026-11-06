/**
 * Free-canvas geometry shared by the Host and the Client halves.
 *
 * The wall is a canvas, not a grid: every card owns a world position, a
 * rotation and a width preset. Two operations produce those numbers:
 *
 * - {@link arrangeLayouts} is the Host-side "tidy" pass. It is deterministic:
 *   the same notes always produce the same wall, so a user who presses tidy
 *   twice does not get a reshuffled board, and a test can assert the exact
 *   packing without a browser.
 * - {@link previewLayout} is the Client-side fallback for a note that was never
 *   placed (a wall written before the canvas existed, or a note created by the
 *   agent tool). It derives a position from the note's own id and its index in
 *   the stable order, so the first render is already a scattered wall instead
 *   of one tall stack, and it never writes to the Host.
 *
 * Both halves import this module, so the geometry never drifts between the
 * value the Host persists and the value the Client previews.
 */

import { LAYOUT_LIMITS, WIDTHS, WIDTH_PX, type Note, type NoteLayout, type NoteWidth } from './types.js'

/** Minimum horizontal breathing room between two cards in the tidy packing. */
const SHELF_GAP_X = 26
/** Minimum vertical breathing room between two shelves in the tidy packing. */
const SHELF_GAP_Y = 30
/** Narrowest tidy shelf; the packer widens it for very large walls. */
const SHELF_WIDTH = 1180
/** Preview grid cell, generous enough that scattered cards rarely overlap. */
const PREVIEW_CELL_W = 300
const PREVIEW_CELL_H = 232
/** Preview columns; four cells read as a wall on a typical centre column. */
const PREVIEW_COLUMNS = 4
/** Maximum rotation the tidy pass adds, in degrees. */
const TIDY_TILT = 3.4
/** Maximum rotation the preview fallback adds, in degrees. */
const PREVIEW_TILT = 4

/** Deterministic 32-bit FNV-1a hash; no crypto, identical on both halves. */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value >>> 0
}

/** Deterministic unit float in `[0, 1)` derived from a string. */
function unit(text: string): number {
  return hash(text) / 0x100000000
}

/** Round to one decimal so stored layouts stay small and diffable. */
function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** Clamp one layout into the declared world bounds. */
export function clampLayout(layout: NoteLayout): NoteLayout {
  const coord = LAYOUT_LIMITS.coord
  const tilt = LAYOUT_LIMITS.rotate
  return {
    x: round(Math.min(coord, Math.max(-coord, Number(layout.x) || 0))),
    y: round(Math.min(coord, Math.max(-coord, Number(layout.y) || 0))),
    rotate: round(Math.min(tilt, Math.max(-tilt, Number(layout.rotate) || 0))),
    width: layout.width,
  }
}

/** True when two layouts describe the same position (rounded comparison). */
export function sameLayout(left: NoteLayout | null, right: NoteLayout | null): boolean {
  if (left === null || right === null) return left === right
  return (
    round(left.x) === round(right.x) &&
    round(left.y) === round(right.y) &&
    round(left.rotate) === round(right.rotate) &&
    left.width === right.width
  )
}

/** Pick the width preset a never-placed note gets; weighted toward the middle. */
export function previewWidth(id: string): NoteWidth {
  const roll = unit(`${id}:w`)
  if (roll < 0.42) return 'md'
  if (roll < 0.74) return 'sm'
  return 'lg'
}

/** Hard height budget per width preset, in pixels at zoom 1. */
export const MAX_CARD_HEIGHT: Readonly<Record<NoteWidth, number>> = Object.freeze({
  sm: 236,
  md: 288,
  lg: 336,
})

/**
 * Count text columns rather than characters.
 *
 * A CJK glyph occupies roughly two columns of a monospace-ish advance, and a
 * wall written in Chinese is the common case for this plugin. Counting code
 * points made every Chinese note look half as tall as it renders, which let the
 * tidy pass pack shelves on top of each other.
 */
function columns(text: string): number {
  let total = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    total += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)) ? 2 : 1
  }
  return total
}

/**
 * Estimate a card's rendered height from its content.
 *
 * The tidy pass runs on the Host, which cannot measure text, so it estimates
 * from the column budget of the chosen width. The estimate is deliberately
 * conservative and capped by {@link MAX_CARD_HEIGHT}, and the Client applies
 * that same cap as a CSS max-height: the estimate and the rendered box therefore
 * agree, which is what keeps a tidied wall free of overlapping cards.
 */
export function estimateHeight(note: Note, width: NoteWidth): number {
  const columnsPerLine = columnsPerLineFor(width)
  let lines = 0
  for (const paragraph of note.body.split('\n')) {
    if (paragraph.trim() === '') {
      lines += 0.4
      continue
    }
    lines += Math.max(1, Math.ceil(columns(paragraph.replace(/^[#>*\-+\d. ]+/u, '')) / columnsPerLine))
  }
  // The title wraps like any other text, and it is capped at LIMITS.title (120)
  // characters — which is a dozen lines at the small preset, not the flat 1.4
  // this used to charge. Under-counting it was a real overlap bug: a 120-char
  // CJK title estimated at 104px while rendering at ~244px, below the CSS cap,
  // so the cap could not mask it.
  if (note.title !== '') {
    // The title is one weight step heavier and has no paragraph spacing, so it
    // fits slightly fewer columns than the body at the same width.
    const titleColumns = columnsPerLineFor(width, 0.92)
    lines += Math.max(1, Math.ceil(columns(note.title) / titleColumns))
  }
  // Tag pills wrap, and each pill costs its label plus padding and gap.
  if (note.tags.length > 0) {
    let pillColumns = 0
    for (const tag of note.tags) pillColumns += columns(tag) + 4
    lines += Math.max(1, Math.ceil(pillColumns / columnsPerLine))
  }
  const clamped = Math.min(16, Math.max(2, lines))
  const estimated = Math.round(58 + clamped * 19)
  return Math.min(estimated, MAX_CARD_HEIGHT[width])
}

/** Columns of text that fit on one line of a card at the given width. */
function columnsPerLineFor(width: NoteWidth, density = 1): number {
  // 7.1px per column at the card's 13px type size, minus the horizontal padding.
  return Math.max(8, Math.floor(((WIDTH_PX[width] - 26) / 7.1) * density))
}

/** The effective layout of one note: the stored one, or a derived preview. */
export function layoutOf(note: Note, index: number): NoteLayout {
  return note.layout ?? previewLayout(note, index)
}

/**
 * Derived position for a note the user never placed.
 *
 * Index-based so two never-placed notes cannot collide, hash-jittered so the
 * result still looks scattered rather than gridded.
 */
export function previewLayout(note: Note, index: number): NoteLayout {
  const column = index % PREVIEW_COLUMNS
  const row = Math.floor(index / PREVIEW_COLUMNS)
  const width = previewWidth(note.id)
  return clampLayout({
    x: column * PREVIEW_CELL_W + unit(`${note.id}:px`) * 42,
    y: row * PREVIEW_CELL_H + unit(`${note.id}:py`) * 34,
    rotate: (unit(`${note.id}:pr`) - 0.5) * 2 * PREVIEW_TILT,
    width,
  })
}

/**
 * The axis-aligned bounding box of a rotated card.
 *
 * A tidied card is tilted up to {@link TIDY_TILT} degrees, which widens its
 * footprint by `h * sin(t)`. Packing by the unrotated width therefore let
 * neighbouring cards clip each other's corners, so the packer advances by the
 * rotated box and the gap covers the rest.
 */
export function rotatedExtent(width: number, height: number, rotate: number): { width: number; height: number } {
  const radians = (Math.abs(rotate) * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { width: width * cos + height * sin, height: height * cos + width * sin }
}

/**
 * Deterministic tidy arrangement for the whole wall.
 *
 * Shelf packing: cards flow left to right with a hash jitter and a small tilt,
 * wrapping to a new shelf when the row is full. The shelf width adapts to the
 * wall: a large wall gets wider shelves so the arrangement stays roughly square
 * instead of growing into a single column kilometres tall. The output is shifted
 * so the top-left card starts near the origin, which keeps the canvas' scroll
 * extent predictable instead of starting inside negative space.
 *
 * Returns a map from note id to its new layout, for every note that needs to
 * move. Notes already at exactly that layout are omitted, so pressing tidy on
 * an already-tidy wall writes nothing.
 */
export function arrangeLayouts(notes: readonly Note[]): Map<string, NoteLayout> {
  const placed = new Map<string, NoteLayout>()
  if (notes.length === 0) return placed

  // Decide each card's rotation and box up front: the shelf width and the
  // advancement both depend on the rotated extent, and clamping has to happen
  // before anything is measured.
  const items = notes.map((note) => {
    const width = note.layout?.width ?? previewWidth(note.id)
    const cardWidth = WIDTH_PX[width]
    const cardHeight = estimateHeight(note, width)
    const rotate = (unit(`${note.id}:ar`) - 0.5) * 2 * TIDY_TILT
    const extent = rotatedExtent(cardWidth, cardHeight, rotate)
    return { note, width, cardWidth, cardHeight, rotate, extent }
  })

  // Grow the shelf so a large wall stays square-ish. The bound is the world
  // coordinate limit: an arrangement that would exceed it is a bug, not
  // something to silently clamp (clamping pins every card to the same edge and
  // produces massive overlap).
  const totalArea = items.reduce((sum, item) => sum + item.extent.width * item.extent.height, 0)
  const targetWidth = Math.max(SHELF_WIDTH, Math.ceil(Math.sqrt(totalArea) * 1.25))
  const shelfWidth = Math.min(targetWidth, LAYOUT_LIMITS.coord)

  let cursorX = 0
  let shelfY = 0
  let shelfHeight = 0
  let minX = 0
  let minY = 0

  for (const item of items) {
    if (cursorX > 0 && cursorX + item.extent.width > shelfWidth) {
      cursorX = 0
      shelfY += shelfHeight + SHELF_GAP_Y
      shelfHeight = 0
    }
    // The jitter is bounded so it can never close the inter-card gap: the gap
    // budget is SHELF_GAP_X plus both cards' rotation expansion, and the jitter
    // spends at most 5px of it.
    const layout = clampLayout({
      x: cursorX + (unit(`${item.note.id}:ax`) - 0.5) * 6,
      y: shelfY + (unit(`${item.note.id}:ay`) - 0.5) * 8,
      rotate: item.rotate,
      width: item.width,
    })
    minX = Math.min(minX, layout.x)
    minY = Math.min(minY, layout.y)
    placed.set(item.note.id, layout)
    cursorX += item.extent.width + SHELF_GAP_X
    shelfHeight = Math.max(shelfHeight, item.extent.height)
  }

  if (minX === 0 && minY === 0) return placed
  for (const [id, layout] of placed) {
    placed.set(id, clampLayout({ ...layout, x: layout.x - minX + SHELF_GAP_X, y: layout.y - minY + SHELF_GAP_Y }))
  }
  return placed
}

/** Normalize a submitted width preset, defaulting to the middle size. */
export function normalizeWidth(raw: unknown): NoteWidth {
  const value = String(raw ?? '')
  const match = WIDTHS.find((width) => width === value)
  return match ?? 'md'
}
