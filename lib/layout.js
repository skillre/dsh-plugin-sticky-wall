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
import { LAYOUT_LIMITS, WIDTHS, WIDTH_PX } from './types.js';
/** Golden angle: the phyllotaxis constant that keeps a spiral from lining up. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Breathing room kept between two tidied cards, in world pixels. */
const TIDY_GAP = 26;
/** Hash-driven radial offset applied to a tidied card, in world pixels. */
const TIDY_JITTER = 5;
/** Maximum rotation the tidy pass adds, in degrees. */
const TIDY_TILT = 3.4;
/** Radial growth per derived (never-placed) note, in world pixels. */
const PREVIEW_STEP = 196;
/** Height assumed for a derived position, so the derived box looks centred. */
const PREVIEW_NOMINAL_HEIGHT = 200;
/** Maximum rotation the preview fallback adds, in degrees. */
const PREVIEW_TILT = 4;
/** Spatial-grid cell; wider than the biggest rotated card plus the gap. */
const GRID_CELL = 430;
/** Candidate spiral positions tried per card before the safety fallback. */
const MAX_CANDIDATES = 4096;
/** Deterministic 32-bit FNV-1a hash; no crypto, identical on both halves. */
function hash(text) {
    let value = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        value ^= text.charCodeAt(index);
        value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value >>> 0;
}
/** Deterministic unit float in `[0, 1)` derived from a string. */
function unit(text) {
    return hash(text) / 0x100000000;
}
/** Round to one decimal so stored layouts stay small and diffable. */
function round(value) {
    return Math.round(value * 10) / 10;
}
/** Clamp one layout into the declared world bounds. */
export function clampLayout(layout) {
    const coord = LAYOUT_LIMITS.coord;
    const tilt = LAYOUT_LIMITS.rotate;
    return {
        x: round(Math.min(coord, Math.max(-coord, Number(layout.x) || 0))),
        y: round(Math.min(coord, Math.max(-coord, Number(layout.y) || 0))),
        rotate: round(Math.min(tilt, Math.max(-tilt, Number(layout.rotate) || 0))),
        width: layout.width,
    };
}
/** True when two layouts describe the same position (rounded comparison). */
export function sameLayout(left, right) {
    if (left === null || right === null)
        return left === right;
    return (round(left.x) === round(right.x) &&
        round(left.y) === round(right.y) &&
        round(left.rotate) === round(right.rotate) &&
        left.width === right.width);
}
/** Pick the width preset a never-placed note gets; weighted toward the middle. */
export function previewWidth(id) {
    const roll = unit(`${id}:w`);
    if (roll < 0.42)
        return 'md';
    if (roll < 0.74)
        return 'sm';
    return 'lg';
}
/** Hard height budget per width preset, in pixels at zoom 1. */
export const MAX_CARD_HEIGHT = Object.freeze({
    sm: 236,
    md: 288,
    lg: 336,
});
/**
 * Count text columns rather than characters.
 *
 * A CJK glyph occupies roughly two columns of a monospace-ish advance, and a
 * wall written in Chinese is the common case for this plugin. Counting code
 * points made every Chinese note look half as tall as it renders, which let the
 * tidy pass pack shelves on top of each other.
 */
