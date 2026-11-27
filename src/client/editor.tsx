/**
 * A reusable Markdown authoring editor.
 *
 * This is deliberately "tier A": a plain `<textarea>` plus a small insert
 * toolbar, not a CodeMirror/ProseMirror/Monaco mount. Those editors measure
 * 275–498 KB against a 134 KB whole plugin, and a sticky note needs a dozen
 * Markdown constructs, not a document model with a syntax tree. What a plain
 * textarea does NOT give you is the behaviour that makes writing pleasant, so
 * this module owns exactly that and nothing more:
 *
 * 1. **IME safety, the highest-priority rule.** Chinese/Japanese input must not
 *    break. Opening a composition makes every shortcut inert; the write-back
 *    passes the textarea value through byte-for-byte (no trim, no normalisation,
 *    no reformatting), and the caret is never touched while composing — Safari
 *    resets the pinyin buffer if either rule is broken. The guard reproduces
 *    DSH's own shipped primitive exactly: `compositionstart` opens it,
 *    `compositionend` closes it but keeps a `justEnded` latch (some IMEs deliver
 *    one keydown AFTER `compositionend`), the following `keyup` clears the latch,
 *    and a window `blur` clears everything.
 * 2. **Auto-height** to at most 60% of the viewport, then an internal scrollbar,
 *    re-measured when the value changes externally and when the width changes.
 * 3. **A Markdown insert toolbar** that records the selection BEFORE the value
 *    changes and restores the caret afterwards, so formatting never eats the
 *    caret or the focus.
 * 4. **Tab indent and Enter continuation** — the two textarea habits every writer
 *    expects, both IME-guarded.
 *
 * The indentation contract is shared with `src/markdown-parse.ts` and must stay
 * in sync with it: one nesting level is {@link INDENT_WIDTH} spaces, a line's
 * level is `floor(leading columns / INDENT_WIDTH)`, and a tab counts as one
 * level. The parser recognises every block marker on the line with its leading
 * whitespace removed, so indentation NEVER breaks syntax — which is why the
 * editor does not refuse to indent, it only has to indent to a real level.
 *
 * The editor is fully controlled: `value` comes from the parent and every edit
 * leaves through `onChange`. It imports nothing but `react` plus its own pure
 * helpers, because the browser module table only resolves `react` — everything
 * else in this file is bundled.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'

/** The two locales the wall ships. */
export type EditorLocale = 'zh' | 'en'

/**
 * The translate function this editor accepts, structurally identical to the
 * `Translate` the locale service binds (see `src/client/text.ts`).
 *
 * It is DECLARED here instead of imported because this module may only import
 * `react`: the browser module table resolves nothing else. The shape is what
 * matters, so the Composer can pass the very same `t` it uses everywhere else.
 */
export type EditorTranslate = (key: string, params?: Record<string, string | number>) => string

export interface MarkdownEditorProps {
  value: string
  onChange(value: string): void
  /** Save handler; called on Cmd/Ctrl+S and Cmd/Ctrl+Enter. */
  onSave?(): void
  /** Escape handler; only fires when NOT composing. */
  onEscape?(): void
  /** Max characters; undefined means no limit. */
  maxLength?: number
  placeholder?: string
  /** aria-label */
  label: string
  /** Insert-toolbar visibility; defaults to true. */
  toolbar?: boolean
  /** Focus the textarea on mount; defaults to true. */
  autoFocus?: boolean
  /**
   * Fill the parent's height instead of growing to the content.
   *
   * The composer sheet is resizable now, so the editor must own the space it is
   * given: an auto-growing field inside a tall modal leaves the extra height
   * unused, which is the whole reason the sheet was frustrating to write in.
   * When false (the default) the editor keeps its content-driven auto-grow.
   */
  fill?: boolean
  disabled?: boolean
  /**
   * Toolbar copy language; defaults to `zh` (the plugin's authoring language).
   *
   * Only a FALLBACK now: when `t` is supplied the toolbar asks the shared
   * dictionary through it, and this prop decides nothing. It stays so the
   * editor's public surface does not change for a caller that has no `t`.
   */
  locale?: EditorLocale
  /**
   * Translate function for the toolbar's copy, e.g. the `t` the Composer already
   * holds. Optional and additive: without it the editor falls back to its own
   * built-in `zh`/`en` labels, so every existing caller keeps working.
   */
  t?: EditorTranslate
  /**
   * Hide the editor without unmounting it.
   *
   * The composer's preview toggle used to swap the editor out of the tree, and
   * remounting a controlled textarea throws its selection away — switching to
   * preview and back landed the caret at the end of the note (measured: a caret
   * at 5 came back at 11). Keeping the node mounted and hiding it with an inline
   * `display:none` preserves the browser's own selection, which no amount of
   * caret arithmetic can reconstruct afterwards.
   *
   * Inline style, not the `hidden` attribute: `.skw-ed-root { display: flex }` in
   * {@link EDITOR_CSS} is an AUTHOR rule and beats the UA sheet's
   * `[hidden] { display: none }`, so the attribute alone leaves the editor
   * laid out (measured 884×150, still taking the preview pane's height).
   */
  hidden?: boolean
}

/**
 * One nesting level: two spaces.
 *
 * This MUST stay equal to `INDENT_WIDTH` in `src/markdown-parse.ts`. It is
 * declared again rather than imported because this module may only import
 * `react` — the parser is the single source of truth for the SEMANTICS (a
 * block marker is recognised on the whitespace-stripped line, so indentation
 * never breaks syntax), and this constant is the editor's copy of the same
 * measurement so Tab lands on a level the parser actually reads as nesting.
 */
const INDENT_WIDTH = 2
/** The literal one Tab inserts; `INDENT_WIDTH` spaces. */
const INDENT = ' '.repeat(INDENT_WIDTH)
/** The height floor, in px, that keeps an empty editor from collapsing. */
const MIN_HEIGHT_PX = 88
/** Share of the viewport the editor may grow to before it scrolls internally. */
const VIEWPORT_SHARE = 0.6

/** A caret range in the coordinate space of its own text. */
interface CaretEdit {
  value: string
  start: number
  end: number
}

/** Everything an insert action needs to know, captured before the value moves. */
interface EditContext {
  value: string
  start: number
  end: number
  locale: EditorLocale
}

/** Localized label pair; the toolbar ships both languages because it does not
 * depend on the shared dictionary module (which another module owns). */
interface LabelPair {
  zh: string
  en: string
}

