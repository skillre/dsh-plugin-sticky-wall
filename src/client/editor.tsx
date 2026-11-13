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
 * 4. **Tab indent and list continuation** — the two textarea habits every writer
 *    expects, both IME-guarded, with list continuation following the standard
 *    editor behaviour of ending a list on an empty item.
 *
 * The editor is fully controlled: `value` comes from the parent and every edit
 * leaves through `onChange`. It imports nothing but `react` plus its own pure
 * helpers, because the browser module table only resolves `react` — everything
 * else in this file is bundled.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'

/** The two locales the wall ships. */
export type EditorLocale = 'zh' | 'en'

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
  /** Toolbar copy language; defaults to `zh` (the plugin's authoring language). */
  locale?: EditorLocale
}

/** One space pressed by Tab / Shift+Tab. Two spaces is the Markdown convention. */
const INDENT = '  '
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
  /** Visible glyph; keeps the toolbar 24px tall instead of a row of words. */
  glyph: string
  /** Optional CSS styling for glyphs that are meant to look like their effect. */
  style?: 'bold' | 'italic' | 'strike'
  run(ctx: EditContext): CaretEdit | null
}

interface ToolbarGroup extends LabelPair {
  id: string
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
const HEADING_MARKER = /^([ \t]*)(#{1,4})[ \t]+/
const TODO_MARKER = /^([ \t]*)([-*+])[ \t]+\[[ xX]\][ \t]+/
const ORDERED_MARKER = /^([ \t]*)(\d{1,3})([.)])[ \t]+/
const BULLET_MARKER = /^([ \t]*)([-*+])[ \t]+/
const QUOTE_MARKER = /^([ \t]*)>[ \t]?/

/** The line content with its heading, list or quote marker removed. */
function stripBlockMarker(line: string): string {
  for (const marker of [HEADING_MARKER, TODO_MARKER, ORDERED_MARKER, BULLET_MARKER, QUOTE_MARKER]) {
    const match = marker.exec(line)
    // Every marker pattern captures the leading indent, so the slice is always
    // at the marker end and the content keeps no duplicated whitespace.
    if (match !== null) return line.slice(match[0].length)
  }
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

const TOOLBAR_LABEL: LabelPair = { zh: '编辑工具栏', en: 'Formatting toolbar' }

const TOOLBAR: readonly ToolbarGroup[] = [
  {
    id: 'structure',
    zh: '结构',
    en: 'Structure',
    actions: [
      { id: 'h1', zh: '一级标题', en: 'Heading 1', glyph: 'H1', run: applyHeading(1) },
      { id: 'h2', zh: '二级标题', en: 'Heading 2', glyph: 'H2', run: applyHeading(2) },
      { id: 'h3', zh: '三级标题', en: 'Heading 3', glyph: 'H3', run: applyHeading(3) },
      { id: 'quote', zh: '引用', en: 'Blockquote', glyph: '❝', run: applyQuote },
      { id: 'rule', zh: '分割线', en: 'Divider', glyph: '—', run: (ctx) => insertBlock(ctx, '---', 4) },
      { id: 'code-block', zh: '代码块', en: 'Code block', glyph: '{ }', run: insertCodeBlock },
    ],
  },
  {
    id: 'lists',
    zh: '列表',
    en: 'Lists',
    actions: [
      { id: 'bullet', zh: '无序列表', en: 'Bullet list', glyph: '•', run: applyList('bullet') },
      { id: 'ordered', zh: '有序列表', en: 'Numbered list', glyph: '1.', run: applyList('ordered') },
      { id: 'todo', zh: '待办', en: 'Todo', glyph: '☑', run: applyList('todo') },
    ],
  },
  {
    id: 'table',
    zh: '表格',
    en: 'Table',
    actions: [
      {
        id: 'table',
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
    zh: '行内',
    en: 'Inline',
    actions: [
      { id: 'bold', zh: '粗体', en: 'Bold', glyph: 'B', style: 'bold', run: (ctx) => wrapSelection(ctx, '**', '**') },
      { id: 'italic', zh: '斜体', en: 'Italic', glyph: 'I', style: 'italic', run: (ctx) => wrapSelection(ctx, '_', '_') },
      { id: 'strike', zh: '删除线', en: 'Strikethrough', glyph: 'S', style: 'strike', run: (ctx) => wrapSelection(ctx, '~~', '~~') },
      { id: 'code', zh: '行内代码', en: 'Inline code', glyph: '<>', run: (ctx) => wrapSelection(ctx, '`', '`') },
      { id: 'link', zh: '链接', en: 'Link', glyph: '⛓', run: (ctx) => wrapSelection(ctx, '[', '](https://)') },
    ],
  },
  {
    id: 'other',
    zh: '其他',
    en: 'Other',
    actions: [{ id: 'timestamp', zh: '日期时间', en: 'Date and time', glyph: '⌚', run: insertStamp }],
  },
]

// ---------------------------------------------------------------------------
// Tab indent and list continuation.
// ---------------------------------------------------------------------------

/**
 * Tab / Shift+Tab.
 *
 * A bare caret indents its own line rather than inserting whitespace at the
 * caret: a Markdown line's structure lives in its prefix, so "indent" has to mean
 * the line, otherwise the caret would drift into the middle of a nested item
 * while the line itself stayed flat.
 */
function indentSelection(value: string, start: number, end: number, direction: 1 | -1): CaretEdit {
  return rewriteLines(value, start, end, (line) => {
    if (direction === 1) return `${INDENT}${line}`
    // Outdent one indent unit, tolerating a tab or a single stray space so a
    // line someone pasted from elsewhere can still be straightened out.
    if (line.startsWith(INDENT)) return line.slice(INDENT.length)
    if (line.startsWith('\t')) return line.slice(1)
    return line.replace(/^ {1,2}/, '')
  })
}

// Enter inside a list line continues the list. The trailing space is part of the
// marker on purpose: "-" alone is a divider candidate, "- " starts a list.
const CONTINUE_TODO = /^([ \t]*)([-*+])[ \t]+\[[ xX]\][ \t]+/
const CONTINUE_BULLET = /^([ \t]*)([-*+])[ \t]+/
const CONTINUE_ORDERED = /^([ \t]*)(\d{1,3})([.)])[ \t]+/

/**
 * Enter inside a list item: continue it, or end it.
 *
 * Returns null when the caret is not inside a list item, so the caller can let
 * the browser insert a plain newline.
 */
function continueList(value: string, start: number, end: number): CaretEdit | null {
  const line = lineBounds(value, start)
  const text = value.slice(line.from, line.to)
  const todo = CONTINUE_TODO.exec(text)
  const bullet = todo === null ? CONTINUE_BULLET.exec(text) : null
  const ordered = todo === null && bullet === null ? CONTINUE_ORDERED.exec(text) : null
  const marker = (todo ?? bullet ?? ordered)?.[0]
  if (marker === undefined) return null
  // A caret BEFORE the marker is not inside the item; Enter there belongs to the
  // browser, and splitting the line above would surprise the writer.
  if (start - line.from < marker.length) return null

  const body = text.slice(marker.length)
  if (body.trim() === '') {
    // Standard editor behaviour: Enter on an empty item leaves the list instead
    // of stacking another empty bullet nobody will ever fill in.
    return { value: value.slice(0, line.from) + value.slice(line.to), start: line.from, end: line.from }
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
  } = props

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
   * The IME guard, mirrored from DSH's shipped `observeComposition` primitive.
   *
   * `keyCode === 229` is the legacy signal older IMEs send instead of
   * `isComposing`, and `justEnded` covers the keydown some browsers emit after
   * `compositionend` — without it, pressing Enter to commit pinyin would also
   * continue a list.
   */
  const guarded = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    const native = event.nativeEvent
    return composing.current || justEnded.current || native.isComposing || native.keyCode === 229
  }, [])

  // Native listeners, not React props: `keyup` and `blur` never reach a React
  // handler for the textarea, and the latch must close on the browser's own
  // keyup rather than on whichever keydown we happen to see.
  useEffect(() => {
    const node = areaRef.current
    if (node === null) return
    const open = (): void => {
      composing.current = true
      justEnded.current = false
    }
    const close = (): void => {
      composing.current = false
      justEnded.current = true
      tabEscape.current = false
    }
    const settle = (): void => {
      justEnded.current = false
    }
    const reset = (): void => {
      composing.current = false
      justEnded.current = false
      tabEscape.current = false
    }
    node.addEventListener('compositionstart', open)
    node.addEventListener('compositionend', close)
    node.addEventListener('keyup', settle)
    window.addEventListener('blur', reset)
    return () => {
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
      event.preventDefault()
      if (!event.repeat) onSave?.()
      return
    }

    if (modifier && event.key === 'Enter') {
      event.preventDefault()
      if (!event.repeat) onSave?.()
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

    if (event.key === 'Enter' && !modifier && !event.shiftKey && !event.altKey) {
      const continuation = continueList(value, node.selectionStart, node.selectionEnd)
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

  return (
    <div className="skw-ed-root" data-disabled={disabled ? 'true' : undefined} data-fill={fill ? 'true' : undefined}>
      {toolbar && (
        <div
          className="skw-ed-toolbar"
          role="toolbar"
          aria-label={TOOLBAR_LABEL[locale]}
          onMouseDown={onToolbarMouseDown}
        >
          {TOOLBAR.map((group) => (
            <div className="skw-ed-group" key={group.id} role="group" aria-label={group[locale]}>
              {group.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="skw-ed-btn"
                  data-action={action.id}
                  data-style={action.style}
                  aria-label={action[locale]}
                  title={action[locale]}
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
