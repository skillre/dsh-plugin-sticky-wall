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
import { type CentreReserve, type Note, type NoteLayout, type NoteWidth } from './types.js';
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
 * Whether a footprint stays out of a clear rectangle.
 *
 * The tidy pass keeps the wall's middle clear for the centrepiece, and "clear"
 * has to mean the card's EDGE: measuring from the card's centre let a wide card
 * reach over the capture field by half its own width. A rectangle rather than a
 * radius is the honest shape, because the centrepiece is a wide, short stack —
 * a circle either wasted a tall column of paper above and below it or let wide
 * cards in from the sides.
 */
export declare function intersectsReserve(box: Box, reserve?: CentreReserve): boolean;
/** One axis-aligned footprint on the wall, in world pixels. */
export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
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
export declare function arrangeLayouts(notes: readonly Note[], options?: {
    centreReserve?: CentreReserve | undefined;
}): Map<string, NoteLayout>;
/** Normalize a submitted width preset, defaulting to the middle size. */
export declare function normalizeWidth(raw: unknown): NoteWidth;
/**
 * Clamp a reserve into something the packer can actually honour.
 *
 * The Client sends a zoom-corrected reserve, so it can arrive as a huge number
 * (a deeply zoomed-out wall) or as garbage. Both extremes are refused here: a
 * non-finite or negative half-extent becomes zero, and the whole reserve is
 * capped well inside the world bounds so the packer can never be asked to keep
 * a middle clear that leaves no paper for the cards.
 */
export declare function normalizeReserve(raw: CentreReserve): CentreReserve;
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
export declare function findFreeLayout(note: Note, existing: readonly Note[], options?: {
    centreReserve?: CentreReserve | undefined;
}): NoteLayout;
/**
 * The footprint one note occupies on the wall, as an axis-aligned box.
 *
 * Exposed because the Client needs it for two things the packer already knows:
 * testing whether a card is inside the current viewport, and drawing the reserve
 * it must not cover.
 */
export declare function noteBox(note: Note, index: number): Box;
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
export declare function escapesFromReserve(note: Note, layout: NoteLayout, reserve?: CentreReserve): NoteLayout[];
export declare function pushOutOfReserve(note: Note, layout: NoteLayout, reserve?: CentreReserve): NoteLayout;
export declare function footprintOf(note: Note, layout: NoteLayout): Box;