interface ToolbarAction extends LabelPair {
  id: string
  /**
   * The shared dictionary key for this action's label.
   *
   * Written out EXPLICITLY rather than derived from `id`: `rule` maps to `mdHr`
   * and `code-block` to `mdCodeBlock`, so any `md + capitalise(id)` scheme would
   * silently render a raw key for exactly those two. An explicit field also lets
   * a test enumerate the toolbar and prove every key resolves.
   */
  key: string
  /** Visible glyph; keeps the toolbar 24px tall instead of a row of words. */
  glyph: string
  /** Optional CSS styling for glyphs that are meant to look like their effect. */
  style?: 'bold' | 'italic' | 'strike'
  run(ctx: EditContext): CaretEdit | null
}

interface ToolbarGroup extends LabelPair {
  id: string
  /** The shared dictionary key for this group's label. */
  key: string
  actions: ToolbarAction[]
}

// ---------------------------------------------------------------------------
// Pure text machinery.
//
// Every helper here is a pure function from (value, selection) to (value,
// selection). The component shell only wires them to the DOM, which is what
// makes the caret arithmetic testable without a browser.
// ---------------------------------------------------------------------------

/** Clamp a caret range into a string, keeping start <= end. */
function clampRange(value: string, start: number, end: number): { start: number; end: number } {
  const length = value.length
  const from = Math.min(Math.max(0, start), length)
  const to = Math.min(Math.max(from, end), length)
  return { start: from, end: to }
}

/** Offsets of the line that contains `position`; `to` excludes the newline. */
function lineBounds(value: string, position: number): { from: number; to: number } {
  const at = Math.min(Math.max(0, position), value.length)
  const from = value.lastIndexOf('\n', at - 1) + 1
  const next = value.indexOf('\n', at)
  return { from, to: next === -1 ? value.length : next }
}

/**
 * The full lines a selection touches.
 *
 * A selection that ENDS exactly at a line start must not drag the following
 * line into the edit — that is the normal "select these whole lines" gesture
 * (drag past the last newline), and prefixing an extra line nobody selected is
 * the classic list-toolbar bug.
 */
function touchedLines(value: string, start: number, end: number): { from: number; to: number } {
  const first = lineBounds(value, start)
  const tail = end > start && value[end - 1] === '\n' ? end - 1 : end
  const last = lineBounds(value, tail)
  return { from: first.from, to: last.to }
}

interface LineSpan {
  from: number
  to: number
  delta: number
}

/**
 * Rewrite every line the selection touches, then map the caret back.
 *
 * The mapping is the whole point: a line prefix shifts everything after it. Two
 * cases make the naive "add the delta" wrong:
 *
 * - A collapsed caret sitting exactly ON a line start must follow a FORWARD
 *   prefix, so formatting "title" into "# title" leaves the caret after the
 *   marker instead of before it (typing there would silently un-heading the
 *   line). It must NOT follow a backward shift, which only removed characters to
 *   its left.
 * - A selection boundary at a line start must stay put, so indenting or
 *   bullet-prefixing three selected lines keeps all three selected — marker
 *   included — instead of starting one character into the first line.
 */
function rewriteLines(
  value: string,
  start: number,
  end: number,
  rewrite: (line: string, index: number) => string,
): CaretEdit {
  const range = touchedLines(value, start, end)
  const lines = value.slice(range.from, range.to).split('\n')
  const spans: LineSpan[] = []
  const out: string[] = []
  let consumed = 0

  lines.forEach((line, index) => {
    const next = rewrite(line, index)
    const from = range.from + consumed
    spans.push({ from, to: from + line.length, delta: next.length - line.length })
    consumed += line.length + 1
    out.push(next)
  })

  const collapsed = start === end
  const mapPosition = (position: number): number => {
    let shift = 0
    for (const span of spans) {
      if (position > span.to) {
        // This whole line sits before the boundary, so its edit shifts it.
        shift += span.delta
        continue
      }
      if (position >= span.from) {
        shift += position === span.from ? (collapsed ? Math.max(span.delta, 0) : 0) : span.delta
      }
      break
    }
    return position + shift
  }

  const nextValue = value.slice(0, range.from) + out.join('\n') + value.slice(range.to)
  const caret = clampRange(nextValue, mapPosition(start), mapPosition(end))
  return { value: nextValue, start: caret.start, end: caret.end }
}

/** Leading horizontal whitespace of a line. */
function leadingSpace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ''
}

// The marker families the toolbar replaces rather than stacks. A line may only
// carry one of them: pressing "todo" on a bullet converts the bullet instead of
// producing "- - [ ] "-style nonsense.
//
// Every pattern below must accept AT LEAST what `src/markdown-parse.ts` accepts,
// or the toolbar cannot strip a marker the renderer honours and stacks a second
// one in front of it. The parser takes `#{1,6}` and `\d{1,9}`; the editor used to
// take `#{1,4}` and `\d{1,3}`, so pressing H1 on a `#####` line produced
// "# ##### five" and pressing bullet on `1234. item` produced "- 1234. item".
const HEADING_MARKER = /^([ \t]*)(#{1,6})[ \t]+/
const TODO_MARKER = /^([ \t]*)([-*+])[ \t]+\[[ xX]\][ \t]+/
const ORDERED_MARKER = /^([ \t]*)(\d{1,9})([.)])[ \t]+/
const BULLET_MARKER = /^([ \t]*)([-*+])[ \t]+/
const QUOTE_MARKER = /^([ \t]*)>[ \t]?/
/**
 * A thematic break, as the parser reads one: three or more `-`, `*` or `_`.
 *
 * It has to be stripped like any other marker, because `- ---` is NOT a bullet
 * whose text is a rule — the parser reads it as a rule and the bullet is lost.
 */
