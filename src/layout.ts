/**
 * Free-canvas geometry shared by the Host and the Client halves.
 *
 * The wall is a canvas, not a grid: every card owns a world position, a
 * rotation and a width preset. Two operations produce those numbers:
 *
 * - {@link arrangeLayouts} is the Host-side "tidy" pass. It packs the wall into
 *   a compact cluster **centred on the world origin**, hugging the rectangle the
 *   centrepiece reserves: the Client opens looking at that middle, and a tidied
 *   wall reads as one composition rather than a list that happens to wrap. It is
 *   deterministic — the same notes always produce the same wall — and it is
 *   collision-checked rather than estimated, so two cards can never overlap even
 *   at the height cap.
 * - {@link previewLayout} is the Client-side fallback for a note that was never
 *   placed (a wall written before the canvas existed, or a note created by the
 *   agent tool). It is a golden-angle spiral without the collision check: O(1)
 *   per note, index-stable, and centred, so the first render is already a
 *   scattered wall around the middle instead of one tall stack.
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
  type ReserveRect,
} from './types.js'

/** Golden angle: the phyllotaxis constant that keeps a spiral from lining up. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/** Breathing room kept between two tidied cards, in world pixels. */
const TIDY_GAP = 26
/** Maximum rotation the tidy pass adds, in degrees. */
const TIDY_TILT = 3.4
/** Radial growth per derived (never-placed) note, in world pixels. */
const PREVIEW_STEP = 196
/** Height assumed for a derived position, so the derived box looks centred. */
const PREVIEW_NOMINAL_HEIGHT = 200
/**
 * Horizontal stretch applied to the derived spiral, matching the reference
 * viewport's aspect. A derived wall is never tidied, so its shape is the only
 * thing keeping it framable at a legible zoom.
 */
const PREVIEW_SQUASH = 1.4
/** Clearance the free-spot search keeps between a new card and its neighbours. */
const SPOT_GAP = 24
/** Candidate positions the free-spot search tries before falling back. */
const MAX_SPOTS = 2048

/**
 * How far each successive contour grows past the reserved rectangle, in world
 * pixels. A contour is only tried when every slot on the previous one is taken,
 * so this is the radial grain of the packing: smaller packs tighter but costs
 * more candidate tests.
 */
const FRAME_STEP = 20
/** Spacing between two candidate slots along one contour, in world pixels. */
const CONTOUR_STEP = 14
/** Contours walked outward before a card gives up and takes the safety spot. */
const MAX_FRAMES = 1024
/** Upper bound on slots tested per contour, so a huge wall stays bounded. */
const MAX_SLOTS = 320
/**
 * The framing the tidy pass packs FOR: the usable canvas of a typical window, in
 * world pixels at zoom 1. A candidate slot is scored by how much this rectangle
 * would have to zoom out to hold the wall, which is the number the user actually
 * feels. The exact window is unknown to the Host, so this is a shape, not a size.
 */
const FRAMING_WIDTH = 1064
const FRAMING_HEIGHT = 664
/** The reference viewport's own aspect; the contour is grown to match it. */
const FRAMING_ASPECT = 1.5

/** Maximum rotation the preview fallback adds, in degrees. */
const PREVIEW_TILT = 4
/** Spatial-grid cell; wider than the biggest rotated card plus the gap. */
const GRID_CELL = 430

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
 * Index-based so two never-placed notes cannot collide, and laid out on a
 * SQUASHED spiral — the same golden-angle walk with its radius stretched along
 * the x axis — so the result reads as a wide cluster around the middle rather
 * than a circle or a grid. The squash matters: a circle leaves the left and
 * right of a wide window empty and the camera then has to zoom out to frame the
 * empty corners, which is the same "everything looks small" failure the tidy
 * pass fixes. The height used for centring is a nominal constant, not the real
 * estimate: a derived position must not move when the user edits the text.
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
    x: Math.cos(theta) * radius * PREVIEW_SQUASH - WIDTH_PX[width] / 2,
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
  return !clearsReserve(box, normalizeReserve(reserve))
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

