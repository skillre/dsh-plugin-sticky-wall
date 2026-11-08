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
import { type Note, type NoteLayout, type NoteWidth } from './types.js';
/** Clamp one layout into the declared world bounds. */
export declare function clampLayout(layout: NoteLayout): NoteLayout;
/** True when two layouts describe the same position (rounded comparison). */
export declare function sameLayout(left: NoteLayout | null, right: NoteLayout | null): boolean;
/** Pick the width preset a never-placed note gets; weighted toward the middle. */
export declare function previewWidth(id: string): NoteWidth;
/** Hard height budget per width preset, in pixels at zoom 1. */
export declare const MAX_CARD_HEIGHT: Readonly<Record<NoteWidth, number>>;
/**
 * Estimate a card's rendered height from its content.
 *
 * The tidy pass runs on the Host, which cannot measure text, so it estimates
 * from the column budget of the chosen width. The estimate is deliberately
 * conservative and capped by {@link MAX_CARD_HEIGHT}, and the Client applies
 * that same cap as a CSS max-height: the estimate and the rendered box therefore
 * agree, which is what keeps a tidied wall free of overlapping cards.
 */
export declare function estimateHeight(note: Note, width: NoteWidth): number;
/** The effective layout of one note: the stored one, or a derived preview. */
export declare function layoutOf(note: Note, index: number): NoteLayout;
/**
 * Derived position for a note the user never placed.
 *
 * Index-based so two never-placed notes cannot collide, golden-angle spiralled
 * so the result reads as a wall scattered around the middle rather than a grid.
 * The height used for centring is a nominal constant, not the real estimate:
 * a derived position must not move when the user edits the note's text.
 */
export declare function previewLayout(note: Note, index: number): NoteLayout;
/**
 * The axis-aligned bounding box of a rotated card.
 *
 * A tidied card is tilted up to {@link TIDY_TILT} degrees, which widens its
 * footprint by `h * sin(t)`. Packing by the unrotated width therefore let
 * neighbouring cards clip each other's corners, so the packer advances by the
 * rotated box and the gap covers the rest.
 */
export declare function rotatedExtent(width: number, height: number, rotate: number): {
    width: number;
    height: number;
};
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
export declare function arrangeLayouts(notes: readonly Note[], options?: {
    centreRadius?: number;
}): Map<string, NoteLayout>;
/** Normalize a submitted width preset, defaulting to the middle size. */
export declare function normalizeWidth(raw: unknown): NoteWidth;
