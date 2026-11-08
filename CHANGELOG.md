# Changelog

## 0.3.0

### Minor Changes

- Give the wall a centre, and make the canvas feel direct.
  
  The wall used to be laid out from a top-left corner and viewed through a scroll
  container, which is why it opened on empty paper and why the first drag of a
  session moved the whole wall.
  
  - **The wall is a disc around the origin.** "Tidy" now packs a phyllotaxis
    (sunflower) spiral centred on the world origin, with a real collision check
    against every card already placed instead of an estimated shelf. The result is
    deterministic, roughly square at every size (12 / 60 / 300 cards all come out
    within 0.7–1.4 aspect ratio), and cannot overlap even when every card sits at
    its height cap. The finished disc is re-centred on its own centre of mass, so
    the composition is balanced rather than merely origin-anchored.
  - **The camera opens on that middle.** Opening the wall, pressing reset, and
    tidying all frame the wall's centre of mass and pick the zoom that fits the
    whole wall in view (capped at 100%, never below the readable minimum).
  - **The camera is a transform, not a scroll container.** The canvas clips and one
    wrapper carries `translate3d(pan) scale(zoom)`, written imperatively. Panning
    and zooming cost zero React renders and zero layout, and dragging a card can no
    longer move the wall under it — which is exactly what the old padded scroll
    surface did when a card crossed its bounds.
  - **Panning and anchored zoom.** Drag empty paper to pan, scroll to pan, and
    `⌘/Ctrl + wheel` zooms around the pointer: the world point under the cursor
    stays under the cursor (verified to under 2px in the real browser).
  - **The drop is optimistic.** On release the card is written to its final world
    position on the node and in the note list before the Host round-trip, so it no
    longer snaps back to where it started while the write is in flight.
  - **Fewer renders per interaction.** Cards are memoized and note objects are
    reconciled by identity, so a mutation re-renders one card instead of the whole
    wall; the full-size wrapper element per note is gone and the card carries its
    own id.
  - **Clamping follows the width preset**, so a long body ends on a whole line
    instead of being cut mid-glyph by the card's max-height.
  
  Verified in the real DSH Web UI: 31/31 assertions, including a 14-note wall that
  tidies into a centred disc (zero overlaps, aspect ratio 0.94) and is framed at
  54% by the camera.

## 0.2.2

### Patch Changes

- Publish through the reviewed OIDC release workflow.
  
  0.2.1 was bootstrapped by a manual `npm publish`, which created the package so a
  Trusted Publisher could be attached to it. This release is the first one to go
  out through `release.yml` with npm Trusted Publishing, so it carries real
  provenance instead of a bare publish by a maintainer account.
  
  No runtime change: the canvas, the Markdown renderer and the drag behaviour are
  byte-identical to 0.2.1.

## 0.2.1

### Patch Changes

- Make dragging feel direct instead of laggy.
  
  - The canvas card no longer transitions `transform`. Every pointer move writes a
    new transform, and an active transition turned each write into an animation
    target, so the card trailed the pointer by ~160ms and read as rubber-banding.
    Only the drop shadow animates now.
  - The drag flag is a `data-dragging` attribute on the card instead of React
    state, so pressing and releasing no longer re-renders the whole wall.
  - Pointer moves are coalesced into one transform write per animation frame, so a
    high-rate trackpad cannot queue more writes than there are paints.
  - The pointer loop is registered once for the page instead of being torn down and
    re-added on every press and release (and re-registered whenever the note list
    changed mid-drag).
  - The dragged card keeps its rotation and width throughout; the drag no longer
    flattens the tilt and snaps it back on drop.
  - The hover lift now applies only in the grid view. On the canvas it overwrote
    the drag transform, so the card jumped a couple of pixels whenever the pointer
    crossed it.

## 0.2.0

### Minor Changes

- Turn the wall into a free canvas and render Markdown bodies.
  
  - Notes now own a canvas placement (`layout`: x, y, rotation, width preset)
    persisted by the Host, so dragging a card survives a restart and a second
    window shows the same arrangement. A note created before the canvas existed
    carries `layout: null` and gets a stable derived preview position instead of
    a broken or stacked wall.
  - Drag any card to place it; a drag deliberately does not bump `updatedAt`, so
    tidying the board never reshuffles a "by updated" sort.
  - New deterministic "Tidy" pass (`arrange`) repacks the wall with shelf
    packing: the same wall always yields the same arrangement, and a second tidy
    writes nothing.
  - Three card width presets (small/medium/large) and canvas zoom (0.4x-2x) via a
    floating control and ctrl/cmd + wheel.
  - Three view modes: canvas, responsive grid and a dense list index.
  - Note bodies render Markdown: headings, paragraphs, bold/italic/strike,
    inline code, fenced code, ordered and unordered lists, `- [ ]` checkboxes,
    quotes, rules, pipe tables and http(s)/mailto links. Rendering is done with a
    small in-package renderer that emits React elements, never HTML strings, and
    only http(s)/mailto targets become live links.
  - The `sticky_wall` model tool gains `arrange` and optional `x`/`y` on create.
  - Migrate to the DSH 0.2.2 display contract: `meta.detail` points at
    `docs/DETAIL*.md`, which carries one preview banner, so the plugin detail
    page no longer falls back to the full README. README keeps the long-form
    documentation.
  - Re-declare the toolchain for the mounted DSH 0.2.2-rc.1 line
    (`engines.dsh >=0.2.2-rc.1 <0.3.0`, cordis `~4.1.0`, schemastery `~3.19.0`).

## 0.1.2

### Patch Changes

- Redesign the wall's visual language: masonry layout so short notes stop
  leaving dead space, a derived accent palette with tinted shadows, real tag
  pills and status badges, a paper dot grid, and quieter chip-style controls.

## 0.1.1

### Patch Changes

- Move the note actions onto their own compact top row, so a long title keeps
  the full card width instead of wrapping early, and shrink the four controls.

## 0.1.0

### Minor Changes

- Ship the sticky wall: a left-sidebar entry and a main panel backed by the DSH
  storage domain, with quick capture, pin/archive, search and sort, bilingual
  copy, and an optional model-facing `sticky_wall` tool.
