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
 * Index-based so two never-placed notes cannot collide, hash-jittered so the
 * result still looks scattered rather than gridded.
 */
export declare function previewLayout(note: Note, index: number): NoteLayout;
/**
 * Deterministic tidy arrangement for the whole wall.
 *
 * Shelf packing: cards flow left to right with a hash jitter and a small tilt,
 * wrapping to a new shelf when the row is full. The output is shifted so the
 * top-left card starts near the origin, which keeps the canvas' scroll extent
 * predictable instead of starting inside negative space.
 *
 * Returns a map from note id to its new layout, for every note that needs to
 * move. Notes already at exactly that layout are omitted, so pressing tidy on
 * an already-tidy wall writes nothing.
 */
export declare function arrangeLayouts(notes: readonly Note[]): Map<string, NoteLayout>;
/** Normalize a submitted width preset, defaulting to the middle size. */
export declare function normalizeWidth(raw: unknown): NoteWidth;