const RULE_MARKER = /^([ \t]*)(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/

/**
 * The line content with its heading, list, quote or rule marker removed.
 *
 * Order matters: the compound markers (todo, ordered, bullet) are tried before
 * the bare rule so a `- [ ]` item is not mistaken for a three-character break.
 */
function stripBlockMarker(line: string): string {
  for (const marker of [HEADING_MARKER, TODO_MARKER, ORDERED_MARKER, BULLET_MARKER, QUOTE_MARKER]) {
    const match = marker.exec(line)
    // Every marker pattern captures the leading indent, so the slice is always
    // at the marker end and the content keeps no duplicated whitespace.
    if (match !== null) return line.slice(match[0].length)
  }
  // A rule carries no text: converting it leaves the bare content after it, so
  // `---` becomes an empty bullet rather than `- ---` (a rule with a bullet lost).
  const rule = RULE_MARKER.exec(line)
  if (rule !== null) return ''
  return line.slice(leadingSpace(line).length)
}

/** Wrap the selection (or an empty caret) in a marker pair. */
function wrapSelection(ctx: EditContext, open: string, close: string): CaretEdit {
  const selected = ctx.value.slice(ctx.start, ctx.end)
  const inner = ctx.start + open.length
  return {
    value: `${ctx.value.slice(0, ctx.start)}${open}${selected}${close}${ctx.value.slice(ctx.end)}`,
    // An empty selection leaves the caret BETWEEN the markers, which is where
    // the user is about to type; a selection stays selected so it can be
    // wrapped again or typed over.
    start: inner,
    end: inner + selected.length,
  }
}

/** Apply a heading level to every touched line, replacing an existing level. */
function applyHeading(level: number): (ctx: EditContext) => CaretEdit {
  return (ctx) =>
    rewriteLines(ctx.value, ctx.start, ctx.end, (line) => {
      const indent = leadingSpace(line)
      return `${indent}${'#'.repeat(level)} ${stripBlockMarker(line)}`
    })
}

/** Apply a bullet / ordered / todo marker to every touched line. */
function applyList(kind: 'bullet' | 'ordered' | 'todo'): (ctx: EditContext) => CaretEdit {
  return (ctx) => {
    // Ordered lists keep an existing counter running, so formatting the second
    // half of "1. 2. 3." does not restart it at 1.
    let nextNumber: number | null = null
    return rewriteLines(ctx.value, ctx.start, ctx.end, (line) => {
      const indent = leadingSpace(line)
      const body = stripBlockMarker(line)
      if (kind === 'bullet') return `${indent}- ${body}`
      if (kind === 'todo') return `${indent}- [ ] ${body}`
      if (nextNumber === null) {
        const existing = ORDERED_MARKER.exec(line)
        nextNumber = existing === null ? 1 : Number(existing[2])
      }
      const number = nextNumber
      nextNumber += 1
      return `${indent}${number}. ${body}`
    })
  }
}

/**
 * Quote or unquote the touched lines.
 *
 * This one toggles: repeated clicks must not build `> > >` ladders, which is
 * what a blind prefix does.
 */
function applyQuote(ctx: EditContext): CaretEdit | null {
  const range = touchedLines(ctx.value, ctx.start, ctx.end)
  const lines = ctx.value.slice(range.from, range.to).split('\n')
  const quoted = lines.every((line) => line.trim() === '' || QUOTE_MARKER.test(line))
  return rewriteLines(ctx.value, ctx.start, ctx.end, (line) => {
    if (line.trim() === '') return line
    if (!quoted) return QUOTE_MARKER.test(line) ? line : `> ${line}`
    const match = QUOTE_MARKER.exec(line)
    return match === null ? line : `${match[1] ?? ''}${line.slice(match[0].length)}`
  })
}

/**
 * Insert a block-level construct on its own lines.
 *
 * Two invariants make the caret arithmetic trivial for every caller:
 *
 * - the block always starts at a line start (a leading newline is added when the
 *   caret was mid-paragraph), so two inserts in a row never glue a rule or a
 *   table onto the text above it;
 * - a newline ALWAYS follows the block (an existing one is reused, otherwise one
 *   is added), so `caretInBlock === block.length + 1` reliably means "the start
 *   of the line after the block".
 *
 * Anything shorter parks the caret inside the construct, which is what the code
 * fence and the table want.
 */
function insertBlock(ctx: EditContext, block: string, caretInBlock: number): CaretEdit {
  const before = ctx.value.slice(0, ctx.start)
  const after = ctx.value.slice(ctx.end)
  const lead = before === '' || before.endsWith('\n') ? '' : '\n'
  const trail = after.startsWith('\n') ? '' : '\n'
  const position = before.length + lead.length
  return {
    value: `${before}${lead}${block}${trail}${after}`,
    start: position + caretInBlock,
    end: position + caretInBlock,
  }
}

/** A 3x3 pipe table: header row, divider row, then two body rows. */
function tableSkeleton(locale: EditorLocale): { block: string; caretInBlock: number } {
  const cell = (index: number): string => (locale === 'zh' ? `列 ${index}` : `Column ${index}`)
  const header = `| ${cell(1)} | ${cell(2)} | ${cell(3)} |`
  const divider = '| --- | --- | --- |'
  const empty = '|   |   |   |'
  const rows = [header, divider, empty, empty]
  return {
    block: rows.join('\n'),
    // Park the caret in the first empty body cell: the header labels are
    // placeholders to overwrite, the body is what the user came to fill in.
    caretInBlock: header.length + 1 + divider.length + 1 + 2,
  }
}

/** Two-digit pad for the timestamp. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local wall-clock stamp, `YYYY-MM-DD HH:mm`. */
function stamp(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** Insert the stamp at the caret. */
function insertStamp(ctx: EditContext): CaretEdit {
  const text = stamp(new Date())
  const position = ctx.start + text.length
  return {
    value: `${ctx.value.slice(0, ctx.start)}${text}${ctx.value.slice(ctx.end)}`,
    start: position,
    end: position,
  }
}

/** Insert a fenced code block, keeping the selection inside the fence. */
function insertCodeBlock(ctx: EditContext): CaretEdit {
  const body = ctx.value.slice(ctx.start, ctx.end)
  // The middle line always exists, even without a selection: the caret lands on
  // it, so the fence is immediately typeable instead of a pair of dangling
  // backtick runs to hunt down.
  const block = `\`\`\`\n${body}\n\`\`\``
  return insertBlock(ctx, block, 4 + body.length)
}

// ---------------------------------------------------------------------------
// The toolbar description. Order is the writer's order: structure first, then
// the constructs people reach for while drafting.
// ---------------------------------------------------------------------------

const TOOLBAR_LABEL: LabelPair & { key: string } = {
  key: 'toolbarLabel',
  zh: '编辑工具栏',
  en: 'Formatting toolbar',
}

const TOOLBAR: readonly ToolbarGroup[] = [
  {
    id: 'structure',
    key: 'toolbarStructure',
    zh: '结构',
    en: 'Structure',
    actions: [
      { id: 'h1', key: 'mdH1', zh: '一级标题', en: 'Heading 1', glyph: 'H1', run: applyHeading(1) },
      { id: 'h2', key: 'mdH2', zh: '二级标题', en: 'Heading 2', glyph: 'H2', run: applyHeading(2) },
      { id: 'h3', key: 'mdH3', zh: '三级标题', en: 'Heading 3', glyph: 'H3', run: applyHeading(3) },
      { id: 'quote', key: 'mdQuote', zh: '引用', en: 'Blockquote', glyph: '❝', run: applyQuote },
      { id: 'rule', key: 'mdHr', zh: '分割线', en: 'Divider', glyph: '—', run: (ctx) => insertBlock(ctx, '---', 4) },
      { id: 'code-block', key: 'mdCodeBlock', zh: '代码块', en: 'Code block', glyph: '{ }', run: insertCodeBlock },
    ],
  },
  {
    id: 'lists',
    key: 'toolbarList',
    zh: '列表',
    en: 'Lists',
    actions: [
      { id: 'bullet', key: 'mdBullet', zh: '无序列表', en: 'Bullet list', glyph: '•', run: applyList('bullet') },
      { id: 'ordered', key: 'mdOrdered', zh: '有序列表', en: 'Numbered list', glyph: '1.', run: applyList('ordered') },
      { id: 'todo', key: 'mdTodo', zh: '待办', en: 'Todo', glyph: '☑', run: applyList('todo') },
    ],
  },
  {
    id: 'table',
    key: 'toolbarTable',
    zh: '表格',
    en: 'Table',
    actions: [
      {
        id: 'table',
        key: 'mdTable',
        zh: '插入表格',
        en: 'Insert table',
        glyph: '▦',
        run: (ctx) => {
          const { block, caretInBlock } = tableSkeleton(ctx.locale)
          return insertBlock(ctx, block, caretInBlock)
        },
      },
    ],
  },
  {
    id: 'inline',
    key: 'toolbarInline',
    zh: '行内',
    en: 'Inline',
    actions: [
      { id: 'bold', key: 'mdBold', zh: '粗体', en: 'Bold', glyph: 'B', style: 'bold', run: (ctx) => wrapSelection(ctx, '**', '**') },
      // `*` rather than `_`: the parser refuses an underscore pair that touches a
      // word character (`snake_case_name` is an identifier), so italicising a
      // word inside a sentence produced `ab_cd_` — literal text, no <em>. An
      // empty selection produced `__`, which is a STRONG run and rendered bold.
      // The asterisk has no such word-boundary rule, so it always works.
      { id: 'italic', key: 'mdItalic', zh: '斜体', en: 'Italic', glyph: 'I', style: 'italic', run: (ctx) => wrapSelection(ctx, '*', '*') },
      { id: 'strike', key: 'mdStrike', zh: '删除线', en: 'Strikethrough', glyph: 'S', style: 'strike', run: (ctx) => wrapSelection(ctx, '~~', '~~') },
      { id: 'code', key: 'mdCode', zh: '行内代码', en: 'Inline code', glyph: '<>', run: (ctx) => wrapSelection(ctx, '`', '`') },
      { id: 'link', key: 'mdLink', zh: '链接', en: 'Link', glyph: '⛓', run: (ctx) => wrapSelection(ctx, '[', '](https://)') },
    ],
  },
  {
    id: 'other',
    key: 'toolbarOther',
    zh: '其他',
    en: 'Other',
    actions: [{ id: 'timestamp', key: 'mdTimestamp', zh: '日期时间', en: 'Date and time', glyph: '⌚', run: insertStamp }],
  },
]

/**
 * Every shared-dictionary key the toolbar can ask for.
 *
 * Exported for the test that proves the mapping is complete: a key added to the
 * toolbar but missing from `text.ts` would otherwise render as the raw key name
 * (the dictionary falls back to the key), which looks like a broken label rather
 * than a caught bug.
 */
export const TOOLBAR_KEYS: readonly string[] = [
  TOOLBAR_LABEL.key,
  ...TOOLBAR.flatMap((group) => [group.key, ...group.actions.map((action) => action.key)]),
]

// ---------------------------------------------------------------------------
// Indentation, and what Enter does on each kind of line.
//
// Both follow the parser's contract (src/markdown-parse.ts): a line's nesting
// level is floor(leading columns / INDENT_WIDTH), a tab counts as one level, and
// block markers are recognised on the whitespace-stripped line. That last point
// is why indentation never has to be refused here — it only has to be CORRECT,
// i.e. always land on a whole level.
// ---------------------------------------------------------------------------

/** Leading-whitespace width in columns, counting a tab as one nesting level. */
function columnsOf(prefix: string): number {
  let width = 0
  for (const char of prefix) width += char === '\t' ? INDENT_WIDTH : 1
  return width
}

/**
 * The nesting level of a line: the parser's `floor(indent / INDENT_WIDTH)`.
 *
 * The editor does not act on a line's level directly — Tab and Shift+Tab work in
 * levels relative to the current one — but the tests and any future "move this
 * item" action need the same measurement the parser uses, so it lives here next
 * to {@link columnsOf} rather than being re-derived.
 */
export function indentLevelOf(line: string): number {
  return Math.floor(columnsOf(leadingSpace(line)) / INDENT_WIDTH)
}

/**
 * Tab / Shift+Tab.
 *
 * A bare caret indents its own LINE rather than inserting whitespace at the
 * caret: a Markdown line's structure lives in its prefix, so "indent" has to mean
 * the line, otherwise the caret would drift into the middle of a nested item
 * while the line itself stayed flat.
 *
 * - Tab always adds exactly one level, from any starting indent: appending one
 *   unit to the existing prefix gives `floor((c + 2) / 2) === floor(c / 2) + 1`.
 *   On a list line that is precisely "become a child of the item above".
 * - Shift+Tab removes the line's CURRENT level and lands on the previous one, so
 *   a line with a stray one-space offset is straightened out in one press
 *   (`"   - item"` is level 1 and outdents to level 0, not to a lone space).
 * - A blank line is left alone: indenting it would write invisible trailing
 *   whitespace, which Markdown reads as content.
 */
/**
 * The indentation step, in columns. ONE value for the whole editor.
 *
 * It is a constant on purpose. Deriving it from the document was tried twice and
 * both versions were self-referential: Tab changes the document, so the next Tab
 * measured a different document and stepped by a different amount. Measured with
 * a per-document unit: six consecutive Tabs on a bullet produced
 * `[2, 2, 4, 4, 4, 4]` columns, and Tab-up/Shift+Tab-down did not retrace each
 * other (`[0,2,4,8,12,16]` up versus `[16,12,8,4,0,0]` down).
 *
 * A constant makes the two directions exact inverses — Tab then Shift+Tab always
 * returns to where it started — which is the property a writer actually relies
 * on. The value is the parser's own `INDENT_WIDTH`, so a Tab lands exactly on a
 * nesting level the renderer reads as a level.
 */
const INDENT_STEP = INDENT_WIDTH

/**
 * Tab / Shift+Tab.
 *
 * A bare caret indents its own LINE rather than inserting whitespace at the
 * caret: a Markdown line's structure lives in its prefix, so "indent" has to mean
 * the line, otherwise the caret would drift into the middle of a nested item
 * while the line itself stayed flat.
 *
 * Both directions use {@link INDENT_STEP} and are exact inverses:
 *
 * - Tab moves the line to the NEXT whole level of the grid;
 * - Shift+Tab moves it to the PREVIOUS one.
 *
 * Both are `floor(columns / step) ± 1`, so a line that starts between levels (3
 * columns) is snapped onto the grid instead of gaining an arbitrary offset, and
 * pressing Tab n times then Shift+Tab n times returns to the starting indent.
 *
 * A blank line is left alone: indenting it would write invisible trailing
 * whitespace, which Markdown reads as content.
 */
function indentSelection(value: string, start: number, end: number, direction: 1 | -1): CaretEdit {
  return rewriteLines(value, start, end, (line) => {
    // Nothing to indent, and a whitespace-only line must stay byte-empty.
    if (line.trim() === '') return line
    const prefix = leadingSpace(line)
    const body = line.slice(prefix.length)
    const columns = columnsOf(prefix)
    if (direction === 1) {
      // The next level of the grid, never just "+step": a line at 3 columns goes
      // to 4 (the next level), not to 5 (a stray offset one level deep).
      const level = Math.floor(columns / INDENT_STEP)
      return `${' '.repeat((level + 1) * INDENT_STEP)}${body}`
    }
    // The previous level. A line already on a level moves down exactly one; a
    // line BETWEEN levels snaps down to the one below it.
    const level = Math.ceil(columns / INDENT_STEP)
    return `${' '.repeat(Math.max(0, level - 1) * INDENT_STEP)}${body}`
  })
}

/**
 * Mark every line that belongs to a fenced code block, fences included.
 *
 * Mirrors the parser exactly: the opening fence is matched on the
 * whitespace-stripped line, and the closing fence must use the same character
 * and be at least as long as the opening one. An unterminated fence still marks
 * its lines — the writer is mid-typing and Enter must already behave.
 */
function fenceLines(lines: readonly string[]): boolean[] {
  const marked = lines.map(() => false)
  let open: { char: string; length: number } | null = null
  lines.forEach((line, index) => {
    const body = line.trimStart()
    const match = FENCE_OPEN.exec(body)
    const marker = match?.[1] ?? ''
    if (open === null) {
      if (marker !== '') {
        open = { char: marker.charAt(0), length: marker.length }
        marked[index] = true
      }
      return
    }
    marked[index] = true
    if (marker !== '' && marker.charAt(0) === open.char && marker.length >= open.length) open = null
  })
  return marked
}

/** A fence run: three or more backticks or tildes, as the parser reads it. */
const FENCE_OPEN = /^(`{3,}|~{3,})/

/** A table divider cell row, matched the way the parser matches it. */
const TABLE_DIVIDER = /^\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/

/** The cells of a pipe row, with the optional leading/trailing pipe dropped. */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  if (trimmed.trim() === '') return []
  return trimmed.split('|')
}

/**
 * Where a new table row belongs, or null when the caret's line is not in a table.
 *
 * "Contains a pipe" is not enough — a paragraph can contain one — so the
 * parser's own rule is reproduced: a table is a contiguous run of pipe rows
 * whose SECOND line is a divider row.
 *
 * Enter on the HEADER row must NOT insert between the header and the divider:
 * that would split the table into a one-row table and a paragraph. The row goes
 * after the table's last row instead, so the table stays whole.
 */
function tableInsertion(
  lines: readonly string[],
  index: number,
): { at: number; columns: number } | null {
  const isRow = (at: number): boolean => (lines[at] ?? '').trimStart().includes('|')
  const isDivider = (at: number): boolean => TABLE_DIVIDER.test((lines[at] ?? '').trimStart())
  let first = index
  while (first > 0 && isRow(first - 1)) first -= 1
  if (!isDivider(first + 1)) return null
  const cells = splitTableRow(lines[index] ?? '')
  if (cells.length === 0) return null
  // The header is the line above the divider; everything from `first + 2` on is
  // a body row (the parser stops the table at the first non-row line).
  let last = index
  if (index === first) {
    last = first + 1
    while (isRow(last + 1) && !isDivider(last + 1)) last += 1
  } else {
    while (isRow(last + 1)) last += 1
  }
  return { at: last, columns: cells.length }
}

/** A quote marker run at the start of a (whitespace-stripped) line: `>`, `> >`. */
const QUOTE_PREFIX = /^(?:>[ \t]?)+/

// Enter inside a list line continues the list. The trailing space is part of the
// marker on purpose: "-" alone is a divider candidate, "- " starts a list.
const CONTINUE_TODO = /^([ \t]*)([-*+])[ \t]+\[[ xX]\][ \t]+/
const CONTINUE_BULLET = /^([ \t]*)([-*+])[ \t]+/
const CONTINUE_ORDERED = /^([ \t]*)(\d{1,3})([.)])[ \t]+/

/** Insert exactly one newline, replacing any selection: the browser's own Enter. */
function plainNewline(value: string, start: number, end: number): CaretEdit {
  const caret = start + 1
  return { value: `${value.slice(0, start)}\n${value.slice(end)}`, start: caret, end: caret }
}

/**
 * Delete an empty list/quote marker line without leaving a blank line behind.
 *
 * The trailing newline goes with it when there is a following line, otherwise
 * the previous newline stays and the caret lands at the end of the note. The old
 * version removed only the marker text, so `"- a\n- \n- b"` became
 * `"- a\n\n- b"` — one Enter split the list in two.
 */
function dropMarkerLine(value: string, from: number, to: number): CaretEdit {
  const end = to < value.length ? to + 1 : to
  return { value: value.slice(0, from) + value.slice(end), start: from, end: from }
}

/**
 * What Enter does on the caret's line.
 *
 * Returns null when the browser should handle the keystroke itself — a plain
 * line with no indentation to carry over is exactly that case, and intercepting
 * it would only reimplement the browser's own newline.
 */
function continueLine(value: string, start: number, end: number): CaretEdit | null {
  const line = lineBounds(value, start)
  const text = value.slice(line.from, line.to)
  const lines = value.split('\n')
  const index = value.slice(0, line.from).split('\n').length - 1

  // ---- Fenced code --------------------------------------------------------
  // A fence owns its newlines. Continuing a list or quote marker inside one
  // injected Markdown syntax into the user's code, which is a data bug, not a
  // convenience. Enter there is a plain newline, nothing else.
  if (fenceLines(lines)[index] === true) return plainNewline(value, start, end)

  const body = text.slice(leadingSpace(text).length)

  // ---- Quote --------------------------------------------------------------
  // `> quoted` continues as `> `, and nesting is preserved: `> > x` gives
  // `> > ` because the marker run is copied rather than a single `>`.
  const quote = QUOTE_PREFIX.exec(body)
  if (quote !== null) {
    const prefix = leadingSpace(text)
    // A caret before the marker is not inside the quote; Enter there belongs to
    // the browser, and splitting the line above would surprise the writer.
    if (start - line.from < prefix.length + quote[0].length) return null
    if (body.slice(quote[0].length).trim() === '') return dropMarkerLine(value, line.from, line.to)
    // A marker without its trailing space (`>x`) still continues as `> `, so the
    // next line is typeable instead of gluing the caret to the marker.
    const marker = quote[0].endsWith(' ') || quote[0].endsWith('\t') ? quote[0] : `${quote[0]} `
    const insert = `\n${prefix}${marker}`
    const caret = start + insert.length
    return { value: value.slice(0, start) + insert + value.slice(end), start: caret, end: caret }
  }

  // ---- List ---------------------------------------------------------------
  const todo = CONTINUE_TODO.exec(text)
  const bullet = todo === null ? CONTINUE_BULLET.exec(text) : null
  const ordered = todo === null && bullet === null ? CONTINUE_ORDERED.exec(text) : null
  const marker = (todo ?? bullet ?? ordered)?.[0]
  if (marker !== undefined) {
    // A caret BEFORE the marker is not inside the item; Enter there belongs to
    // the browser, and splitting the line above would surprise the writer.
    if (start - line.from >= marker.length) {
      const itemBody = text.slice(marker.length)
      if (itemBody.trim() === '') {
        // Standard editor behaviour: Enter on an empty item leaves the list
        // instead of stacking another empty bullet nobody will ever fill in.
        return dropMarkerLine(value, line.from, line.to)
      }
      const nextMarker =
        todo !== null
          ? `${todo[1] ?? ''}${todo[2] ?? '-'} [ ] `
          : bullet !== null
            ? `${bullet[1] ?? ''}${bullet[2] ?? '-'} `
            : `${ordered?.[1] ?? ''}${Number(ordered?.[2] ?? '1') + 1}${ordered?.[3] ?? '.'} `
      const insert = `\n${nextMarker}`
      const caret = start + insert.length
      return { value: value.slice(0, start) + insert + value.slice(end), start: caret, end: caret }
    }
  }

  // ---- Table row ----------------------------------------------------------
  // A table row continues as another row with the same column count, so the
  // writer never has to type pipes by hand and the table never breaks because a
  // row came out one cell short.
  const table = tableInsertion(lines, index)
  if (table !== null) {
    // A caret in the MIDDLE of a row is the writer splitting a cell, which is the
    // browser's own job; only a caret at the line's end means "add a row". Both
    // cases stop here — falling through would hand an indented row to the
    // paragraph rule below and duplicate its indent into a stray line.
    if (start !== line.to) return null
    const row = `|${'   |'.repeat(table.columns)}`
    // Append after the table's LAST row, not necessarily the caret's line:
    // inserting below the header would push the divider down and split the table
    // into a one-row table plus a paragraph.
    const at = lines.slice(0, table.at + 1).reduce((sum, entry) => sum + entry.length + 1, 0) - 1
    const insert = `\n${row}`
    // Park the caret in the new row's FIRST cell, the way the table skeleton
    // does: the row is created empty, so "type and it lands in the table" is the
    // only useful place for it (after the "| " the cell starts with).
    const caret = at + 3
    return {
      value: `${value.slice(0, at)}${insert}${value.slice(at)}`,
      start: caret,
      end: caret,
    }
  }

  // ---- Plain paragraph ----------------------------------------------------
  // Enter keeps the line's indentation, so a line the writer indented on purpose
  // (inside a nested block, or pasted from elsewhere) does not snap back to
  // column 0. Only when there IS indentation: a flush line stays the browser's
  // job, and an empty one must not gain invisible whitespace.
  const prefix = leadingSpace(text)
  if (prefix !== '' && text.trim() !== '' && start - line.from >= prefix.length) {
    const insert = `\n${prefix}`
    const caret = start + insert.length
    return { value: value.slice(0, start) + insert + value.slice(end), start: caret, end: caret }
  }

  return null
}

// ---------------------------------------------------------------------------
// The component.
// ---------------------------------------------------------------------------

export function MarkdownEditor(props: MarkdownEditorProps): JSX.Element {
  const {
    value,
    onChange,
    onSave,
    onEscape,
    maxLength,
    placeholder,
    label,
    toolbar = true,
    autoFocus = true,
    fill = false,
    disabled = false,
    locale = 'zh',
    t,
    hidden = false,
  } = props

  /**
   * Resolve one toolbar label.
   *
   * With a `t` from the Composer the copy comes from the shared dictionary, so
   * switching the GUI language retranslates the toolbar. Without one, the
   * built-in pair is used — that fallback is what keeps this module usable with
   * no dependency on `text.ts`, and what keeps every existing caller working.
   */
  const labelOf = useCallback(
    (pair: LabelPair & { key: string }): string => {
      if (t === undefined) return pair[locale]
      const translated = t(pair.key)
      // The dictionary falls back to the KEY for a missing entry, which would
      // paint "mdHr" on a button. Prefer the built-in label in that case.
      return translated === pair.key ? pair[locale] : translated
    },
    [locale, t],
  )

  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  /** A composition is open: the IME owns the value and the selection. */
  const composing = useRef(false)
  /** Composition just closed; the keydown that closes it must stay inert. */
  const justEnded = useRef(false)
  /** Escape arms a one-shot "Tab leaves the editor" escape hatch. */
  const tabEscape = useRef(false)
  /** Caret to restore once the parent has accepted the new value. */
  const pending = useRef<{ expected: string; start: number; end: number; focus: boolean } | null>(null)

  /**
   * The IME guard.
   *
   * `keyCode === 229` is the legacy signal older IMEs send instead of
   * `isComposing`, and `justEnded` covers the keydown some browsers emit AFTER
   * `compositionend` — without it, pressing Enter to commit pinyin would also
   * continue a list.
   *
   * The latch is deliberately ONE-SHOT and task-scoped. It used to be cleared
   * only by a `keyup` on the textarea, which is not a signal every commit
   * produces: committing a candidate with the MOUSE fires `compositionend` and
   * no `keyup` at all, so the latch stayed armed and swallowed every following
   * shortcut. Measured: three consecutive Enters were all discarded and the
   * browser's own bare newline landed instead, which is why a Chinese note's
   * second bullet lost its `- ` marker and its indent. Consuming the latch on
   * the first keydown, plus the expiry scheduled in {@link useEffect}, bounds
   * the guard to the one keydown it was written for.
   */
  const guarded = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    const native = event.nativeEvent
    // Truly mid-composition: the IME owns this key, and the caret must not move.
    if (composing.current || native.isComposing || native.keyCode === 229) return true
    // The single keydown that may still trail `compositionend`. Consuming it here
    // is what stops a missing `keyup` from disarming every later shortcut.
    if (justEnded.current) {
      justEnded.current = false
      return true
    }
    return false
  }, [])

  // Native listeners, not React props: `keyup` and `blur` never reach a React
  // handler for the textarea, and the latch must close on the browser's own
  // keyup rather than on whichever keydown we happen to see.
  useEffect(() => {
    const node = areaRef.current
    if (node === null) return
    /**
     * Timer that expires the `justEnded` latch.
     *
     * The latch exists for ONE keydown that may arrive just after
     * `compositionend`. A mouse-committed candidate produces no `keyup` at all,
     * so without an expiry the latch could outlive the keystroke it guards. A
     * task-boundary timeout is enough: the trailing keydown, when it exists, is
     * dispatched in the same task as `compositionend`.
     */
    let expiry: ReturnType<typeof setTimeout> | null = null
    const clearExpiry = (): void => {
      if (expiry !== null) {
        clearTimeout(expiry)
        expiry = null
      }
    }
    const open = (): void => {
      composing.current = true
      justEnded.current = false
      clearExpiry()
    }
    const close = (): void => {
      composing.current = false
      justEnded.current = true
      tabEscape.current = false
      // Backstop for the missing-keyup case. `guarded` normally consumes the
      // latch first; this only has to catch the IME that ends a composition
      // without delivering any key event to us afterwards.
      clearExpiry()
      expiry = setTimeout(() => {
        justEnded.current = false
        expiry = null
      }, 0)
    }
    const settle = (): void => {
      justEnded.current = false
      clearExpiry()
    }
    const reset = (): void => {
      composing.current = false
      justEnded.current = false
      tabEscape.current = false
      clearExpiry()
    }
    node.addEventListener('compositionstart', open)
    node.addEventListener('compositionend', close)
    node.addEventListener('keyup', settle)
    window.addEventListener('blur', reset)
    return () => {
      clearExpiry()
      node.removeEventListener('compositionstart', open)
      node.removeEventListener('compositionend', close)
      node.removeEventListener('keyup', settle)
      window.removeEventListener('blur', reset)
    }
  }, [])

  /**
   * Restore the caret an edit asked for once the new value is on screen.
   *
   * The DOM value is compared against what the edit produced before anything is
   * touched: a parent that ignores `onChange`, or one that transforms the value
   * on its way in, must never inherit a stale caret. Dropping the slot instead of
   * keeping it is what stops a much later external change from matching it by
   * accident.
   */
  const applyPending = useCallback((): void => {
    const node = areaRef.current
    const slot = pending.current
    if (node === null || slot === null) return
    if (node.value !== slot.expected) {
      pending.current = null
      return
    }
    pending.current = null
    // Never move a caret mid-composition: the browser owns the selection then,
    // and Safari resets the pinyin buffer when it is moved.
    if (composing.current) return
    if (slot.focus && node.ownerDocument.activeElement !== node) node.focus()
    node.setSelectionRange(slot.start, slot.end)
  }, [])

  useLayoutEffect(() => {
    applyPending()
  }, [applyPending, value])

  /** Grow to the content, up to a share of the viewport, then scroll inside. */
  const measure = useCallback((): void => {
    const node = areaRef.current
    if (node === null) return
    if (fill) {
      // The sheet owns the height in fill mode. Writing an inline height here
      // would fight the flex layout and pin the field to a stale pixel value
      // after every resize, so the inline styles are cleared instead.
      node.style.height = ''
      node.style.overflowY = ''
      return
    }
    const view = node.ownerDocument.defaultView
    const cap = Math.max(MIN_HEIGHT_PX, Math.round((view === null ? 0 : view.innerHeight) * VIEWPORT_SHARE))
    // `height:auto` first: without it scrollHeight is clamped by the current
    // height and the editor can never grow.
    node.style.height = 'auto'
    const border = Math.max(0, node.offsetHeight - node.clientHeight)
    const wanted = node.scrollHeight + border
    // The floor matters for a hidden or detached node (a closed sheet reports
    // every metric as 0) and keeps an empty editor usable.
    node.style.height = `${Math.min(Math.max(wanted, MIN_HEIGHT_PX), cap)}px`
    node.style.overflowY = wanted > cap ? 'auto' : 'hidden'
  }, [fill])

  // Re-measure whenever the value changes, including changes that came from the
  // Host instead of the keyboard.
  useLayoutEffect(() => {
    measure()
  }, [measure, value, disabled])

  useEffect(() => {
    const node = areaRef.current
    if (node === null || fill) return
    let lastWidth = 0
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            // Only a WIDTH change re-wraps the text; height changes are this
            // component's own writes and would otherwise self-trigger.
            const width = Math.round(entries[0]?.contentRect.width ?? 0)
            if (width === lastWidth) return
            lastWidth = width
            measure()
          })
    // The wrapper, not the textarea: observing the node whose height we write is
    // the one way to build a resize loop.
    observer?.observe(node.parentElement ?? node)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [fill, measure])

  useLayoutEffect(() => {
    if (!autoFocus) return
    const node = areaRef.current
    if (node === null) return
    node.focus()
    // Editing an existing note starts at the end; it is the caret most people
    // want after reopening a draft.
    const end = node.value.length
    if (!composing.current) node.setSelectionRange(end, end)
  }, [autoFocus])

  /**
   * Give focus back when the editor is un-hidden.
   *
   * The composer's preview toggle takes focus onto its own button, and the old
   * unmount/remount happened to re-focus the fresh textarea on the way back. Now
   * that the node survives, nothing would: the writer would return to the source
   * view with the caret in place but the keyboard aimed at the toggle. Focus is
   * restored WITHOUT touching the selection — that is the whole point of
   * keeping the node mounted, and writing a range here would undo it.
   */
  const wasHidden = useRef(hidden)
  useLayoutEffect(() => {
    if (wasHidden.current && !hidden) {
      const node = areaRef.current
      if (node !== null && !composing.current) node.focus()
    }
    wasHidden.current = hidden
  }, [hidden])

  /** Hand an edit to the parent and remember the caret it asked for. */
  const commit = useCallback(
    (edit: CaretEdit | null): void => {
      if (edit === null) return
      const node = areaRef.current
      if (node === null) return
      // Refuse rather than silently truncate: losing the tail of a note is worse
      // than a formatting action that did nothing.
      if (maxLength !== undefined && edit.value.length > maxLength) return
      if (edit.value === value) {
        // A no-op action (outdenting a flush line, quoting nothing) still has to
        // keep the caret and the focus where they were, without a pointless
        // write the parent would have to reconcile.
        if (!composing.current) node.setSelectionRange(edit.start, edit.end)
        return
      }
      pending.current = {
        expected: edit.value,
        start: edit.start,
        end: edit.end,
        focus: node.ownerDocument.activeElement === node,
      }
      onChange(edit.value)
    },
    [maxLength, onChange, value],
  )

  /**
   * Save, exactly once per keystroke.
   *
   * `stopPropagation` is not tidiness: the Composer sheet listens for
   * Cmd/Ctrl+Enter on its dialog root, so without it the SAME keypress reached
   * both handlers and `create` ran twice (measured). Stopping here is what makes
   * "one key, one save" true no matter what an ancestor does — and it is why the
   * sheet's own handler can stay as a fallback for presses that land outside the
   * textarea (the title and tag fields).
   */
  function saveOnce(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    event.preventDefault()
    // A held key repeats the keystroke; one save is what the user asked for.
    event.stopPropagation()
    if (!event.repeat) onSave?.()
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    // The guard comes first, for EVERY shortcut: Escape, save, Enter and Tab.
    if (guarded(event)) return
    const node = event.currentTarget
    const modifier = event.metaKey || event.ctrlKey

    // Escape only arms the one-shot Tab hatch; typing anything else in between
    // disarms it, so "Escape, then Tab" is the only way to leave the field.
    if (event.key !== 'Tab' && event.key !== 'Escape') tabEscape.current = false

    if (modifier && (event.key === 's' || event.key === 'S')) {
      // The browser binds this to "save page"; the note's own save owns it here.
      saveOnce(event)
      return
    }

    if (modifier && event.key === 'Enter') {
      saveOnce(event)
      return
    }

    if (event.key === 'Escape') {
      // Arm the keyboard escape hatch before handing over: Tab is swallowed for
      // indentation, so without this a keyboard user could never leave the field.
      tabEscape.current = true
      onEscape?.()
      return
    }

    if (event.key === 'Tab') {
      if (tabEscape.current) {
        tabEscape.current = false
        return
      }
      // Always prevent the default: Tab must indent, never move focus away
      // mid-note.
      event.preventDefault()
      commit(indentSelection(value, node.selectionStart, node.selectionEnd, event.shiftKey ? -1 : 1))
      return
    }

    // Shift+Enter is the writer's explicit "just a newline"; Alt+Enter and the
    // modified forms belong to the browser or to the save shortcut above.
    if (event.key === 'Enter' && !modifier && !event.shiftKey && !event.altKey) {
      const continuation = continueLine(value, node.selectionStart, node.selectionEnd)
      // null means "nothing special about this line": the browser's own newline
      // is the correct behaviour and reimplementing it would only risk the IME.
      if (continuation === null) return
      event.preventDefault()
      commit(continuation)
    }
  }

  /** Keep focus in the textarea while a toolbar button is pressed. */
  function onToolbarMouseDown(event: ReactMouseEvent<HTMLDivElement>): void {
    event.preventDefault()
  }

  function runAction(action: ToolbarAction): void {
    const node = areaRef.current
    if (node === null) return
    commit(action.run({ value, start: node.selectionStart, end: node.selectionEnd, locale }))
  }

  /**
   * The root's visibility.
   *
   * Inline `display:none` rather than the `hidden` attribute: `.skw-ed-root`
   * sets `display: flex` in {@link EDITOR_CSS}, and an author rule beats the UA
   * sheet's `[hidden] { display: none }`, so the attribute alone would leave the
   * editor laid out inside the preview pane (measured: still 884×150).
   */
  const rootStyle: CSSProperties | undefined = hidden ? { display: 'none' } : undefined

  return (
    <div
      className="skw-ed-root"
      style={rootStyle}
      data-hidden={hidden ? 'true' : undefined}
      data-disabled={disabled ? 'true' : undefined}
      data-fill={fill ? 'true' : undefined}
      aria-hidden={hidden ? 'true' : undefined}
    >
      {toolbar && (
        <div
          className="skw-ed-toolbar"
          role="toolbar"
          aria-label={labelOf(TOOLBAR_LABEL)}
          onMouseDown={onToolbarMouseDown}
        >
          {TOOLBAR.map((group) => (
            <div className="skw-ed-group" key={group.id} role="group" aria-label={labelOf(group)}>
              {group.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="skw-ed-btn"
                  data-action={action.id}
                  data-style={action.style}
                  aria-label={labelOf(action)}
                  title={labelOf(action)}
                  disabled={disabled}
                  onClick={() => {
                    runAction(action)
                  }}
                >
                  {action.glyph}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={areaRef}
        className="skw-ed-input"
        value={value}
        // Byte-for-byte write-back. No trim, no newline normalisation, no
        // reformatting of the Markdown: a changed value mid-composition makes
        // Safari reset the pinyin buffer.
        onChange={(event) => {
          onChange(event.target.value)
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        aria-label={label}
        autoComplete="off"
        spellCheck
      />
    </div>
  )
}

/**
 * Editor styles.
 *
 * The host page injects this string once (see `WALL_CSS` in `styles.ts` for the
 * same pattern); it is exported instead of living in the wall stylesheet because
 * the editor is a reusable module. Every colour is a `--dsw-alias-*` theme token
 * so the editor follows the light and dark themes, and every class carries the
 * `skw-ed-` prefix so nothing leaks into product DOM.
 */
export const EDITOR_CSS = `
.skw-ed-root { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.skw-ed-root *, .skw-ed-root *::before, .skw-ed-root *::after { box-sizing: border-box; }
.skw-ed-root[data-disabled="true"] { opacity: .7; }
/* Hidden by the composer's preview toggle. The inline style is what actually
   hides it (an author display rule beats the UA sheet's [hidden] rule, so the
   attribute alone leaves the editor laid out); this rule is the belt to that
   braces for a caller that sets the data attribute without the style. */
.skw-ed-root[data-hidden="true"] { display: none !important; }
/* Fill mode: the sheet gives the editor a box and the editor fills it, so a
   taller sheet means more visible text instead of more empty sheet. */
.skw-ed-root[data-fill="true"] { flex: 1 1 auto; min-height: 0; }
.skw-ed-root[data-fill="true"] .skw-ed-input { flex: 1 1 auto; min-height: 96px; }
.skw-ed-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 1px; padding: 2px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.skw-ed-group { display: inline-flex; align-items: center; gap: 1px; padding: 0 2px; }
.skw-ed-group + .skw-ed-group { border-left: 1px solid var(--dsw-alias-border-l1); }
.skw-ed-btn { min-width: 24px; height: 24px; padding: 0 5px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1; cursor: pointer; }
.skw-ed-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.skw-ed-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.skw-ed-btn[data-style="bold"] { font-weight: 650; }
.skw-ed-btn[data-style="italic"] { font-style: italic; }
.skw-ed-btn[data-style="strike"] { text-decoration: line-through; }
.skw-ed-btn[disabled] { opacity: .45; cursor: default; }
.skw-ed-input { width: 100%; min-height: ${MIN_HEIGHT_PX}px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; resize: none; overflow-y: auto; overflow-x: hidden; }
.skw-ed-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.skw-ed-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.skw-ed-input:disabled { opacity: .7; }
`
