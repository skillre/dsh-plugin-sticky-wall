/**
 * Free-canvas geometry shared by the Host and the Client halves.
 *
 * The wall is a canvas, not a grid: every card owns a world position, a
 * rotation and a width preset. Two operations produce those numbers:
 *
 * - {@link arrangeLayouts} is the Host-side "tidy" pass. It packs the wall into
 *   a phyllotaxis (sunflower) disc **centred on the world origin**, so the wall
 *   has a middle instead of a top-left corner: the Client opens looking at that
 *   middle, and a tidied wall reads as one composition rather than a list that
 *   happens to wrap. It is deterministic — the same notes always produce the
 *   same wall — and it is collision-checked rather than estimated, so two cards
 *   can never overlap even at the height cap.
 * - {@link previewLayout} is the Client-side fallback for a note that was never
 *   placed (a wall written before the canvas existed, or a note created by the
 *   agent tool). It is the same spiral without the collision check: O(1) per
 *   note, index-stable, and centred, so the first render is already a scattered
 *   wall around the middle instead of one tall stack.
 *
 * Both halves import this module, so the geometry never drifts between the
 * value the Host persists and the value the Client previews.
 */

import {
  CENTRE_RESERVE,
  LAYOUT_LIMITS,
  WIDTHS,
  WIDTH_PX,
  type CentreReserve,
  type Note,
  type NoteLayout,
  type NoteWidth,
} from './types.js'

/** Golden angle: the phyllotaxis constant that keeps a spiral from lining up. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/** Breathing room kept between two tidied cards, in world pixels. */
const TIDY_GAP = 26
/** Hash-driven radial offset applied to a tidied card, in world pixels. */
const TIDY_JITTER = 5
/** Maximum rotation the tidy pass adds, in degrees. */
const TIDY_TILT = 3.4
/** Radial growth per derived (never-placed) note, in world pixels. */
const PREVIEW_STEP = 196
/** Height assumed for a derived position, so the derived box looks centred. */
const PREVIEW_NOMINAL_HEIGHT = 200
/** Clearance the free-spot search keeps between a new card and its neighbours. */
const SPOT_GAP = 24
/** Candidate positions the free-spot search tries before falling back. */
const MAX_SPOTS = 2048
/**
 * How strongly an outer ring prefers horizontal slots, in world pixels of
 * clearance. A wall reads better in a wide window when its outer cards sit left
 * and right, and this is small enough that a genuinely freer slot still wins.
 */
const HORIZON_BIAS = 140

/** Maximum rotation the preview fallback adds, in degrees. */
const PREVIEW_TILT = 4
/** Spatial-grid cell; wider than the biggest rotated card plus the gap. */
const GRID_CELL = 430
/** Candidate spiral positions tried per card before the safety fallback. */
const MAX_CANDIDATES = 4096

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
 * Index-based so two never-placed notes cannot collide, golden-angle spiralled
 * so the result reads as a wall scattered around the middle rather than a grid.
 * The height used for centring is a nominal constant, not the real estimate:
 * a derived position must not move when the user edits the note's text.
 */
