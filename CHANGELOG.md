# Changelog

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
