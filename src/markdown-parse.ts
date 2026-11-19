/**
 * The Markdown block and inline parser, shared by both halves of the plugin.
 *
 * This module is deliberately React-free and DOM-free: the Client renders what
 * it produces, and the Host's `estimateHeight` (src/layout.ts) walks the same
 * structure to predict a card's rendered height. Keeping ONE parser is what
 * makes the estimate and the render agree — a second, string-based guess is
 * exactly how a tidied wall ends up with overlapping cards.
 *
 * The supported subset is a sticky note's, not a document's: ATX headings,
 * paragraphs, emphasis/code/strike, fenced and indented code, nested ordered and
 * unordered lists with `- [ ]` checkboxes, nested block quotes, rules, pipe
 * tables with column alignment, and http(s)/mailto links.
 *
 * ## The two invariants that keep this parser honest
 *
 * 1. **Indentation is structure, never noise.** Every block marker is matched
 *    against the line with its leading whitespace removed, so `  > quote` and
 *    `> quote` are the same construct. Matching the raw line for one and the
 *    trimmed line for the other is what used to make this parser loop forever on
 *    an indented quote.
 * 2. **Every step advances.** {@link parseOne} returns the index to resume at,
 *    and {@link parseRange} forces `index + 1` if a step ever returns a
 *    non-advancing index. A render loop that stops advancing is not a visible
 *    bug on a sticky note: it is a frozen sidebar.
 */

/** Column width of one nesting level. The editor's Tab inserts exactly this. */
export const INDENT_WIDTH = 2

/** Leading whitespace, in columns, that starts an indented code block. */
const CODE_INDENT = 4

/**
 * Maximum block nesting depth this parser will descend into.
 *
 * Nesting is recursive (a quote holds blocks, a list item holds blocks), so an
 * adversarial document — 4000 lines each opening one more `>`, which is 200 KB of
 * entirely legal input — would otherwise recurse 4000 frames deep and cost
 * quadratic time re-measuring the same tail at every level. Real notes nest three
 * or four levels. Beyond this cap the remaining lines are kept as literal text,
 * so nothing is lost: the note still renders, just without infinite indentation.
 */
const MAX_DEPTH = 12

/**
 * Upper bound on the steps one parse may take.
 *
 * Not a product limit: it is the backstop that turns a hypothetical parser
 * defect into a truncated render instead of a hung tab. One line can legitimately
 * produce a handful of steps (a quote containing a list containing a quote), so
 * the budget scales with the input rather than being a flat constant.
 */
function stepBudget(lineCount: number): number {
  return Math.max(1_000, lineCount * 64)
}

/** One table cell's horizontal alignment, as declared by the divider row. */
export type TableAlign = 'left' | 'center' | 'right' | null

/** One list item: its own text plus any blocks nested under it. */
export interface ListItem {
  /** The item's text, without its marker. May contain `\n` for continuation lines. */
  text: string
  /** Nested blocks: a deeper list, a paragraph, a code block, another quote. */
  children: Block[]
}

/** One parsed block of a note body. */
export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string; language: string }
  | { kind: 'indentedCode'; text: string }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'rule' }
  | { kind: 'table'; header: string[]; rows: string[][]; align: TableAlign[] }

