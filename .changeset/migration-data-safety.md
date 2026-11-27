---
"@skillre/dsh-plugin-sticky-wall": patch
---

Fix three data-loss defects in the 0.8.0 recovery path.

All three are silent: nothing throws, nothing is logged, and the user simply
finds notes missing. They only fire on the upgrade path, which is why the editing
fixes did not touch them.

**The recovery no longer deletes the user's own `welcome` note.** `welcome` is a
legal note id that a 0.7.x wall could genuinely own, and one real wall does — the
note there is a work memo, not the seed. The recovery skipped any id whose file
already existed (0.8.0's seed occupied that name) and then unconditionally removed
`welcome.md`, so the note was destroyed by the function whose job is to rescue it.
A file is now replaced or removed only when its text carries the seed's own copy.

**A failed migration is retried again.** The comment promised that a failed
migration leaves the legacy wall untouched and the next start retries, but the
seeding that ran immediately afterwards wrote a `.md` into the directory —
and `isAlreadyPresent` reads any `.md` as "already migrated". One transient read
error therefore hid the user's whole 0.7.x wall permanently. Seeding is now
skipped when the migration failed, so the directory stays empty and the retry runs.

**A wall whose attributes the format normalizes now migrates.** The read-back check
compared the raw legacy note against the parsed file, but the writer normalizes
tags (lowercase, collapse, truncate, cap), the title (collapse, slice) and line
endings while the legacy reader passes them through. Any uppercase tag, ninth tag,
over-long title or `\r\n` body therefore failed verification — deterministically,
so the retry never converged and (with the defect above) the notes stayed
stranded. The comparison now tolerates exactly those documented normalizations.
Real corruption is still caught: a `NaN` coordinate serializes as `x: NaN` and
parses back as `0`, and that still aborts the migration.

**The recovery path could never find its input.** `legacyNotesDirOf` applied
`dirname` twice, so `<DSH_HOME>/sticky-notes` resolved to
`<parent-of-home>/storages/...` instead of `<DSH_HOME>/storages/...`. The lookup
hit ENOENT, the migration reported `already-present`, and every user's quarantined
notes stayed on disk untouched — the whole recovery was dead code in the shipped
configuration. The tests missed it because they build the path by hand and call
`migrateNotes` directly.

Verified against a real 0.8.0 incident: a copy of a live wall with 14 quarantined
records recovers all 14, and `welcome.md` holds the user's memo rather than the
seed. Typecheck and 435 tests pass.