function columns(text) {
    let total = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        total += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)) ? 2 : 1;
    }
    return total;
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
export function estimateHeight(note, width) {
    const columnsPerLine = columnsPerLineFor(width);
    let lines = 0;
    for (const paragraph of note.body.split('\n')) {
        if (paragraph.trim() === '') {
            lines += 0.4;
            continue;
        }
        lines += Math.max(1, Math.ceil(columns(paragraph.replace(/^[#>*\-+\d. ]+/u, '')) / columnsPerLine));
    }
    // The title wraps like any other text, and it is capped at LIMITS.title (120)
    // characters — which is a dozen lines at the small preset, not the flat 1.4
    // this used to charge. Under-counting it was a real overlap bug: a 120-char
    // CJK title estimated at 104px while rendering at ~244px, below the CSS cap,
    // so the cap could not mask it.
    if (note.title !== '') {
        // The title is one weight step heavier and has no paragraph spacing, so it
        // fits slightly fewer columns than the body at the same width.
        const titleColumns = columnsPerLineFor(width, 0.92);
        lines += Math.max(1, Math.ceil(columns(note.title) / titleColumns));
    }
    // Tag pills wrap, and each pill costs its label plus padding and gap.
    if (note.tags.length > 0) {
        let pillColumns = 0;
        for (const tag of note.tags)
            pillColumns += columns(tag) + 4;
        lines += Math.max(1, Math.ceil(pillColumns / columnsPerLine));
    }
    const clamped = Math.min(16, Math.max(2, lines));
    const estimated = Math.round(58 + clamped * 19);
    return Math.min(estimated, MAX_CARD_HEIGHT[width]);
}
/** Columns of text that fit on one line of a card at the given width. */
function columnsPerLineFor(width, density = 1) {
    // 7.1px per column at the card's 13px type size, minus the horizontal padding.
    return Math.max(8, Math.floor(((WIDTH_PX[width] - 26) / 7.1) * density));
}
/** The effective layout of one note: the stored one, or a derived preview. */
export function layoutOf(note, index) {
    return note.layout ?? previewLayout(note, index);
}
/**
 * Derived position for a note the user never placed.
 *
 * Index-based so two never-placed notes cannot collide, golden-angle spiralled
 * so the result reads as a wall scattered around the middle rather than a grid.
 * The height used for centring is a nominal constant, not the real estimate:
 * a derived position must not move when the user edits the note's text.
 */
export function previewLayout(note, index) {
    const width = previewWidth(note.id);
    const radius = PREVIEW_STEP * Math.sqrt(Math.max(0, index));
    const theta = index * GOLDEN_ANGLE + (unit(`${note.id}:pa`) - 0.5) * 0.55;
    return clampLayout({
        x: Math.cos(theta) * radius - WIDTH_PX[width] / 2,
        y: Math.sin(theta) * radius - PREVIEW_NOMINAL_HEIGHT / 2,
        rotate: (unit(`${note.id}:pr`) - 0.5) * 2 * PREVIEW_TILT,
        width,
    });
}
/**
 * The axis-aligned bounding box of a rotated card.
 *
 * A tidied card is tilted up to {@link TIDY_TILT} degrees, which widens its
 * footprint by `h * sin(t)`. Packing by the unrotated width therefore let
 * neighbouring cards clip each other's corners, so the packer advances by the
 * rotated box and the gap covers the rest.
 */
export function rotatedExtent(width, height, rotate) {
    const radians = (Math.abs(rotate) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return { width: width * cos + height * sin, height: height * cos + width * sin };
}
/** Cell coordinate of one world value. */
function cellOf(value) {
    return Math.floor(value / GRID_CELL);
}
/**
 * Whether `box` (plus the inter-card gap) hits anything already placed.
 *
 * The gap is applied on both sides, so a candidate exactly `TIDY_GAP` away from
 * a placed card still fits; that is the contract the packing test asserts.
 */
function collides(box, grid) {
    for (let cellX = cellOf(box.x - TIDY_GAP); cellX <= cellOf(box.x + box.width + TIDY_GAP); cellX += 1) {
        for (let cellY = cellOf(box.y - TIDY_GAP); cellY <= cellOf(box.y + box.height + TIDY_GAP); cellY += 1) {
            const bucket = grid.get(`${cellX}:${cellY}`);
            if (bucket === undefined)
                continue;
            for (const other of bucket) {
                if (box.x < other.x + other.width + TIDY_GAP &&
                    other.x < box.x + box.width + TIDY_GAP &&
                    box.y < other.y + other.height + TIDY_GAP &&
                    other.y < box.y + box.height + TIDY_GAP) {
                    return true;
                }
            }
        }
    }
    return false;
}
/** Register one accepted footprint in every cell it touches. */
function remember(box, grid) {
    for (let cellX = cellOf(box.x); cellX <= cellOf(box.x + box.width); cellX += 1) {
        for (let cellY = cellOf(box.y); cellY <= cellOf(box.y + box.height); cellY += 1) {
            const key = `${cellX}:${cellY}`;
            const bucket = grid.get(key);
            if (bucket === undefined)
                grid.set(key, [box]);
            else
                bucket.push(box);
        }
    }
}
/**
 * Deterministic tidy arrangement for the whole wall.
 *
 * Phyllotaxis packing around the world origin: candidate positions are visited
 * on a sunflower spiral and the first one that clears every placed card is
 * accepted. The spiral's step is derived from the wall's own average card area,
 * so a wall of small notes packs tightly while a wall of large ones does not
 * overlap, and a big wall grows outward in a disc instead of a column that runs
 * off the coordinate limit.
 *
 * A collision check rather than a shelf estimate is what makes the result
 * trustworthy: the estimate is only a height guess, so any packing that merely
 * trusts it can overlap at the cap. This one cannot.
 *
 * Returns a map from note id to its new layout, for every note that needs to
 * move. Notes already at exactly that layout are omitted by the caller, so
 * pressing tidy on an already-tidy wall writes nothing.
 */
export function arrangeLayouts(notes) {
    const placed = new Map();
    if (notes.length === 0)
        return placed;
    // Decide each card's rotation and footprint up front: the spiral step and the
    // collision test both work on the rotated box.
    const items = notes.map((note) => {
        const width = note.layout?.width ?? previewWidth(note.id);
        const cardWidth = WIDTH_PX[width];
        const cardHeight = estimateHeight(note, width);
        const rotate = (unit(`${note.id}:ar`) - 0.5) * 2 * TIDY_TILT;
        const extent = rotatedExtent(cardWidth, cardHeight, rotate);
        return { note, width, cardWidth, cardHeight, rotate, extent };
    });
    const totalArea = items.reduce((sum, item) => sum + item.extent.width * item.extent.height, 0);
    // A phyllotaxis point at index k owns `PI * step^2` of area, so a step derived
    // from the average card area fills the disc without a hole in the middle or a
    // sparse rim. The 1.06 slack absorbs the gap the packing has to keep.
    const step = Math.max(72, Math.sqrt(totalArea / (Math.PI * items.length)) * 1.06);
    const grid = new Map();
    let cursor = 0;
    let fallbackY = 0;
    for (const item of items) {
        const { extent } = item;
        let box = null;
        for (let attempt = 0; attempt < MAX_CANDIDATES; attempt += 1) {
            const index = cursor + attempt;
            const jitter = (unit(`${item.note.id}:aj`) - 0.5) * 2 * TIDY_JITTER;
            const radius = step * Math.sqrt(index) + jitter;
            const theta = index * GOLDEN_ANGLE;
            const candidate = {
                x: Math.cos(theta) * radius - extent.width / 2,
                y: Math.sin(theta) * radius - extent.height / 2,
                width: extent.width,
                height: extent.height,
            };
            if (!collides(candidate, grid)) {
                box = candidate;
                cursor = index + 1;
                break;
            }
        }
        if (box === null) {
            // Unreachable for a wall inside the note cap; the fallback exists so the
            // function still returns a placement for every note instead of throwing.
            fallbackY += extent.height + TIDY_GAP;
            box = { x: -extent.width / 2, y: fallbackY, width: extent.width, height: extent.height };
        }
        remember(box, grid);
        // The rotated footprint is centred on the card, so the card's own top-left
        // is the footprint centre minus the UNROTATED half size.
        placed.set(item.note.id, clampLayout({
            x: box.x + extent.width / 2 - item.cardWidth / 2,
            y: box.y + extent.height / 2 - item.cardHeight / 2,
            rotate: item.rotate,
            width: item.width,
        }));
    }
    // Re-centre the finished disc on its own centre of mass.
    //
    // The spiral is centred on the origin, but the first cards sit near it and the
    // rest surround them unevenly, so the centroid of the PLACED cards is a few
    // dozen pixels off. The camera frames the centroid, so leaving the offset in
    // means the wall never looks quite centred after a tidy. A uniform translation
    // cannot change any of the collision guarantees above.
    let sumX = 0;
    let sumY = 0;
    for (const [id, layout] of placed) {
        const note = notes.find((candidate) => candidate.id === id);
        const width = layout.width;
        const height = note === undefined ? 0 : estimateHeight(note, width);
        sumX += layout.x + WIDTH_PX[width] / 2;
        sumY += layout.y + height / 2;
    }
    const shiftX = sumX / placed.size;
    const shiftY = sumY / placed.size;
    if (Math.abs(shiftX) >= 0.05 || Math.abs(shiftY) >= 0.05) {
        for (const [id, layout] of placed) {
            placed.set(id, clampLayout({ ...layout, x: layout.x - shiftX, y: layout.y - shiftY }));
        }
    }
    return placed;
}
/** Normalize a submitted width preset, defaulting to the middle size. */
export function normalizeWidth(raw) {
    const value = String(raw ?? '');
    const match = WIDTHS.find((width) => width === value);
    return match ?? 'md';
}