/** A fence of three or more backticks or tildes, plus an optional info string. */
const FENCE = /^(`{3,}|~{3,})\s*(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const RULE = /^(?:[-*_][ \t]*){3,}$/
const BULLET = /^([-*+])[ \t]+(.*)$/
const ORDERED = /^(\d{1,9})[.)][ \t]+(.*)$/
const QUOTE = /^>[ \t]?(.*)$/
/** `- [ ] text` / `- [x] text`, matched against a list item's own text. */
const TASK = /^\[([ xX])\][ \t]+([\s\S]*)$/
/** A table divider cell: `---`, `:---`, `---:`, `:---:`. */
const TABLE_DIVIDER = /^\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/

/** A line split into its leading whitespace and the rest. */
interface Line {
  /** The line exactly as written, used for code content. */
  raw: string
  /** Leading whitespace measured in columns; a tab counts as {@link INDENT_WIDTH}. */
  indent: number
  /** The line with its leading whitespace removed. Every block marker matches this. */
  body: string
}

/** Measure leading whitespace in columns and split the line. */
function toLine(raw: string): Line {
  let width = 0
  let index = 0
  while (index < raw.length) {
    const char = raw[index]
    if (char === ' ') width += 1
    else if (char === '\t') width += INDENT_WIDTH
    else break
    index += 1
  }
  return { raw, indent: width, body: raw.slice(index) }
}

/** Remove up to `width` columns of leading whitespace. */
function stripColumns(raw: string, width: number): string {
  let consumed = 0
  let index = 0
  while (index < raw.length && consumed < width) {
    const char = raw[index]
    if (char === ' ') {
      consumed += 1
      index += 1
    } else if (char === '\t') {
      consumed += INDENT_WIDTH
      index += 1
    } else break
  }
  return raw.slice(index)
}

/** Whether a (whitespace-stripped) line opens a block of its own. */
function startsBlock(body: string): boolean {
  return (
    FENCE.test(body) ||
    HEADING.test(body) ||
    RULE.test(body) ||
    BULLET.test(body) ||
    ORDERED.test(body) ||
    QUOTE.test(body) ||
    TABLE_DIVIDER.test(body)
  )
}

/** Split a table row on pipes, dropping the optional leading/trailing pipe. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

/** Read a divider row's column alignment. */
function parseAlign(divider: string): TableAlign[] {
  return splitRow(divider).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

/** Whether a table starts at `at`: a pipe row immediately followed by a divider. */
function tableAt(lines: Line[], at: number, to: number): boolean {
  if (at + 1 >= to) return false
  const header = lines[at]
  const divider = lines[at + 1]
  if (header === undefined || divider === undefined) return false
  return header.body.includes('|') && TABLE_DIVIDER.test(divider.body)
}

/**
 * Parse exactly one block starting at `index`, pushing it onto `blocks` and
 * returning the index to resume at.
 *
 * The contract is that the returned index is ALWAYS greater than `index` for
 * every input this function accepts — that is what makes the caller's loop
 * terminate. Callers must not pass an index whose line is blank; the caller
 * consumes blank lines itself.
 */
function parseOne(lines: Line[], index: number, to: number, blocks: Block[], depth: number): number {
  const line = lines[index]
  if (line === undefined) return index + 1

  // Nesting cap. Past MAX_DEPTH the remaining lines are emitted as one literal
  // paragraph instead of recursing further: a note that deep is not content a
  // person wrote, and quadratic time on 200 KB of `>>>>>>>>` would freeze the
  // sidebar just as effectively as the old infinite loop.
  if (depth >= MAX_DEPTH) {
    const literal: string[] = []
    let cursor = index
    while (cursor < to) {
      const candidate = lines[cursor]
      if (candidate === undefined) break
      literal.push(candidate.body)
      cursor += 1
    }
    const text = literal.join('\n').trim()
    if (text !== '') blocks.push({ kind: 'paragraph', text })
    return to
  }

  // ---- Fenced code --------------------------------------------------------
  const fence = FENCE.exec(line.body)
  if (fence !== null) {
    const marker = fence[1] ?? '```'
    const char = marker.charAt(0)
    // The info string may carry attributes (`js title=x`); the first word is the
    // language. Accepting the whole string as the language was a real defect:
    // the fence stopped being recognised, so the code leaked out as a paragraph.
    const info = (fence[2] ?? '').trim()
    const language = info === '' ? '' : (info.split(/[\s{]/)[0] ?? '')
    const body: string[] = []
    let cursor = index + 1
    while (cursor < to) {
      const candidate = lines[cursor]
      if (candidate === undefined) break
      const closing = FENCE.exec(candidate.body)
      if (closing !== null) {
        const closingMarker = closing[1] ?? ''
        if (closingMarker.charAt(0) === char && closingMarker.length >= marker.length) break
      }
      // Code indentation is content, so the raw line is used — minus the fence's
      // own indent, so an indented fence keeps its code flush.
      body.push(stripColumns(candidate.raw, line.indent))
      cursor += 1
    }
    blocks.push({ kind: 'code', text: body.join('\n'), language })
    // An unterminated fence still renders as code; the user is mid-typing.
    return cursor < to ? cursor + 1 : to
  }

  // ---- Heading ------------------------------------------------------------
  const heading = HEADING.exec(line.body)
  if (heading !== null) {
    const level = Math.min(6, (heading[1] ?? '#').length) as 1 | 2 | 3 | 4 | 5 | 6
    blocks.push({ kind: 'heading', level, text: (heading[2] ?? '').trim() })
    return index + 1
  }

  // ---- Horizontal rule ----------------------------------------------------
  if (RULE.test(line.body)) {
    blocks.push({ kind: 'rule' })
    return index + 1
  }

  // ---- Block quote (nested) ----------------------------------------------
  if (QUOTE.test(line.body)) {
    const inner: Line[] = []
    let cursor = index
    while (cursor < to) {
      const candidate = lines[cursor]
      if (candidate === undefined) break
      const match = QUOTE.exec(candidate.body)
      if (match !== null) {
        // Strip exactly one `>` level and re-measure: `> > x` becomes `> x`, so
        // the recursive call sees the nested quote as a quote.
        inner.push(toLine(match[1] ?? ''))
        cursor += 1
        continue
      }
      if (candidate.body === '') {
        // A blank line only keeps the quote open when another quoted line
        // follows; otherwise the quote has ended.
        let probe = cursor
        while (probe < to && lines[probe]?.body === '') probe += 1
        const next = lines[probe]
        if (next !== undefined && QUOTE.test(next.body)) {
          for (let blank = cursor; blank < probe; blank += 1) inner.push(toLine(''))
          cursor = probe
          continue
        }
      }
      break
    }
    blocks.push({ kind: 'quote', children: parseRange(inner, 0, inner.length, depth + 1) })
    // The first line matched QUOTE, so `cursor` is at least index + 1.
    return Math.max(cursor, index + 1)
  }

  // ---- Table --------------------------------------------------------------
  if (tableAt(lines, index, to)) {
    const header = splitRow(line.body)
    const divider = lines[index + 1]
    const align = parseAlign(divider === undefined ? '' : divider.body)
    const rows: string[][] = []
    let cursor = index + 2
    while (cursor < to) {
      const candidate = lines[cursor]
      if (candidate === undefined) break
      if (candidate.body === '' || !candidate.body.includes('|')) break
      // A row that opens another block is not a table row.
      if (startsBlock(candidate.body) && !TABLE_DIVIDER.test(candidate.body)) break
      rows.push(splitRow(candidate.body))
      cursor += 1
    }
    blocks.push({ kind: 'table', header, rows, align })
    return cursor
  }

  // ---- List (nested) ------------------------------------------------------
  const bullet = BULLET.exec(line.body)
  const ordered = bullet === null ? ORDERED.exec(line.body) : null
  if (bullet !== null || ordered !== null) {
    const isOrdered = ordered !== null
    const start = isOrdered ? Number(ordered[1] ?? '1') : 1
    const baseIndent = line.indent
    const items: ListItem[] = []
    let cursor = index

    while (cursor < to) {
      const candidate = lines[cursor]
      if (candidate === undefined) break
      // A sibling item sits at exactly the list's own indent.
      if (candidate.indent !== baseIndent) break
      const marker = isOrdered ? ORDERED.exec(candidate.body) : BULLET.exec(candidate.body)
      if (marker === null) break

      let paragraph = marker[2] ?? ''
      const nested: string[] = []
      /** Whether a blank line has separated the item's own text from its children. */
      let separated = false
      let probe = cursor + 1

      while (probe < to) {
        const next = lines[probe]
        if (next === undefined) break
        if (next.body === '') {
          // A blank line ends the item unless indented content follows.
          let ahead = probe
          while (ahead < to && lines[ahead]?.body === '') ahead += 1
          const resumed = lines[ahead]
          if (resumed !== undefined && resumed.indent >= baseIndent + INDENT_WIDTH) {
            for (let blank = probe; blank < ahead; blank += 1) nested.push('')
            separated = true
            probe = ahead
            continue
          }
          break
        }
        // Anything indented under the marker belongs to this item.
        if (next.indent < baseIndent + INDENT_WIDTH) break
        const deindented = stripColumns(next.raw, baseIndent + INDENT_WIDTH)
        const deLine = toLine(deindented)
        if (!separated && nested.length === 0 && !startsBlock(deLine.body)) {
          // A plain continuation line joins the item's own paragraph, exactly as
          // CommonMark folds it in. Treating it as a separate block is what used
          // to split `- item\n  continued` into three blocks.
          paragraph = paragraph === '' ? deLine.body : `${paragraph}\n${deLine.body}`
          probe += 1
          continue
        }
        nested.push(deindented)
        probe += 1
      }

      items.push({
        text: paragraph,
        children: nested.length > 0 ? parseRange(nested.map(toLine), 0, nested.length, depth + 1) : [],
      })
      cursor = probe

      // A blank line may separate two items of the SAME list (a "loose" list).
      // Skipping it keeps one list instead of producing one list per item.
      let skip = cursor
      while (skip < to && lines[skip]?.body === '') skip += 1
      const sibling = lines[skip]
      if (sibling !== undefined && sibling.indent === baseIndent) {
        const siblingMarker = isOrdered ? ORDERED.exec(sibling.body) : BULLET.exec(sibling.body)
        if (siblingMarker !== null) {
          cursor = skip
          continue
        }
      }
      break
    }

    blocks.push({ kind: 'list', ordered: isOrdered, start, items })
    // Each iteration consumed at least its own marker line.
    return Math.max(cursor, index + 1)
  }

  // ---- Indented code ------------------------------------------------------
  // Only at the top of a document or after a blank line, and only outside a
  // list, so indentation that merely aligns text is never mistaken for code.
  const previous = index > 0 ? lines[index - 1] : undefined
  if (line.indent >= CODE_INDENT && (previous === undefined || previous.body === '')) {
    const body: string[] = []
    let cursor = index
    let lastContent = index
    while (cursor < to) {
      const candidate = lines[cursor]
      if (candidate === undefined) break
      if (candidate.body === '') {
        body.push('')
        cursor += 1
        continue
      }
      if (candidate.indent < CODE_INDENT) break
      body.push(stripColumns(candidate.raw, CODE_INDENT))
      lastContent = cursor
      cursor += 1
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    blocks.push({ kind: 'indentedCode', text: body.join('\n') })
    return lastContent + 1
  }

  // ---- Paragraph ----------------------------------------------------------
  const body: string[] = [line.body]
  let cursor = index + 1
  while (cursor < to) {
    const next = lines[cursor]
    if (next === undefined) break
    if (next.body === '') break
    if (startsBlock(next.body)) break
    // A pipe row that a divider follows is a table header, not prose.
    if (tableAt(lines, cursor, to)) break
    body.push(next.body)
    cursor += 1
  }
  blocks.push({ kind: 'paragraph', text: body.join('\n') })
  return cursor
}

/**
 * Parse a range of lines into blocks.
 *
 * The loop is deliberately defensive: {@link parseOne} must advance, and the
 * `next <= index` guard forces progress even if a future edit breaks that
 * contract. Silently truncating one block is infinitely better than freezing
 * the sidebar, which is what the previous implementation did.
 */
function parseRange(lines: Line[], from: number, to: number, depth: number): Block[] {
  const blocks: Block[] = []
  let index = from
  const budget = stepBudget(Math.max(1, to - from))

  for (let step = 0; index < to; step += 1) {
    if (step > budget) break
    const line = lines[index]
    if (line === undefined) break
    if (line.body === '') {
      index += 1
      continue
    }
    const next = parseOne(lines, index, to, blocks, depth)
    index = next > index ? next : index + 1
  }

  return blocks
}

/**
 * Parse a note body into blocks.
 *
 * Exported so the parser is unit-testable without a DOM, and so a future
 * "copy as plain text" action can reuse the same structure.
 */
export function parseBlocks(source: string): Block[] {
  const text = typeof source === 'string' ? source : ''
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(toLine)
  return parseRange(lines, 0, lines.length, 0)
}

/**
 * Strip inline Markdown syntax while keeping the text it wraps.
 *
 * This is deliberately NOT a second parser. `parseBlocks` already decided what
 * the block IS; this only has to erase the characters that are syntax rather
 * than content, so a digest can never drift from what the card renders. Bare
 * URLs are left alone on purpose: a URL is the one inline construct whose
 * visible text is the whole token, so stripping it would delete information.
 */
function stripInlineMarkdown(text: string): string {
  let out = text
  // Backslash escapes first: an escaped marker is literal content, and erasing
  // the backslash later would turn `\*x\*` into emphasis in the digest.
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
  // Images first: their alt text is the closest thing to content they carry.
  out = out.replace(/!\[([^\]]*)\]\([^)\s]*\)/g, '$1')
  // `[label](url)` becomes just the label.
  out = out.replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1')
  // Code spans: drop the backticks, keep what they wrap.
  out = out.replace(/`+([^`]*)`+/g, '$1')
  // Longest emphasis markers first, so `***x***` never loses only half a pair.
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1')
  out = out.replace(/\*([^*]+)\*/g, '$1')
  out = out.replace(/~~([^~]+)~~/g, '$1')
  // Underscore emphasis only between word boundaries: `snake_case_name` is an
  // identifier, not italics, and a digest of a code-heavy note must say so.
  out = out.replace(/(^|[^A-Za-z0-9])___([^_]+)___(?![A-Za-z0-9])/g, '$1$2')
  out = out.replace(/(^|[^A-Za-z0-9])__([^_]+)__(?![A-Za-z0-9])/g, '$1$2')
  out = out.replace(/(^|[^A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g, '$1$2')
  return out
}

/** Collapse every whitespace run to one space and trim both edges. */
function flattenWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Cut a digest to `limit` characters, appending the ellipsis.
 *
 * The ellipsis sits OUTSIDE the budget so `max` always means "characters of the
 * note that survive", which is what a CSS-clamped row needs. The trailing space
 * of a break-at-a-space cut is dropped so the result never reads "word …".
 */
function truncateDigest(text: string, limit: number): string {
  if (text.length <= limit) return text
  let cut = limit
  // `slice` counts UTF-16 units, so a cut can land between the two halves of an
  // emoji and leave a lone surrogate that renders as a replacement glyph. Back
  // off one unit when the boundary splits a pair.
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return `${text.slice(0, cut).replace(/\s+$/, '')}…`
}

/** The first visible text inside a block, or `''` when it carries none. */
function firstVisibleText(block: Block): string {
  switch (block.kind) {
    case 'rule':
      return ''
    case 'code':
    case 'indentedCode':
      // Code that opens a note is usually the point of the note, and one line is
      // all a card or a row can honestly show.
      return block.text.split('\n')[0] ?? ''
    case 'table':
      return block.header.join(' ')
    case 'quote': {
      for (const child of block.children) {
        const text = firstVisibleText(child)
        if (text !== '') return text
      }
      return ''
    }
    case 'list': {
      for (const item of block.items) {
        const own = item.text.replace(/^\[[ xX]\]\s*/, '')
        if (own !== '') return own
        // An item with only nested content still describes the note.
        for (const child of item.children) {
          const text = firstVisibleText(child)
          if (text !== '') return text
        }
      }
      return ''
    }
    case 'heading':
    case 'paragraph':
    default:
      return block.text
  }
}

/**
 * One plain-text digest of a note, for lists, aria-labels and search.
 * Strips Markdown syntax: no `##`, no `**`, no `- [ ]`, no ``` fences, no pipes.
 *
 * The FIRST block that yields visible text wins, because a digest is one line:
 * a rule carries none, and an empty heading or paragraph is what a half-typed
 * note looks like. Picking the first *visible* block means a note that opens
 * with `---` still summarises its actual first line instead of returning ''.
 */
