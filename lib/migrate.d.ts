/**
 * One-time migration from the 0.7.x storage domain to real `.md` files.
 *
 * The old build kept a wall in a JSON storage domain. 0.8.0 stores one file per
 * note instead, so an existing user's wall has to be carried across exactly once,
 * without losing a note and without ever leaving a half-migrated directory that
 * the next start would mistake for a finished one.
 *
 * The whole design follows from one requirement: **the notes directory must
 * never be observable in a partial state.** So the notes are written into a
 * sibling staging directory and published with a single `rename`, which is
 * atomic within one parent directory. A crash before the rename leaves the legacy
 * wall untouched and the staging directory removable; a crash after it leaves a
 * complete wall that the marker then declares migrated.
 *
 * Nothing here is on the hot path, and nothing here runs when the directory
 * already holds notes: a user who has been on 0.8.0 for months must not have a
 * stale legacy domain re-imported over edits they have made since.
 */
import { type Note } from './types.js';
/** What one migration attempt did, and why it did nothing when it did nothing. */
export interface MigrateResult {
    /** True only when this call published the notes directory. */
    migrated: boolean;
    /**
     * Stable outcome: `migrated`, `already-present`, `no-legacy`, or `failed`.
     *
     * `already-present` is the normal steady state, not an error — it is what a
     * second start reports after a successful migration.
     */
    reason: string;
    /** Notes carried across, set only when `migrated` is true. */
    count?: number;
    /** Human-readable cause, set only when `reason` is `failed`. */
    error?: string;
}
/** Everything the migration needs; `now` is injectable for a deterministic marker. */
export interface MigrateOptions {
    /** Destination directory, `<DSH_HOME>/sticky-notes`. */
    notesDir: string;
    /** Drains the legacy storage domain; resolves to every note it held. */
    readLegacy: () => Promise<Note[]>;
    /** Clock for the marker's `at` field. */
    now?: (() => Date) | undefined;
    /**
     * Where the legacy records live on disk, when the caller knows.
     *
     * Only used to recover a wall that 0.8.0 left looking empty: that build
     * quarantined every record as `<id>.json.bak.<stamp>` in this directory, so
     * the files are the only remaining copy. Omit it and that recovery cannot run
     * — which is correct for a caller that has no legacy medium at all.
     */
    legacyNotesDir?: string | undefined;
}
/**
 * Move the legacy notes into `notesDir`, or explain why there was nothing to do.
 *
 * Never throws for an expected outcome: a failed migration is reported as
 * `{ migrated: false, reason: 'failed' }` with the notes directory left absent,
 * so the next start retries with the legacy wall still intact.
 */
export declare function migrateNotes(options: MigrateOptions): Promise<MigrateResult>;