/**
 * Whether a footprint stays out of the clear rectangle.
 *
 * The rectangle has a POSITION as well as a size. The centrepiece is a
 * screen-space overlay, so the world patch it covers moves as the camera pans
 * and zooms; a reserve that only knew its half-extents therefore described the
 * world origin, and a card captured from a panned wall was placed clear of the
 * wrong place — which is exactly how a fresh card ended up behind the field.
 */
function clearsReserve(box: Box, reserve: ReserveRect): boolean {
  return !(
    box.x < reserve.x + reserve.halfWidth - RESERVE_EPSILON &&
    box.x + box.width > reserve.x - reserve.halfWidth + RESERVE_EPSILON &&
    box.y < reserve.y + reserve.halfHeight - RESERVE_EPSILON &&
    box.y + box.height > reserve.y - reserve.halfHeight + RESERVE_EPSILON
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

/**
 * The point at arc length `distance` around a rectangle's outline, with the
 * outward normal there.
 *
 * This is the contour the tidy pass walks. Unlike a circle, a rectangle's
 * outline stays a card's own half-size away from the reserve in every direction,
 * which is what keeps the innermost cards as close to the middle as their size
 * allows instead of at the rectangle's corner distance all the way round.
 *
 * `halfWidth`/`halfHeight` are the contour's own half-extents, so a contour is
 * just "the reserve grown by one frame".
 */
function contourPoint(halfWidth: number, halfHeight: number, distance: number): { x: number; y: number; nx: number; ny: number } {
  const width = halfWidth * 2
  const height = halfHeight * 2
  const perimeter = 2 * (width + height)
  let along = ((distance % perimeter) + perimeter) % perimeter
  // Clockwise from the top-left corner: top edge, right edge, bottom, left.
  if (along < width) return { x: -halfWidth + along, y: -halfHeight, nx: 0, ny: -1 }
  along -= width
  if (along < height) return { x: halfWidth, y: -halfHeight + along, nx: 1, ny: 0 }
  along -= height
  if (along < width) return { x: halfWidth - along, y: halfHeight, nx: 0, ny: 1 }
  along -= width
  return { x: -halfWidth, y: halfHeight - along, nx: -1, ny: 0 }
}

/**
 * The footprint of a card whose nearest edge sits on a contour point.
 *
 * The reach is half the card's extent MEASURED ALONG THE NORMAL, not half its
 * width: on the top and bottom edges a tilted card reaches out by half its
 * height, and charging it half its width there would let it clip the reserve.
 */
function boxOnContour(
  point: { x: number; y: number; nx: number; ny: number },
  extent: { width: number; height: number },
): Box {
  const reach = (Math.abs(point.nx) * extent.width + Math.abs(point.ny) * extent.height) / 2
  return {
    x: point.x + point.nx * reach - extent.width / 2,
    y: point.y + point.ny * reach - extent.height / 2,
    width: extent.width,
    height: extent.height,
  }
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
 * The wall is packed against a CONTOUR: the reserved rectangle's own outline,
 * walked outward frame by frame. This is the third packer in this file's
 * history and each replacement fixed a measured failure rather than a taste.
 *
 * 1. A phyllotaxis first-fit spiral had to keep every candidate clear of a
 *    card's full bounding circle, so it saturated at roughly a quarter of the
 *    available area and the only way to place the next card was to walk further
 *    out: fourteen cards spread over ~2700px of paper.
 * 2. Concentric RINGS fixed that density but paid for it with distance. A ring
 *    is a circle, and the first ring's radius is the reserve's half-DIAGONAL —
 *    so the innermost cards sit at the rectangle's corner distance in every
 *    direction, including the four directions where the rectangle is only a
 *    card's width away. A fourteen-card wall then filled a 1645x1794 box, which
 *    the camera could only frame at 36%: the cards were individually packed
 *    tightly but the wall as a whole looked small and far away. That is the
 *    complaint this packer answers.
 * 3. A contour hugs the rectangle instead: along the left and right edges a card
 *    sits one card-half-width from the reserve, and along the top and bottom one
 *    card-half-height from it. Every card is therefore as close to the middle as
 *    its own size allows, which is what makes the wall read as one composition.
 *
 * Two further decisions do the rest of the work:
 *
 * - **Score by how well the wall FRAMES, not by how free the slot is.** A
 *   candidate slot is judged by the zoom the whole wall would need in a
 *   reference viewport if the card went there. Filling a slot that widens the
 *   wall's box costs zoom, so the packer prefers slots that keep the box close
 *   to the window's own aspect — which is why the result is a wide, low cluster
 *   instead of a disc that leaves the left and right of the window empty.
 * - **The first frame with room wins.** Walking outward frame by frame and
 *   taking the best-scoring slot on the first frame that has any is what makes
 *   every card land near the middle: an outer frame is only reached when the
 *   inner ones are genuinely full.
 *
 * A collision check still runs on every candidate rather than trusting the
 * height estimate, because the estimate is a line count and a code block's
 * padding is not something a line count can see. The packer never produces an
 * overlap, and the final centring passes repair any card the centring shift
 * nudged into the reserved rectangle.
 *
 * Returns a map from note id to its new layout, for every note that needs to
 * move. Notes already at exactly that layout are omitted by the caller, so
 * pressing tidy on an already-tidy wall writes nothing.
 */
export function arrangeLayouts(notes: readonly Note[], options: { centreReserve?: CentreReserve | undefined } = {}): Map<string, NoteLayout> {
  const placed = new Map<string, NoteLayout>()
  if (notes.length === 0) return placed

  // Decide each card's rotation and footprint up front: the contour offsets and
  // the collision test both work on the rotated box.
  const items = notes.map((note) => {
    const width = note.layout?.width ?? previewWidth(note.id)
    const cardWidth = WIDTH_PX[width]
    const cardHeight = estimateHeight(note, width)
    const rotate = (unit(`${note.id}:ar`) - 0.5) * 2 * TIDY_TILT
    const extent = rotatedExtent(cardWidth, cardHeight, rotate)
    return { note, width, cardWidth, cardHeight, rotate, extent }
  })

  // The contour is anchored on the ORIGIN, deliberately, even when the caller
  // sends a positioned reserve.
  //
  // Tidy ends by centring the finished wall's bounding box on the origin, and the
  // Client then refits the camera so that box fills the viewport — which puts the
  // centrepiece back over the origin. So the origin is where the field is going to
  // be, not where it happens to be at the instant tidy was pressed. Honouring a
  // transient camera position here would pack the wall around a point the refit is
  // about to move away from. The SIZE is still honoured, because that is the part
  // that does not change.
  //
  // `findFreeLayout` is the opposite case: it places one card on the CURRENT view,
  // with no refit to follow, so it orbits the reserve's real position.
  const reserve: ReserveRect = { ...normalizeReserve(options.centreReserve ?? CENTRE_RESERVE), x: 0, y: 0 }

  // Largest first: the classic first-fit-decreasing heuristic. Big cards claim
  // the inner frames where there is less room to waste, and small cards fill the
  // gaps they leave. Ties break on id so the result stays deterministic across
  // two windows.
  const ordered = [...items].sort((left, right) => {
    const areaLeft = left.extent.width * left.extent.height
    const areaRight = right.extent.width * right.extent.height
    if (areaRight !== areaLeft) return areaRight - areaLeft
    return left.note.id.localeCompare(right.note.id)
  })

  const grid = new Map<string, Box[]>()

  // The wall's box so far, extended by each accepted card. The framing score
  // needs it, and it is cheaper to maintain than to recompute per candidate.
  let wall: Box | null = null
  const extendWall = (box: Box): Box =>
    wall === null
      ? { x: box.x, y: box.y, width: box.width, height: box.height }
      : {
          x: Math.min(wall.x, box.x),
          y: Math.min(wall.y, box.y),
          width: Math.max(wall.x + wall.width, box.x + box.width) - Math.min(wall.x, box.x),
          height: Math.max(wall.y + wall.height, box.y + box.height) - Math.min(wall.y, box.y),
        }

  /**
   * The best slot for one card, or null when no contour has room.
   *
   * `soft` is used for the repair passes: a repair may not disturb a card that
   * already sits legally, so it is asked to stay a hair further out, which keeps
   * the rounding of a stored position from reading as a fresh violation.
   */
  const pick = (item: (typeof items)[number], settled: Map<string, Box[]>, soft: CentreReserve, seed: string): Box | null => {
    const { extent } = item
    for (let frame = 0; frame < MAX_FRAMES; frame += 1) {
      const halfWidth = soft.halfWidth + frame * FRAME_STEP
      // Grow the height FASTER than the width until the contour itself is as wide
      // as the framing rectangle. Growing both equally makes the left and right
      // edges (already the reserve's long ones) longer still, so every extra frame
      // adds room for a vertical column and none for a horizontal row: the wall
      // grew into an 1114x966 block that framed at 69% where a window-shaped one
      // frames at 90%. A contour whose own aspect matches the window puts the
      // spare slots on the short edges, which is where they are useful.
      const halfHeight = Math.max(soft.halfHeight, halfWidth / FRAMING_ASPECT)
      const perimeter = 4 * (halfWidth + halfHeight)
      const slots = Math.min(MAX_SLOTS, Math.max(12, Math.round(perimeter / CONTOUR_STEP)))
      // A deterministic phase per frame, so two frames' slots do not line up and
      // the same wall always packs to the same coordinates.
      const phase = unit(`${seed}:f${frame}`) * perimeter
      let best: { box: Box; score: number; shape: number; clearance: number; offset: number } | null = null
      for (let slot = 0; slot < slots; slot += 1) {
        const candidate = boxOnContour(contourPoint(halfWidth, halfHeight, phase + (slot / slots) * perimeter), extent)
        if (!clearsReserve(candidate, reserve)) continue
        if (collides(candidate, settled)) continue
        const next = extendWall(candidate)
        // How much this wall would have to shrink to fit the reference viewport.
        // Higher is better; it is the number the camera will actually apply.
        const score = Math.min(
          1,
          FRAMING_WIDTH / Math.max(1, next.width),
          FRAMING_HEIGHT / Math.max(1, next.height),
        )
        // HOW WINDOW-SHAPED the wall becomes, as a log ratio so being too wide
        // and being too tall are penalised equally. This is the tie-break, and it
        // is what actually produces a wide wall: for the first several cards
        // almost every slot frames at the same zoom, because the wall is still
        // smaller than the viewport either way. Without a shape preference the
        // tie fell to placement noise, the wall grew equally in all four
        // directions, and the result was a tall block that framed at 69% where a
        // wide one frames at 90%.
        const shape = Math.abs(Math.log((next.width + 1) / (next.height + 1) / FRAMING_ASPECT))
        // How far this slot sits from the cards already placed. Even distribution
        // is the point of a wall: a slot that hugs one neighbour leaves a hole
        // elsewhere that the NEXT card then has to reach across.
        const clearance = nearestGap(candidate, settled)
        // Nearest-the-origin last, because that is the middle the camera frames.
        const offset = Math.hypot(next.x + next.width / 2, next.y + next.height / 2)
        const better =
          best === null ||
          score > best.score + 1e-9 ||
          (Math.abs(score - best.score) <= 1e-9 &&
            (shape < best.shape - 1e-9 ||
              (Math.abs(shape - best.shape) <= 1e-9 &&
                (clearance > best.clearance + 1e-9 ||
                  (Math.abs(clearance - best.clearance) <= 1e-9 && offset < best.offset)))))
        if (better) best = { box: candidate, score, shape, clearance, offset }
      }
      // The first frame with ANY free slot wins. Walking further out would find
      // roomier slots, and taking them is exactly how a wall grows into a sparse
      // scatter instead of a composition.
      if (best !== null) return best.box
    }
    return null
  }

  for (const item of ordered) {
    const box = pick(item, grid, reserve, item.note.id) ?? {
      // Unreachable for a wall inside the note cap; the fallback exists so the
      // function still returns a placement for every note instead of throwing.
      x: -item.extent.width / 2,
      y: -9000,
      width: item.extent.width,
      height: item.extent.height,
    }
    remember(box, grid)
    wall = extendWall(box)
    // The rotated footprint is centred on the card, so the card's own top-left
    // is the footprint centre minus the UNROTATED half size.
    placed.set(
      item.note.id,
      clampLayout({
        x: box.x + item.extent.width / 2 - item.cardWidth / 2,
        y: box.y + item.extent.height / 2 - item.cardHeight / 2,
        rotate: item.rotate,
        width: item.width,
      }),
    )
  }

  /**
   * Centre the finished wall on the world origin.
   *
   * This is not cosmetic — it is what makes the reserved middle correct. The
   * centrepiece is a SCREEN-space block at the viewport's middle, and the camera
   * frames the wall's BOUNDING BOX centre at that same middle. So the world
   * rectangle the packer keeps clear is only under the field if the wall's box is
   * centred on the origin. Leave the offset in and a tidy wall's capture field
   * drifts off its own reserve by however far the box was off.
   *
   * It alternates the shift with a repair, because a shift can push a card into
   * the reserve: the repair displaces the wall again, so the shift has to be
   * re-measured. A single pass left a 20-card wall ~56px off centre.
   */
  const footprintOfId = (id: string, layout: NoteLayout): Box => {
    const note = notes.find((candidate) => candidate.id === id)
    if (note === undefined) return { x: layout.x, y: layout.y, width: 0, height: 0 }
    return footprintOf(note, layout)
  }
  const wallBounds = (): Box => {
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const [id, layout] of placed) {
      const box = footprintOfId(id, layout)
      minX = Math.min(minX, box.x)
      minY = Math.min(minY, box.y)
      maxX = Math.max(maxX, box.x + box.width)
      maxY = Math.max(maxY, box.y + box.height)
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }
  /** Repair every card that sits in the reserve, one at a time, against the rest. */
  const repairReserve = (soft: CentreReserve): void => {
    const violators = [...placed].filter(([id, layout]) => !clearsReserve(footprintOfId(id, layout), reserve))
    if (violators.length === 0) return
    const settled = new Map(placed)
    for (const [id] of violators) settled.delete(id)
    const repairGrid = new Map<string, Box[]>()
    for (const [id, layout] of settled) remember(footprintOfId(id, layout), repairGrid)
    for (const [id] of violators) {
      const item = items.find((candidate) => candidate.note.id === id)
      if (item === undefined) continue
      const box = pick(item, repairGrid, soft, `${id}:repair`)
      if (box === null) continue
      remember(box, repairGrid)
      placed.set(
        id,
        clampLayout({
          x: box.x + item.extent.width / 2 - item.cardWidth / 2,
          y: box.y + item.extent.height / 2 - item.cardHeight / 2,
          rotate: item.rotate,
          width: item.width,
        }),
      )
    }
  }
  // Ask the repair to stay a hair clear, so a card packed exactly on the boundary
  // is not re-placed by rounding noise.
  const softReserve = { halfWidth: reserve.halfWidth + 1.5, halfHeight: reserve.halfHeight + 1.5 }
  for (let pass = 0; pass < 6; pass += 1) {
    const box = wallBounds()
    const shiftX = box.x + box.width / 2
    const shiftY = box.y + box.height / 2
    if (Math.abs(shiftX) < 0.5 && Math.abs(shiftY) < 0.5) break
    for (const [id, layout] of placed) {
      placed.set(id, clampLayout({ ...layout, x: layout.x - shiftX, y: layout.y - shiftY }))
    }
    repairReserve(softReserve)
  }
  // The loop above can exit with violators left over: its last repair is itself
  // displaced by the shift it was responding to. Settle them without shifting.
  for (let pass = 0; pass < 24; pass += 1) {
    const before = [...placed].filter(([id, layout]) => !clearsReserve(footprintOfId(id, layout), reserve)).length
    if (before === 0) break
    repairReserve(softReserve)
    const after = [...placed].filter(([id, layout]) => !clearsReserve(footprintOfId(id, layout), reserve)).length
    if (after >= before) break
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
/**
 * Clamp a reserve into something the packer can actually honour.
 *
 * The Client sends a reserve positioned where the centrepiece currently sits in
 * world space, so it can arrive with huge coordinates (a deeply zoomed-out wall)
 * or as garbage. Both extremes are refused here: a non-finite coordinate becomes
 * the origin, and the half-extents are capped well inside the world bounds so the
 * packer can never be asked to keep a middle clear that leaves no paper for the
 * cards.
 *
 * The position is clamped to the world bounds rather than to zero: a panned wall
 * legitimately puts the field far from the origin, and snapping it back to the
 * origin would reintroduce the very bug this position exists to fix.
 */
export function normalizeReserve(raw: CentreReserve): ReserveRect {
  const cap = LAYOUT_LIMITS.coord / 4
  const clampHalf = (value: unknown): number => {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return 0
    return Math.min(cap, number)
  }
  const clampCoord = (value: unknown): number => {
    const number = Number(value)
    if (!Number.isFinite(number)) return 0
    return Math.min(LAYOUT_LIMITS.coord, Math.max(-LAYOUT_LIMITS.coord, number))
  }
  return {
    x: clampCoord(raw?.x ?? 0),
    y: clampCoord(raw?.y ?? 0),
    halfWidth: clampHalf(raw?.halfWidth),
    halfHeight: clampHalf(raw?.halfHeight),
  }
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
 * This searches outward from the field instead: the spiral is walked from just
 * outside the centrepiece's reserve, and the first candidate that clears every
 * existing card (plus a gap) and stays out of the reserve is the answer. The
 * result is therefore the gap nearest the place the user is actually looking at,
 * which is where the wall has room.
 *
 * The spiral orbits the RESERVE, not the world origin. That distinction is the
 * fix for a note appearing behind the capture field: the field is a screen-space
 * overlay, so on a panned wall it covers a patch of world that is nowhere near
 * the origin. Orbiting the origin placed the card beside a point the user could
 * not see, and the reveal then centred that point — with the field drawn on top
 * of it. Orbiting the reserve puts the card next to the field, which is both
 * visible and the only placement that can never be hidden by it.
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
  // a far-away hole. The whole spiral is offset by the reserve's centre, because
  // the field it protects is wherever the camera has put it.
  const step = Math.max(64, Math.sqrt(extent.width * extent.height) * 0.92)
  const startRadius = Math.hypot(reserve.halfWidth, reserve.halfHeight)
  const startIndex = (startRadius / step) ** 2
  for (let attempt = 0; attempt < MAX_SPOTS; attempt += 1) {
    const index = startIndex + attempt
    const radius = step * Math.sqrt(index)
    const theta = index * GOLDEN_ANGLE
    const candidate: Box = {
      x: reserve.x + Math.cos(theta) * radius - extent.width / 2,
      y: reserve.y + Math.sin(theta) * radius - extent.height / 2,
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
    x: reserve.x - cardWidth / 2,
    y: reserve.y + fallbackRadius - cardHeight / 2,
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
  const rect = normalizeReserve(reserve)
  const box = footprintOf(note, layout)
  const moves = [
    { dx: rect.x - rect.halfWidth - (box.x + box.width), dy: 0 },
    { dx: rect.x + rect.halfWidth - box.x, dy: 0 },
    { dx: 0, dy: rect.y - rect.halfHeight - (box.y + box.height) },
    { dx: 0, dy: rect.y + rect.halfHeight - box.y },
  ]
  return moves
    .sort((left, right) => (Math.abs(left.dx) + Math.abs(left.dy)) - (Math.abs(right.dx) + Math.abs(right.dy)))
    .map((move) => clampLayout({ ...layout, x: layout.x + move.dx, y: layout.y + move.dy }))
}

export function pushOutOfReserve(note: Note, layout: NoteLayout, reserve: CentreReserve = CENTRE_RESERVE): NoteLayout {
  const rect = normalizeReserve(reserve)
  const box = footprintOf(note, layout)
  if (clearsReserve(box, rect)) return layout
  // Four ways out, one per edge; the shortest wins so the card slides to the
  // nearest side instead of jumping around the rectangle.
  const moves = [
    { dx: rect.x - rect.halfWidth - (box.x + box.width), dy: 0 },
    { dx: rect.x + rect.halfWidth - box.x, dy: 0 },
    { dx: 0, dy: rect.y - rect.halfHeight - (box.y + box.height) },
    { dx: 0, dy: rect.y + rect.halfHeight - box.y },
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
