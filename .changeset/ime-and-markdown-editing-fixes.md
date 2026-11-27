---
"@skillre/dsh-plugin-sticky-wall": patch
---

Fix Markdown editing after Chinese IME input, and six related editing/data defects.

**The reported bug: Enter after typing Chinese lost the list indent.** The IME
guard's `justEnded` latch was cleared only by a `keyup` on the textarea, which a
candidate committed with the MOUSE never produces. The latch stayed armed and
swallowed every following shortcut — Enter, Tab, Shift+Tab, Escape, Cmd+S and
Cmd+Enter — so the browser inserted a bare newline with no `- ` marker and no
indent, and the list broke into a paragraph. The latch is now one-shot (consumed
by the single keydown it guards) with a task-scoped expiry as the backstop.

**Enter/Tab now follow the document's own indent grid.** Tab always added two
spaces, so a 4-space note nested to 6 — between its own levels — and Shift+Tab
walked 4 → 2 → 0. The step is measured from the document and only widens when the
note is consistently on a 4-grid.

**Saving no longer rewrites the body.** `saveDraft` trimmed it, which ate trailing
blank lines (paragraph breaks) and a leading 4-space indent (a code block), and
because every save resends the whole body, editing only the title rewrote it too.
The store's documented contract is that a body is never trimmed.

**An existing note can be saved empty again.** The Client rejected an empty body
for every save, though `update` deliberately allows clearing a card back to a
title-only note; the editor was left unable to save at all.

**Tags round-trip losslessly.** The field was split on whitespace, so a tag
containing a space (`hello world`, which the store accepts) was torn in two by the
next save. Commas are now the only separator.

**The width chosen while creating a note is applied.** `NoteInput` carries no
width, so the composer's S/M/L buttons were silently ignored on create.

**The editor's markers match the parser's.** Pressing H1 on a `#####` line produced
`# ##### five`, bullet on `1234. item` produced `- 1234. item`, and italic emitted
`_`, which the parser refuses next to a word character (`ab_cd_` stayed literal,
`__` rendered bold). Heading levels, ordered-marker digits and the divider are now
stripped the way the parser reads them, and italic emits `*`.

**Inline rendering is linear again.** A body of unmatched brackets — legal at the
documented 200k limit — took 57 SECONDS to render one card, freezing the sidebar
with no error. A failed closer is now memoised and the link/autolink patterns run
sticky instead of slicing the remainder per candidate: 57,391ms → 463ms.

**Frontmatter cannot silently eat a note.** A file that merely started with a
horizontal rule and held another one further down was read as frontmatter,
discarding everything between them; the next write made it permanent. Such a file
is now kept whole as the body. Unknown keys are unquoted on read, so a quoted value
no longer gains a fresh pair of quotes per save (39 → 110 → 358 bytes over six
saves, on its way past the 4 MB cap where the note disappears).

**An over-limit hand-written body is now editable.** `load()` checked only the file
byte cap, so a body past `LIMITS.body` loaded fine and then rejected every update
carrying it back. It is flagged on the card and may be shortened.