export function previewLayout(note: Note, index: number): NoteLayout {
  const width = previewWidth(note.id)
  // The derived wall leaves the same clear middle as the tidy pass: the centre
  // is the wall's centrepiece, not another place for a card. The step out is
  // derived from the reserve's own half-diagonal so the first derived card
  // lands outside the rectangle at any reserve size.
  const reserve = CENTRE_RESERVE
  // The reserve's half-diagonal is how far the RECTANGLE's corner is from the
  // middle; the card's own half-diagonal is how far the CARD reaches back inward
  // from its centre. Adding both is what guarantees the derived box cannot clip
  // a corner of the reserved band.
  const startRadius = Math.hypot(reserve.halfWidth, reserve.halfHeight) +
    Math.hypot(WIDTH_PX[width], PREVIEW_NOMINAL_HEIGHT) / 2
  const radius = PREVIEW_STEP * Math.sqrt(Math.max(0, index) + (startRadius / PREVIEW_STEP) ** 2)
  const theta = index * GOLDEN_ANGLE + (unit(`${note.id}:pa`) - 0.5) * 0.55
  return clampLayout({
    x: Math.cos(theta) * radius - WIDTH_PX[width] / 2,
    y: Math.sin(theta) * radius - PREVIEW_NOMINAL_HEIGHT / 2,
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
 * Whether a footprint stays out of a clear rectangle.
 *
 * The tidy pass keeps the wall's middle clear for the centrepiece, and "clear"
 * has to mean the card's EDGE: measuring from the card's centre let a wide card
 * reach over the capture field by half its own width. A rectangle rather than a
 * radius is the honest shape, because the centrepiece is a wide, short stack —
 * a circle either wasted a tall column of paper above and below it or let wide
 * cards in from the sides.
 */
export function intersectsReserve(box: Box, reserve: CentreReserve = CENTRE_RESERVE): boolean {
  const clear = clearsReserve(box, reserve)
  return !clear
}

/**
 * Tolerance for the reserve test, in world pixels.
 *
 * Positions are rounded to one decimal for storage, so a card packed exactly on
 * the boundary comes back a hundredth of a pixel inside it. Without a tolerance
 * that rounding reads as a violation — and worse, `pushOutOfReserve` would then
 * "correct" a card that was already in the right place. A twentieth of a pixel is
 * far below anything visible and well above the rounding error.
 */
const RESERVE_EPSILON = 0.05

function clearsReserve(box: Box, reserve: CentreReserve): boolean {
  return !(
    box.x < reserve.halfWidth - RESERVE_EPSILON &&
    box.x + box.width > -reserve.halfWidth + RESERVE_EPSILON &&
    box.y < reserve.halfHeight - RESERVE_EPSILON &&
    box.y + box.height > -reserve.halfHeight + RESERVE_EPSILON
  )
}

/** One axis-aligned footprint on the wall, in world pixels. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Cell coordinate of one world value. */
function cellOf(value: number): number {
  return Math.floor(value / GRID_CELL)
}

/**
 * Whether `box` (plus the inter-card gap) hits anything already placed.
 *
 * The gap is applied on both sides, so a candidate exactly `TIDY_GAP` away from
 * a placed card still fits; that is the contract the packing test asserts.
 */
function collides(box: Box, grid: Map<string, Box[]>): boolean {
  for (let cellX = cellOf(box.x - TIDY_GAP); cellX <= cellOf(box.x + box.width + TIDY_GAP); cellX += 1) {
    for (let cellY = cellOf(box.y - TIDY_GAP); cellY <= cellOf(box.y + box.height + TIDY_GAP); cellY += 1) {
      const bucket = grid.get(`${cellX}:${cellY}`)
      if (bucket === undefined) continue
      for (const other of bucket) {
        if (
          box.x < other.x + other.width + TIDY_GAP &&
          other.x < box.x + box.width + TIDY_GAP &&
          box.y < other.y + other.height + TIDY_GAP &&
          other.y < box.y + box.height + TIDY_GAP
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Distance from `box` to the nearest placed card, for tie-breaking between two
 * candidates that both pass the collision test. Returns a large number when
 * nothing is nearby.
 */
function nearestGap(box: Box, grid: Map<string, Box[]>): number {
  let nearest = Number.POSITIVE_INFINITY
  for (let cellX = cellOf(box.x - GRID_CELL); cellX <= cellOf(box.x + box.width + GRID_CELL); cellX += 1) {
    for (let cellY = cellOf(box.y - GRID_CELL); cellY <= cellOf(box.y + box.height + GRID_CELL); cellY += 1) {
      const bucket = grid.get(`${cellX}:${cellY}`)
      if (bucket === undefined) continue
      for (const other of bucket) {
        const gapX = Math.max(other.x - (box.x + box.width), box.x - (other.x + other.width), 0)
        const gapY = Math.max(other.y - (box.y + box.height), box.y - (other.y + other.height), 0)
        nearest = Math.min(nearest, Math.hypot(gapX, gapY))
      }
    }
  }
  return nearest
}

/** Register one accepted footprint in every cell it touches. */
function remember(box: Box, grid: Map<string, Box[]>): void {
  for (let cellX = cellOf(box.x); cellX <= cellOf(box.x + box.width); cellX += 1) {
    for (let cellY = cellOf(box.y); cellY <= cellOf(box.y + box.height); cellY += 1) {
      const key = `${cellX}:${cellY}`
      const bucket = grid.get(key)
      if (bucket === undefined) grid.set(key, [box])
      else bucket.push(box)
    }
  }
}

/**
 * Deterministic tidy arrangement for the whole wall.
 *
 * The wall is packed into CONCENTRIC RINGS around the world origin, outside the
 * rectangle the centrepiece reserves. This replaced a phyllotaxis first-fit
 * spiral, and the reason is measurable rather than aesthetic: a sunflower spiral
 * has to keep every candidate clear of a card's full bounding circle, so it
 * saturates at roughly a quarter of the available area and the only way to place
 * the next card is to walk further out. A fourteen-card wall therefore spread
 * over ~2700px of paper while its cards covered ~430,000px² — a sparse scatter,
 * not a wall. Ring packing instead computes how many cards fit on each circle
 * (`2πR / pitch`) and fills that circle evenly, so the same fourteen cards fit
 * within ~1200px and the result reads as a ring around the middle.
 *
 * Cards are sorted largest-first within the ring they land on, which is the
 * classic first-fit-decreasing heuristic: big cards claim the inner ring where
 * there is less room to waste, and small cards take up the slack outside.
 *
 * A collision check still runs on every candidate rather than trusting the
 * height estimate, because the estimate is a line count and a code block's
 * padding is not something a line count can see. If a candidate does not fit the
 * check pushes to the next ring — the packer never produces an overlap.
 *
 * Returns a map from note id to its new layout, for every note that needs to
 * move. Notes already at exactly that layout are omitted by the caller, so
 * pressing tidy on an already-tidy wall writes nothing.
 */
export function arrangeLayouts(notes: readonly Note[], options: { centreReserve?: CentreReserve | undefined } = {}): Map<string, NoteLayout> {
  const placed = new Map<string, NoteLayout>()
  if (notes.length === 0) return placed

  // Decide each card's rotation and footprint up front: the ring pitch and the
  // collision test both work on the rotated box.
  const items = notes.map((note) => {
    const width = note.layout?.width ?? previewWidth(note.id)
    const cardWidth = WIDTH_PX[width]
    const cardHeight = estimateHeight(note, width)
    const rotate = (unit(`${note.id}:ar`) - 0.5) * 2 * TIDY_TILT
    const extent = rotatedExtent(cardWidth, cardHeight, rotate)
    return { note, width, cardWidth, cardHeight, rotate, extent }
  })

  const reserve = normalizeReserve(options.centreReserve ?? CENTRE_RESERVE)

  // The first ring's radius is the distance from the origin to the reserve's
  // corner plus the largest card's half-diagonal: the smallest circle that can
  // hold a card clear of the whole rectangle.
  const reserveCorner = Math.hypot(reserve.halfWidth, reserve.halfHeight)
  const largestHalfDiagonal = Math.max(...items.map((item) => Math.hypot(item.extent.width, item.extent.height) / 2))

  // Largest first: see the first-fit-decreasing note above. Ties break on id so
  // the result stays deterministic across two windows.
  const ordered = [...items].sort((left, right) => {
    const areaLeft = left.extent.width * left.extent.height
    const areaRight = right.extent.width * right.extent.height
    if (areaRight !== areaLeft) return areaRight - areaLeft
    return left.note.id.localeCompare(right.note.id)
  })

  // Plan the rings before placing anything.
  //
  // Filling ring by ring on demand left the last ring a PARTIAL ARC: cards went
  // onto it from angle 0 and stopped, so the wall's centre of mass leaned toward
  // that arc by ~180px and the camera framed a wall whose middle was not its
  // visual middle. Planning the counts first means each ring can spread its own
  // cards over the whole circle, so a partially filled ring is still balanced.
  // Two different spacings, and conflating them was a real capacity bug.
  //
  // Along a circle, cards are separated by their WIDTH (the tangential direction);
  // between circles, by their HEIGHT (the radial direction). The first version
  // pitched both by `max(width, height)`, so a ring was charged its cards' height
  // where only their width mattered — a 14-card wall then fit 11 cards on the
  // inner ring and spilled 3 onto a much wider outer ring, making the wall 2400px
  // tall where 1400 would do.
  const halfDepth = (item: (typeof items)[number]): number => item.extent.height / 2
  const ringPlan: number[] = []
  const ringRadii: number[] = []
  {
    let remaining = ordered.length
    let cursor = 0
    let radius = reserveCorner + largestHalfDiagonal
    while (remaining > 0) {
      const group = ordered.slice(cursor, cursor + remaining)
      // Tangential pitch from the MEAN width of the cards that could land here;
      // the collision check still guards the real geometry.
      const meanWidth = group.reduce((sum, item) => sum + item.extent.width, 0) / group.length + TIDY_GAP
      const capacity = Math.max(1, Math.floor((2 * Math.PI * radius) / meanWidth))
      const take = Math.min(capacity, remaining)
      ringPlan.push(take)
      ringRadii.push(radius)
      // Radial step: the deepest card on this ring plus the deepest on the next.
      //
      // This is the worst case (both rings' deepest cards at the same angle), and
      // it is charged deliberately. Tightening it below the worst case did fit
      // more cards per ring, but `pushOutOfReserve` runs after the final centring
      // shift and can then move a card INTO a neighbour — the shift preserves the
      // reserve, not the inter-card gaps. Charging the honest step keeps the
      // post-shift corrections small enough that they cannot collide.
      const deepest = Math.max(...ordered.slice(cursor, cursor + take).map(halfDepth))
      const nextDeepest = cursor + take < ordered.length ? Math.max(...ordered.slice(cursor + take).map(halfDepth)) : deepest
      radius += deepest + nextDeepest + TIDY_GAP
      remaining -= take
      cursor += take
    }
  }

  const grid = new Map<string, Box[]>()
  // Where the packer currently is: a ring, and the next angle on it to try.
  //
  // The cursor advances ONLY when a card is placed. Advancing it on a collision
  // as well looked equivalent and was not: every rejected candidate burned a
  // slot, so a ring "filled up" before its angles were exhausted and the packer
  // jumped outward on the next attempt — a 300-card wall then ran to radius
  // 25,000 and had 56 cards clamped onto the world edge.
  let ringIndex = 0
  let slotIndex = 0
  let fallbackY = 0

  /**
   * Radius of one ring, in world pixels.
   *
   * A ring beyond the plan is only reached when the collision check rejects
   * every planned slot, so it continues the same outward progression.
   */
  const radiusOf = (index: number): number => {
    const planned = ringRadii[index]
    if (planned !== undefined) return planned
    const last = ringRadii[ringRadii.length - 1] ?? reserveCorner + largestHalfDiagonal
    return last + (index - (ringRadii.length - 1)) * RADIAL_STEP
  }
  /** Angles available on one ring: the plan, or the geometric capacity past it. */
  const slotsOf = (index: number): number =>
    Math.max(1, ringPlan[index] ?? Math.floor((2 * Math.PI * radiusOf(index)) / (largestHalfDiagonal * 2 + TIDY_GAP)))
  /** Radial step used when a ring beyond the plan has to be invented. */
  const RADIAL_STEP = largestHalfDiagonal * 2 + TIDY_GAP

  for (const item of ordered) {
    const { extent } = item
    let box: Box | null = null
    let attempts = 0
    // Walk rings outward from the current one. Each ring is tried at every one of
    // its own angles before the next ring is considered, which is what keeps the
    // wall compact: the first ring with a free slot wins.
    for (let ring = ringIndex; attempts < MAX_CANDIDATES; ring += 1) {
      const radius = radiusOf(ring)
      const slots = slotsOf(ring)
      // A deterministic phase per ring, so one ring's gaps do not line up with
      // the next ring's cards.
      const phase = (unit(`${item.note.id}:ring${ring}`) - 0.5) * (Math.PI / slots)
      // Try every slot on this ring and take the one whose angle is farthest from
      // the cards already placed. Filling slots in index order instead packed the
      // first few cards onto one arc, which left a partially filled outer ring
      // lopsided and the wall's centre of mass ~120px off the origin — visibly
      // off-centre after a tidy. "Farthest from a neighbour" spreads them.
      let best: { box: Box; slot: number; score: number } | null = null
      for (let slot = 0; slot < slots; slot += 1) {
        const theta = phase + (slot / slots) * Math.PI * 2
        // Jitter the radius, never the angle: an angular jitter would slide a card
        // toward its neighbour, while a radial one only opens a small gap.
        const jitter = (unit(`${item.note.id}:aj`) - 0.5) * 2 * TIDY_JITTER
        const candidate: Box = {
          x: Math.cos(theta) * (radius + jitter) - extent.width / 2,
          y: Math.sin(theta) * (radius + jitter) - extent.height / 2,
          width: extent.width,
          height: extent.height,
        }
        attempts += 1
        if (!clearsReserve(candidate, reserve)) continue
        if (collides(candidate, grid)) continue
        // Score = clearance, biased toward the HORIZONTAL axis on outer rings.
        //
        // A wall is viewed in a window that is wider than it is tall, so an outer
        // arc is much cheaper to frame if it sits on the left and right rather than
        // above and below. Without the bias the outer cards landed wherever the
        // slot order put them, which made a two-ring wall ~2100px TALL and 1600
        // wide — the shape the viewport is worst at. The bias is small enough that
        // a genuinely freer slot still wins.
        const clearance = nearestGap(candidate, grid)
        const horizontal = Math.abs(Math.cos(theta))
        const score = clearance + horizontal * (ring === 0 ? 0 : HORIZON_BIAS)
        if (best === null || score > best.score) best = { box: candidate, slot, score }
      }
      if (best !== null) {
        box = best.box
        ringIndex = ring
        slotIndex = best.slot + 1
        break
      }
    }
    if (box === null) {
      // Unreachable for a wall inside the note cap; the fallback exists so the
      // function still returns a placement for every note instead of throwing.
      fallbackY += extent.height + TIDY_GAP
      box = { x: -extent.width / 2, y: reserveCorner + fallbackY, width: extent.width, height: extent.height }
    }
    remember(box, grid)
    // The rotated footprint is centred on the card, so the card's own top-left
    // is the footprint centre minus the UNROTATED half size.
    placed.set(
      item.note.id,
      clampLayout({
        x: box.x + extent.width / 2 - item.cardWidth / 2,
        y: box.y + extent.height / 2 - item.cardHeight / 2,
        rotate: item.rotate,
        width: item.width,
      }),
    )
  }

  // Centre the finished ring on the world origin.
  //
  // This is not cosmetic — it is what makes the reserved middle correct. The
  // centrepiece is a SCREEN-space block at the viewport's middle, and the camera
  // frames the wall's BOUNDING BOX centre at that same middle. So the world
  // rectangle the packer keeps clear is only under the field if the wall's box is
  // centred on the origin. Leave the offset in and a tidy wall's capture field
  // drifts off its own reserve by however far the box was off.
  //
  // Measured on the bounding box (what the camera frames), not the centroid, and
  // on the ROTATED footprint (what the packer placed).
  const boxes = [...placed].map(([id, layout]) => {
    const note = notes.find((candidate) => candidate.id === id)
    const width = WIDTH_PX[layout.width]
    const height = note === undefined ? 0 : estimateHeight(note, layout.width)
    const extent = rotatedExtent(width, height, layout.rotate)
    const centreX = layout.x + width / 2
    const centreY = layout.y + height / 2
    return {
      id,
      note,
      layout,
      extent,
      box: { x: centreX - extent.width / 2, y: centreY - extent.height / 2, width: extent.width, height: extent.height },
    }
  })
  const minX = Math.min(...boxes.map((entry) => entry.box.x))
  const maxX = Math.max(...boxes.map((entry) => entry.box.x + entry.box.width))
  const minY = Math.min(...boxes.map((entry) => entry.box.y))
  const maxY = Math.max(...boxes.map((entry) => entry.box.y + entry.box.height))
  const shiftX = (minX + maxX) / 2
  const shiftY = (minY + maxY) / 2

  // Apply the FULL shift, then push any card the shift nudged into the reserve
  // back out of it.
  //
  // A partial shift (the previous bisection) left the wall's box off the origin,
  // and that is not a cosmetic problem: the centrepiece is a screen-space block at
  // the viewport's middle and the camera frames the box centre, so a box off the
  // origin puts the field off its own reserved rectangle — a card then legitimately
  // sits behind the capture field while every world-space check says it is clear.
  // Keeping the box ON the origin is what makes the reserve and the field the same
  // thing.
  if (Math.abs(shiftX) >= 0.05 || Math.abs(shiftY) >= 0.05) {
    for (const [id, layout] of placed) {
      placed.set(id, clampLayout({ ...layout, x: layout.x - shiftX, y: layout.y - shiftY }))
    }
    // A card packed just outside the reserve moves INTO it when the wall slides
    // toward that side. Repair those cards properly rather than nudging them.
    //
    // Two earlier attempts were wrong in instructive ways. Pushing along the
    // nearest axis ignored the neighbours and could land a card on top of one.
    // Collision-checking that push was better, but when no escape was clear it
    // left the card where it was — a reserve violation, which is the invariant the
    // whole design exists to keep.
    //
    // So the repair reuses `findFreeLayout`: it already searches outward from the
    // reserve for a spot that clears both the rectangle and every placed card, and
    // it is deterministic. Violating cards are relocated one at a time against the
    // set of cards that are already settled.
    const violators = [...placed].filter(([id, layout]) => {
      const note = notes.find((candidate) => candidate.id === id)
      return note !== undefined && !clearsReserve(footprintOf(note, layout), reserve)
    })
    if (violators.length > 0) {
      const settled = new Map(placed)
      for (const [id] of violators) settled.delete(id)
      for (const [id, layout] of violators) {
        const note = notes.find((candidate) => candidate.id === id)
        if (note === undefined) continue
        // `findFreeLayout` needs the OTHER notes; the candidate note's own width is
        // preserved so a card never changes size just because it had to move.
        const others: Note[] = []
        for (const [otherId, otherLayout] of settled) {
          const other = notes.find((candidate) => candidate.id === otherId)
          if (other !== undefined) others.push({ ...other, layout: otherLayout })
        }
        const relocated = findFreeLayout({ ...note, layout }, others, { centreReserve: reserve })
        // Keep the width the card already had: `findFreeLayout` honours a submitted
        // layout's width, and the layout passed in carries it.
        settled.set(id, relocated)
        placed.set(id, relocated)
      }
    }
  }

  return placed
}

/** Normalize a submitted width preset, defaulting to the middle size. */
export function normalizeWidth(raw: unknown): NoteWidth {
  const value = String(raw ?? '')
  const match = WIDTHS.find((width) => width === value)
  return match ?? 'md'
}

/**
 * Clamp a reserve into something the packer can actually honour.
 *
 * The Client sends a zoom-corrected reserve, so it can arrive as a huge number
 * (a deeply zoomed-out wall) or as garbage. Both extremes are refused here: a
 * non-finite or negative half-extent becomes zero, and the whole reserve is
 * capped well inside the world bounds so the packer can never be asked to keep
 * a middle clear that leaves no paper for the cards.
 */
export function normalizeReserve(raw: CentreReserve): CentreReserve {
  const cap = LAYOUT_LIMITS.coord / 4
  const clampHalf = (value: unknown): number => {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return 0
    return Math.min(cap, number)
  }
  return { halfWidth: clampHalf(raw?.halfWidth), halfHeight: clampHalf(raw?.halfHeight) }
}

/**
 * The nearest free spot for one new card, in world coordinates.
 *
 * Creating a note used to leave its placement to the Host, which stored `null`
 * and let the Client derive a position from the note's index — and that derived
 * position is a spiral that grows outward, so the tenth note could land a
 * screen and a half away from where the user was looking. The card existed, but
 * the user could not see it, which reads exactly like the capture silently
 * failing.
 *
 * This searches outward from the middle instead: the spiral is walked from just
 * outside the centrepiece's reserve, and the first candidate that clears every
 * existing card (plus a gap) and stays out of the reserve is the answer. The
 * result is therefore the gap nearest the centre of the wall, which is both
 * where the user is looking and where the wall has room.
 *
 * Deterministic for the same inputs, so two windows creating at once cannot
 * disagree about the free spot for the same wall.
 */
export function findFreeLayout(
  note: Note,
  existing: readonly Note[],
  options: { centreReserve?: CentreReserve | undefined } = {},
): NoteLayout {
  const width = note.layout?.width ?? previewWidth(note.id)
  const cardWidth = WIDTH_PX[width]
  const cardHeight = estimateHeight(note, width)
  const rotate = (unit(`${note.id}:ar`) - 0.5) * 2 * TIDY_TILT
  const extent = rotatedExtent(cardWidth, cardHeight, rotate)
  const reserve = normalizeReserve(options.centreReserve ?? CENTRE_RESERVE)

  const grid = new Map<string, Box[]>()
  for (const other of existing) {
    // `layoutOf` with index 0 is enough here: a stored layout is used as-is, and
    // a legacy note's derived position only has to be approximately right for
    // the collision check to keep the new card off it.
    const layout = other.layout ?? previewLayout(other, existing.indexOf(other))
    const otherWidth = WIDTH_PX[layout.width]
    const otherHeight = estimateHeight(other, layout.width)
    const otherExtent = rotatedExtent(otherWidth, otherHeight, layout.rotate)
    remember(
      {
        x: layout.x + otherWidth / 2 - otherExtent.width / 2,
        y: layout.y + otherHeight / 2 - otherExtent.height / 2,
        width: otherExtent.width,
        height: otherExtent.height,
      },
      grid,
    )
  }

  // Start just outside the reserve so the first candidate is the closest legal
  // ring, then walk the same golden-angle spiral the tidy pass uses. A step near
  // the card's own size keeps the search local: the answer is the first gap, not
  // a far-away hole.
  const step = Math.max(64, Math.sqrt(extent.width * extent.height) * 0.92)
  const startRadius = Math.hypot(reserve.halfWidth, reserve.halfHeight)
  const startIndex = (startRadius / step) ** 2
  for (let attempt = 0; attempt < MAX_SPOTS; attempt += 1) {
    const index = startIndex + attempt
    const radius = step * Math.sqrt(index)
    const theta = index * GOLDEN_ANGLE
    const candidate: Box = {
      x: Math.cos(theta) * radius - extent.width / 2,
      y: Math.sin(theta) * radius - extent.height / 2,
      width: extent.width,
      height: extent.height,
    }
    if (!clearsReserve(candidate, reserve)) continue
    if (collides(candidate, grid)) continue
    return clampLayout({
      x: candidate.x + extent.width / 2 - cardWidth / 2,
      y: candidate.y + extent.height / 2 - cardHeight / 2,
      rotate,
      width,
    })
  }
  // A wall this full is already at the note cap, so this is a safety net rather
  // than a real path: place just outside the reserve on the first ring.
  const fallbackRadius = startRadius + Math.max(extent.width, extent.height)
  return clampLayout({
    x: -cardWidth / 2,
    y: -fallbackRadius - cardHeight / 2,
    rotate,
    width,
  })
}

/**
 * The footprint one note occupies on the wall, as an axis-aligned box.
 *
 * Exposed because the Client needs it for two things the packer already knows:
 * testing whether a card is inside the current viewport, and drawing the reserve
 * it must not cover.
 */
export function noteBox(note: Note, index: number): Box {
  return footprintOf(note, layoutOf(note, index))
}

/**
 * The footprint a note occupies at a GIVEN layout.
 *
 * Split out from {@link noteBox} because the useful question is often about a
 * layout that is not stored yet — a planned tidy position, or a candidate spot
 * for a card that does not exist. `noteBox` answers "where is this note now";
 * this answers "where would it be".
 */
/**
 * Nudge a layout out of the centrepiece's reserved rectangle.
 *
 * The reserve is not only a packing rule: a user can drag a card straight over
 * the quick-capture field, and a card parked there hides the wall's own controls
 * behind itself. This returns the smallest translation that puts the card's
 * footprint clear of the rectangle, which makes the reserve behave like a
 * magnetic edge during a drag rather than a rule that is only enforced on tidy.
 */
/**
 * Every way out of the reserve, shortest first.
 *
 * Exposed separately from {@link pushOutOfReserve} because the shortest escape is
 * not always usable — it can land on a neighbour — so a caller that cares about
 * collisions needs the whole ordered list, not just the first answer.
 */
export function escapesFromReserve(note: Note, layout: NoteLayout, reserve: CentreReserve = CENTRE_RESERVE): NoteLayout[] {
  const box = footprintOf(note, layout)
  const moves = [
    { dx: -reserve.halfWidth - (box.x + box.width), dy: 0 },
    { dx: reserve.halfWidth - box.x, dy: 0 },
    { dx: 0, dy: -reserve.halfHeight - (box.y + box.height) },
    { dx: 0, dy: reserve.halfHeight - box.y },
  ]
  return moves
    .sort((left, right) => (Math.abs(left.dx) + Math.abs(left.dy)) - (Math.abs(right.dx) + Math.abs(right.dy)))
    .map((move) => clampLayout({ ...layout, x: layout.x + move.dx, y: layout.y + move.dy }))
}

export function pushOutOfReserve(note: Note, layout: NoteLayout, reserve: CentreReserve = CENTRE_RESERVE): NoteLayout {
  const box = footprintOf(note, layout)
  if (!intersectsReserve(box, reserve)) return layout
  // Four ways out, one per edge; the shortest wins so the card slides to the
  // nearest side instead of jumping around the rectangle.
  const moves = [
    { dx: -reserve.halfWidth - (box.x + box.width), dy: 0 },
    { dx: reserve.halfWidth - box.x, dy: 0 },
    { dx: 0, dy: -reserve.halfHeight - (box.y + box.height) },
    { dx: 0, dy: reserve.halfHeight - box.y },
  ]
  let best = moves[0]!
  for (const move of moves) {
    if (Math.abs(move.dx) + Math.abs(move.dy) < Math.abs(best.dx) + Math.abs(best.dy)) best = move
  }
  return clampLayout({ ...layout, x: layout.x + best.dx, y: layout.y + best.dy })
}

export function footprintOf(note: Note, layout: NoteLayout): Box {
  const cardWidth = WIDTH_PX[layout.width]
  const cardHeight = estimateHeight(note, layout.width)
  const extent = rotatedExtent(cardWidth, cardHeight, layout.rotate)
  const centreX = layout.x + cardWidth / 2
  const centreY = layout.y + cardHeight / 2
  return { x: centreX - extent.width / 2, y: centreY - extent.height / 2, width: extent.width, height: extent.height }
}
