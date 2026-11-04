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
.skw-page { height: 100%; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; overflow: hidden; -webkit-font-smoothing: antialiased; }
.skw-page *, .skw-page *::before, .skw-page *::after { box-sizing: border-box; }
.skw-page button { font: inherit; }
.skw-head { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 12px; padding: 16px 20px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.skw-head-text { min-width: 0; flex: 1; }
.skw-title { margin: 0; font-size: 18px; line-height: 26px; font-weight: 600; letter-spacing: .1px; display: flex; align-items: center; gap: 8px; }
.skw-subtitle { margin: 2px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
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

.skw-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 10px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.skw-search { flex: 1 1 220px; min-width: 140px; height: 30px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.skw-search::placeholder { color: var(--dsw-alias-label-tertiary); }
.skw-search:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.skw-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; overflow: hidden; }
.skw-seg button { height: 28px; padding: 0 9px; border: 0; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; }
.skw-seg button + button { border-left: 1px solid var(--dsw-alias-border-l1); }
.skw-seg button[data-on="true"] { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font-weight: 500; }
.skw-toggle { height: 28px; padding: 0 9px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; }
.skw-toggle[data-on="true"] { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.skw-count { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }

.skw-body { flex: 1 1 auto; overflow: auto; overscroll-behavior: contain; padding: 16px 20px 32px; }
.skw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; align-items: start; }
.skw-empty { margin: 48px auto 0; max-width: 360px; text-align: center; color: var(--dsw-alias-label-secondary); }
.skw-empty p { margin: 0 0 12px; }
.skw-empty-icon { font-size: 28px; line-height: 1; display: block; margin-bottom: 10px; opacity: .7; }

.skw-note { position: relative; display: flex; flex-direction: column; gap: 6px; min-height: 118px; padding: 10px 12px 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 1px 2px var(--dsw-alias-bg-mask-2); cursor: default; transition: box-shadow .15s ease, transform .15s ease; }
.skw-note:hover { box-shadow: 0 4px 14px var(--dsw-alias-bg-mask-2); transform: translateY(-1px); }
.skw-note[data-archived="true"] { opacity: .72; }
.skw-note[data-pinned="true"] { box-shadow: 0 2px 10px var(--dsw-alias-bg-mask-2); }
/* Header row: title and actions share one in-flow line, so nothing overlaps.
   It reserves its height even when the title is empty or the buttons are
   hidden, which keeps hover from reflowing the body text. */
.skw-note-head { display: flex; align-items: flex-start; gap: 6px; min-height: 24px; }
.skw-note-head .skw-spacer { flex: 1; }
.skw-note-title { font-size: 12.5px; line-height: 18px; font-weight: 600; overflow-wrap: anywhere; padding-top: 3px; }
.skw-note-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 19px; flex: 1; }
.skw-note-body.is-clamped { display: -webkit-box; -webkit-line-clamp: 9; -webkit-box-orient: vertical; overflow: hidden; }
.skw-note-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.skw-tag { padding: 0 6px; height: 18px; line-height: 18px; border-radius: 9px; font-size: 11px; background: var(--dsw-alias-bg-mask-2); color: inherit; opacity: .85; }
.skw-note-foot { display: flex; align-items: center; gap: 4px; font-size: 11px; line-height: 16px; opacity: .82; }
.skw-note-foot .skw-spacer { flex: 1; }
/* In-flow, never absolute: the buttons can no longer sit on top of the text.
   They fade in on hover/focus for calm cards, and stay visible where hover is
   not a thing (touch/coarse pointers) so the actions remain reachable. */
.skw-note-tools { display: flex; flex: none; gap: 2px; opacity: 0; transition: opacity .12s ease; }
.skw-note:hover .skw-note-tools, .skw-note:focus-within .skw-note-tools { opacity: 1; }
@media (hover: none) { .skw-note-tools { opacity: 1; } }
.skw-icon-btn { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 6px; background: var(--dsw-alias-bg-mask-2); color: inherit; cursor: pointer; }
.skw-icon-btn:hover { background: var(--dsw-alias-bg-mask-3); }
.skw-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.skw-icon-btn[data-on="true"] { color: var(--dsw-alias-brand-primary); }
.skw-pin { flex: none; font-size: 12px; line-height: 16px; }

/* Pastel palettes: each keeps a light and dark ink pair. */
.skw-note[data-color="yellow"] { background: #fdf6d8; color: #4a3f14; border-color: #efe1a8; }
.skw-note[data-color="pink"]   { background: #fde8ee; color: #5a2739; border-color: #f3ccd8; }
.skw-note[data-color="green"]  { background: #e5f6e8; color: #21432a; border-color: #c6e7ce; }
.skw-note[data-color="blue"]   { background: #e4f0fd; color: #1f3a55; border-color: #c5dcf3; }
.skw-note[data-color="purple"] { background: #efe8fd; color: #3a2b5a; border-color: #d9ccf4; }
.skw-note[data-color="orange"] { background: #fdeee0; color: #553318; border-color: #f3d6b8; }
body[data-ds-dark-theme] .skw-note[data-color="yellow"] { background: #4a4322; color: #f5ecc4; border-color: #5f5630; }
body[data-ds-dark-theme] .skw-note[data-color="pink"]   { background: #4a2a35; color: #f8dfe6; border-color: #613a47; }
body[data-ds-dark-theme] .skw-note[data-color="green"]  { background: #22422c; color: #d9f2df; border-color: #2f5940; }
body[data-ds-dark-theme] .skw-note[data-color="blue"]   { background: #21374b; color: #d8e9fb; border-color: #2e4b64; }
body[data-ds-dark-theme] .skw-note[data-color="purple"] { background: #322a4a; color: #e5dcfa; border-color: #443a63; }
body[data-ds-dark-theme] .skw-note[data-color="orange"] { background: #4a3520; color: #f9e2c9; border-color: #63472b; }

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
