/**
 * Wall styles.
 *
 * Every surface uses only `--dsw-alias-*` theme tokens so the page follows the
 * light and dark themes; the note pastels are literal hex because they are the
 * plugin's own product color, and each note keeps a readable ink color per
 * theme. Classes are plugin-prefixed (`skw-`) and the sheet ships inside a
 * `<style>` element React removes on unmount, so the plugin's CSS never leaks
 * into product DOM.
 */

export const WALL_CSS = `
.skw-page {
  height: 100%; display: flex; flex-direction: column;
  background-color: var(--dsw-alias-bg-base);
  /* A barely-there dot grid reads as paper without competing with the notes. */
  background-image: radial-gradient(circle at 1px 1px, var(--dsw-alias-border-l1) 1px, transparent 0);
  background-size: 18px 18px;
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px;
  overflow: hidden; -webkit-font-smoothing: antialiased;
}
.skw-page *, .skw-page *::before, .skw-page *::after { box-sizing: border-box; }
.skw-page button { font: inherit; }
.skw-head { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 12px; padding: 18px 22px 14px; }
.skw-head-text { min-width: 0; flex: 1; }
.skw-title { margin: 0; font-size: 19px; line-height: 27px; font-weight: 650; letter-spacing: -.2px; display: flex; align-items: center; gap: 9px; }
/* The title mark echoes the sidebar glyph in the brand color, so the page and
   the sidebar entry read as the same object. */
.skw-title-mark { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; flex: none; border-radius: 8px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); }
.skw-subtitle { margin: 3px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.skw-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.skw-btn { height: 28px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; }
.skw-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.skw-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.skw-btn[disabled] { opacity: .5; cursor: default; }
.skw-btn-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); font-weight: 500; }
.skw-btn-primary:hover { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); filter: brightness(1.06); }
.skw-btn-quiet { border-color: transparent; background: transparent; }
.skw-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: transparent; background: transparent; }
.skw-btn-danger:hover { background: var(--dsw-alias-state-error-secondary); color: var(--dsw-alias-label-primary-foreground); }

.skw-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 0 22px 14px; flex-wrap: wrap; }
.skw-search-wrap { position: relative; flex: 1 1 240px; min-width: 160px; display: flex; align-items: center; }
.skw-search-icon { position: absolute; left: 10px; display: flex; color: var(--dsw-alias-label-tertiary); pointer-events: none; }
.skw-search { width: 100%; height: 32px; padding: 0 11px 0 31px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); transition: border-color .12s ease, box-shadow .12s ease; }
.skw-search::placeholder { color: var(--dsw-alias-label-tertiary); }
.skw-search:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
/* Chips: one row of quiet pills, the active one filled. No boxed segments, so
   filters, sorting and the archive toggle stop reading as three boxes. */
.skw-seg { display: inline-flex; gap: 4px; }
.skw-seg button { height: 30px; padding: 0 12px; border: 1px solid transparent; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12.5px; transition: background .12s ease, color .12s ease; }
.skw-seg button:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.skw-seg button[data-on="true"] { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); font-weight: 550; }
.skw-seg button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.skw-toolbar-sep { width: 1px; height: 18px; background: var(--dsw-alias-border-l2); flex: none; }
.skw-toggle { height: 30px; padding: 0 11px; display: inline-flex; align-items: center; gap: 6px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12.5px; transition: background .12s ease, color .12s ease, border-color .12s ease; }
.skw-toggle:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l4); }
.skw-toggle[data-on="true"] { border-style: solid; border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.skw-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.skw-count { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }

.skw-body { flex: 1 1 auto; overflow: auto; overscroll-behavior: contain; padding: 4px 22px 40px; }
/* Masonry-style columns, not a row grid: cards keep their natural height and
   short notes no longer sit in a tall row with dead space underneath. */
.skw-grid { column-count: 5; column-gap: 14px; }
@media (max-width: 1500px) { .skw-grid { column-count: 4; } }
@media (max-width: 1180px) { .skw-grid { column-count: 3; } }
@media (max-width: 860px)  { .skw-grid { column-count: 2; } }
@media (max-width: 560px)  { .skw-grid { column-count: 1; } }
.skw-empty { margin: 64px auto 0; max-width: 380px; text-align: center; color: var(--dsw-alias-label-secondary); }
.skw-empty p { margin: 0 0 14px; font-size: 13px; }
.skw-empty-icon { font-size: 30px; line-height: 1; display: block; margin-bottom: 12px; opacity: .65; }

.skw-note {
  position: relative; display: flex; flex-direction: column; gap: 4px;
  /* Natural height, no min-height: an empty-ish note stays a small card. */
  padding: 9px 12px 11px;
  border-radius: 12px;
  border: 1px solid var(--skw-note-edge);
  background: var(--skw-note-bg);
  color: var(--skw-note-ink);
  /* A soft tinted drop shadow picks up the note's own color, which is what
     makes the wall read as paper rather than as flat rectangles. */
  box-shadow: 0 1px 2px var(--dsw-alias-bg-mask-2), 0 6px 16px -8px var(--skw-note-glow);
  cursor: default;
  transition: box-shadow .18s ease, transform .18s ease;
  break-inside: avoid; -webkit-column-break-inside: avoid;
  margin: 0 0 14px;
}
.skw-note:hover { box-shadow: 0 2px 4px var(--dsw-alias-bg-mask-2), 0 14px 28px -10px var(--skw-note-glow); transform: translateY(-2px); }
.skw-note:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.skw-note[data-archived="true"] { opacity: .68; }
/* Pinned notes get a colored left rail instead of just a heavier shadow, so
   "pinned" is legible at a glance across the wall. */
.skw-note[data-pinned="true"]::before { content: ""; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 0 3px 3px 0; background: var(--skw-note-accent); }
/* Two rows: the action bar owns the top-right line, the title owns a full-width
   line below it. Keeping them separate means a long title wraps only on its own
   width, and the action bar reserves its height so hover never reflows text. */
.skw-note-bar { display: flex; align-items: center; gap: 6px; min-height: 17px; margin: -3px -4px -5px 0; }
.skw-note-bar .skw-spacer { flex: 1; }
/* A small color dot marks the note's palette at a glance; the action buttons
   sit beside it on the same top row. */
.skw-note-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--skw-note-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--skw-note-accent) 16%, transparent); }
.skw-note-head { display: flex; align-items: flex-start; gap: 6px; }
.skw-note-title { font-size: 13px; line-height: 19px; font-weight: 650; letter-spacing: -.1px; overflow-wrap: anywhere; }
.skw-note-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 20px; flex: 1; color: var(--skw-note-ink); opacity: .92; }
.skw-note-body.is-clamped { display: -webkit-box; -webkit-line-clamp: 10; -webkit-box-orient: vertical; overflow: hidden; }
.skw-note-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 1px; }
/* Tags read as real labels: a tinted pill with the note's accent, not a grey
   block. */
.skw-tag { padding: 0 7px; height: 19px; line-height: 19px; border-radius: 999px; font-size: 11px; font-weight: 500; letter-spacing: .1px; background: color-mix(in srgb, var(--skw-note-accent) 22%, transparent); color: var(--skw-note-ink); }
.skw-note-foot { display: flex; align-items: center; gap: 5px; font-size: 11px; line-height: 16px; color: var(--skw-note-ink); opacity: .58; margin-top: 2px; }
.skw-note-foot .skw-spacer { flex: 1; }
.skw-note-badge { display: inline-flex; align-items: center; gap: 3px; padding: 0 6px; height: 17px; border-radius: 999px; background: color-mix(in srgb, var(--skw-note-accent) 26%, transparent); font-weight: 550; opacity: 1; }
/* In-flow, never absolute: the buttons can no longer sit on top of the text.
   They fade in on hover/focus for calm cards, and stay visible where hover is
   not a thing (touch/coarse pointers) so the actions remain reachable. */
.skw-note-tools { display: flex; flex: none; gap: 1px; opacity: 0; transition: opacity .12s ease; }
.skw-note:hover .skw-note-tools, .skw-note:focus-within .skw-note-tools { opacity: 1; }
@media (hover: none) { .skw-note-tools { opacity: 1; } }
/* Compact controls: 18px, so four of them take a small corner of the bar and
   never squeeze the title row. */
.skw-icon-btn { width: 19px; height: 19px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--skw-note-ink); opacity: .55; cursor: pointer; font-size: 11px; line-height: 1; transition: background .12s ease, opacity .12s ease; }
.skw-icon-btn:hover { opacity: 1; background: color-mix(in srgb, var(--skw-note-ink) 14%, transparent); }
.skw-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; opacity: 1; }
.skw-icon-btn[data-on="true"] { opacity: 1; color: var(--skw-note-accent-ink); }
.skw-pin { flex: none; font-size: 11px; line-height: 1; }

/* Pastel palettes.
   Each note color defines five variables instead of one flat background, so the
   card, its edge, its accent (dot/rail/tags) and its tinted shadow all derive
   from the same hue. accent-ink is the readable text color for accents that
   sit on the paper. Dark mode restates every group: a single shared hex would
   either glow or go muddy on the dark shell. */
.skw-note[data-color="yellow"] {
  --skw-note-bg: #fdf7dc; --skw-note-edge: #ecdc9e; --skw-note-ink: #4a3d12;
  --skw-note-accent: #e0b53a; --skw-note-accent-ink: #8a6a0d; --skw-note-glow: #e8c86055;
}
.skw-note[data-color="pink"] {
  --skw-note-bg: #fde9ef; --skw-note-edge: #f2c9d6; --skw-note-ink: #5a2437;
  --skw-note-accent: #e78aa8; --skw-note-accent-ink: #a33d63; --skw-note-glow: #ef9ab855;
}
.skw-note[data-color="green"] {
  --skw-note-bg: #e7f6ea; --skw-note-edge: #c3e5cd; --skw-note-ink: #1d3f27;
  --skw-note-accent: #55b874; --skw-note-accent-ink: #2c7a47; --skw-note-glow: #6cc48c55;
}
.skw-note[data-color="blue"] {
  --skw-note-bg: #e6f1fd; --skw-note-edge: #c2daf1; --skw-note-ink: #1b3550;
  --skw-note-accent: #5b9de0; --skw-note-accent-ink: #2b6599; --skw-note-glow: #6ba5e055;
}
.skw-note[data-color="purple"] {
  --skw-note-bg: #efe9fd; --skw-note-edge: #d6c9f2; --skw-note-ink: #36264f;
  --skw-note-accent: #9b81e0; --skw-note-accent-ink: #5f3fa8; --skw-note-glow: #a68ee055;
}
.skw-note[data-color="orange"] {
  --skw-note-bg: #fdeee0; --skw-note-edge: #f1d3b4; --skw-note-ink: #4f2d12;
  --skw-note-accent: #e79a4e; --skw-note-accent-ink: #a45c16; --skw-note-glow: #edaa6a55;
}

body[data-ds-dark-theme] .skw-note[data-color="yellow"] {
  --skw-note-bg: #3d3822; --skw-note-edge: #524a2c; --skw-note-ink: #f2e8c6;
  --skw-note-accent: #e8c968; --skw-note-accent-ink: #f3dd9e; --skw-note-glow: #00000055;
}
body[data-ds-dark-theme] .skw-note[data-color="pink"] {
  --skw-note-bg: #3f2630; --skw-note-edge: #55323f; --skw-note-ink: #f7dee6;
  --skw-note-accent: #e78aa8; --skw-note-accent-ink: #f6bccd; --skw-note-glow: #00000055;
}
body[data-ds-dark-theme] .skw-note[data-color="green"] {
  --skw-note-bg: #203a29; --skw-note-edge: #2d5038; --skw-note-ink: #d8f0de;
  --skw-note-accent: #6cc48c; --skw-note-accent-ink: #a9e2bd; --skw-note-glow: #00000055;
}
body[data-ds-dark-theme] .skw-note[data-color="blue"] {
  --skw-note-bg: #1f3346; --skw-note-edge: #2b475f; --skw-note-ink: #d6e8fa;
  --skw-note-accent: #6ba5e0; --skw-note-accent-ink: #a8cdf0; --skw-note-glow: #00000055;
}
body[data-ds-dark-theme] .skw-note[data-color="purple"] {
  --skw-note-bg: #2f2846; --skw-note-edge: #41365c; --skw-note-ink: #e3dbf7;
  --skw-note-accent: #a68ee0; --skw-note-accent-ink: #c8b6f0; --skw-note-glow: #00000055;
}
body[data-ds-dark-theme] .skw-note[data-color="orange"] {
  --skw-note-bg: #3f2e1c; --skw-note-edge: #55402a; --skw-note-ink: #f7e0c9;
  --skw-note-accent: #e79a4e; --skw-note-accent-ink: #f4bd8c; --skw-note-glow: #00000055;
}

/* Composer sheet */
.skw-scrim { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-2); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 40; }
.skw-sheet { width: min(560px, 100%); max-height: 86vh; display: flex; flex-direction: column; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); box-shadow: 0 12px 40px var(--dsw-alias-bg-mask-3); overflow: hidden; }
.skw-sheet-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-weight: 600; }
.skw-sheet-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.skw-input, .skw-textarea { width: 100%; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 7px 10px; }
.skw-input:focus-visible, .skw-textarea:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.skw-textarea { min-height: 132px; resize: vertical; line-height: 19px; }
.skw-swatches { display: flex; gap: 6px; align-items: center; }
.skw-swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.skw-swatch[data-on="true"] { border-color: var(--dsw-alias-label-primary); }
.skw-sheet-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l1); }
.skw-sheet-foot .skw-spacer { flex: 1; }
.skw-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.skw-error { margin: 0; padding: 6px 16px; font-size: 12px; color: var(--dsw-alias-state-error-primary); }

/* Sidebar glyph */
.skw-glyph { display: block; }
`

/** One pastel swatch color for the composer's color picker. */
export const SWATCHES: ReadonlyArray<{ key: string; css: string }> = [
  { key: 'yellow', css: '#f7d774' },
  { key: 'pink', css: '#f5b8c8' },
  { key: 'green', css: '#a8d8b0' },
  { key: 'blue', css: '#a8cdf0' },
  { key: 'purple', css: '#c3b3ee' },
  { key: 'orange', css: '#f3b98a' },
]
