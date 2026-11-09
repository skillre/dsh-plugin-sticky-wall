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
 * Index-based so two never-placed notes cannot collide, and laid out on a
 * SQUASHED spiral — the same golden-angle walk with its radius stretched along
 * the x axis — so the result reads as a wide cluster around the middle rather
 * than a circle or a grid. The squash matters: a circle leaves the left and
 * right of a wide window empty and the camera then has to zoom out to frame the
 * empty corners, which is the same "everything looks small" failure the tidy
 * pass fixes. The height used for centring is a nominal constant, not the real
 * estimate: a derived position must not move when the user edits the text.
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