export function plainTextSummary(source: string, max = 90): string {
  // A caller asking for zero characters gets nothing: returning the ellipsis
  // alone would claim the note has content it does not.
  const limit = Number.isFinite(max) ? Math.floor(max) : 0
  if (limit <= 0) return ''

  const raw = typeof source === 'string' ? source : ''

  let blocks: Block[]
  try {
    blocks = parseBlocks(raw)
  } catch {
    // A digest is decoration on a list row, so it must never be the thing that
    // breaks a render: degrade to the raw text rather than throwing.
    return truncateDigest(flattenWhitespace(stripInlineMarkdown(raw)), limit)
  }

  for (const block of blocks) {
    const candidate = firstVisibleText(block)
    const digest = flattenWhitespace(stripInlineMarkdown(candidate))
    // An empty heading/paragraph (or an empty first list item) has no visible
    // text, so the search continues instead of stopping on ''.
    if (digest !== '') return truncateDigest(digest, limit)
  }

  return ''
}

/**
 * Normalize a link target.
 *
 * Only http(s) and mailto survive. A `javascript:` or `data:` URL degrades to
 * plain text, so a note pasted from somewhere hostile cannot become a live
 * script URL in the shell's DOM.
 */
export function safeHref(raw: string): string | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  if (/^(?:https?|mailto):/i.test(value)) return value
  if (/^www\./i.test(value)) return `https://${value}`
  return undefined
}

