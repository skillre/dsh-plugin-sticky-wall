/**
 * Markdown rendering: turns the shared parser's blocks into React elements.
 *
 * The PARSER lives in `../markdown-parse.ts` so the Host can reuse it for the
 * card-height estimate. This module owns only the React mapping — and one rule
 * that matters for safety: everything is emitted as elements, never as an HTML
 * string, so a note can never inject markup. Raw HTML stays visible as text on
 * purpose; this is a note wall, not a web page.
 */

import type { ReactNode } from 'react'
import { parseBlocks, safeHref, type Block } from '../markdown-parse.js'

export { parseBlocks, plainTextSummary, safeHref } from '../markdown-parse.js'
export type { Block, ListItem, TableAlign } from '../markdown-parse.js'

// ---------------------------------------------------------------------------
// Inline parsing.
//
// A left-to-right scanner with recursion into the spans it opens, rather than
// the previous "regex match, slice, reset lastIndex" loop. That loop could not
// express three things a writer actually types:
//
// - `***both***`, which came out as `*<strong>both</strong>*`;
// - `snake_case_name`, where `_case_` became italics because a bare `_` pair
//   was treated as emphasis regardless of its neighbours;
// - `\*literal\*`, where the backslash showed up verbatim and the emphasis
//   still applied.
// ---------------------------------------------------------------------------

/** `- [ ] text` / `- [x] text`, matched against a list item's own text. */
const TASK = /^\[([ xX])\][ \t]+([\s\S]*)$/

/** Characters a backslash may escape, per CommonMark's ASCII punctuation set. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>', '~', '|'])

/**
 * The link pattern, matched STICKY at the scanner's own index.
 *
 * Sticky (`y`) with an explicit `lastIndex` replaces `regex.exec(text.slice(index))`,
 * which copied the whole remaining string for every `[` it saw — an O(n) copy per
 * candidate, i.e. quadratic on a body full of unmatched brackets.
 */
const LINK = /\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/y

/** The bare-URL pattern, sticky for the same reason as {@link LINK}. */
const AUTOLINK = /(?:https?:\/\/|www\.)[^\s<>()]+/y

/** Length of the run of `char` starting at `from`. */
function runLength(text: string, from: number, char: string): number {
  let length = 0
  while (text.charAt(from + length) === char) length += 1
  return length
}

/** Whether the character at `at` is alphanumeric (used for `_` word rules). */
function isWordChar(text: string, at: number): boolean {
  const char = text.charAt(at)
  if (char === '') return false
  return /[A-Za-z0-9]/.test(char)
}

/**
 * Find the closing run of `delimiter` at or after `from`.
 *
 * For `_`, a closing delimiter is only valid when it is not followed by a word
 * character, which is what keeps `snake_case_name` literal. An escaped
 * delimiter never closes.
 *
 * `failed` memoises the positions that produced NO closer, which is what keeps
 * this linear. Without it, a run of unmatched openers (`'['.repeat(200_000)`, a
 * legal note body at the documented limit) re-scanned the whole remaining string
 * once per opener: measured 57 SECONDS in jsdom for one card. A position known to
 * have no closer is never re-scanned, and because the search only ever moves
 * forward, the first failure means every later position fails too.
 */
function findClosing(text: string, from: number, delimiter: string, failed?: Set<number>): number {
  if (failed !== undefined && failed.has(from)) return -1
  const char = delimiter.charAt(0)
  const underscore = char === '_'
  let index = from
  while (index < text.length) {
    const found = text.indexOf(delimiter, index)
    if (found === -1) {
      failed?.add(from)
      return -1
    }
    // An escaped delimiter is literal content.
    let backslashes = 0
    for (let probe = found - 1; probe >= 0 && text.charAt(probe) === '\\'; probe -= 1) backslashes += 1
    if (backslashes % 2 === 1) {
      index = found + delimiter.length
      continue
    }
    if (underscore && isWordChar(text, found + delimiter.length)) {
      index = found + delimiter.length
      continue
    }
    // A longer run than the delimiter means this is a different construct.
    if (runLength(text, found, char) < delimiter.length) {
      index = found + 1
      continue
    }
    return found
  }
  failed?.add(from)
  return -1
}

/**
 * Render one line's inline constructs into React nodes.
 *
 * Exported because the block renderer and the tests both need it; `keyPrefix`
 * only has to be unique within one parent, which is what React requires.
 *
 * Every scan here is bounded so the cost stays linear in the text length:
 * - a failed closer is remembered per delimiter ({@link findClosing}), so a run
 *   of unmatched openers costs one scan instead of one scan each;
 * - the link and autolink patterns run STICKY against the whole string instead of
 *   `slice(index)`-ing the remainder, which allocated an O(n) copy per candidate
 *   and was the other half of the quadratic behaviour.
 */
export function renderInline(text: string, keyPrefix = 'i', inLink = false): ReactNode[] {
  const nodes: ReactNode[] = []
  let buffer = ''
  let counter = 0
  let index = 0
  /** Positions already known to have no closer, per delimiter. */
  const failedClosers = new Map<string, Set<number>>()
  /** The memo for one delimiter. */
  const failedFor = (delimiter: string): Set<number> => {
    let set = failedClosers.get(delimiter)
    if (set === undefined) {
      set = new Set<number>()
      failedClosers.set(delimiter, set)
    }
    return set
  }

  const nextKey = (): string => `${keyPrefix}-${counter++}`
  /** Push the pending literal text, splitting newlines into real breaks. */
  const flush = (): void => {
    if (buffer === '') return
    const parts = buffer.split('\n')
    parts.forEach((part, position) => {
      if (part !== '') nodes.push(part)
      if (position < parts.length - 1) nodes.push(<br key={nextKey()} />)
    })
    buffer = ''
  }

  while (index < text.length) {
    const char = text.charAt(index)

    // ---- Backslash escape ------------------------------------------------
    if (char === '\\') {
      const escaped = text.charAt(index + 1)
      if (ESCAPABLE.has(escaped)) {
        buffer += escaped
        index += 2
        continue
      }
    }

    // ---- Code span -------------------------------------------------------
    if (char === '`') {
      const open = runLength(text, index, '`')
      const closing = findClosing(text, index + open, '`'.repeat(open), failedFor('`'.repeat(open)))
      if (closing !== -1) {
        flush()
        const inner = text.slice(index + open, closing)
        // CommonMark strips one leading and trailing space so `` ` ` `` can hold
        // a backtick; a span that is all spaces keeps them.
        const trimmed = inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ')
          ? inner.slice(1, -1)
          : inner
        nodes.push(<code key={nextKey()} className="skw-md-code">{trimmed}</code>)
        index = closing + open
        continue
      }
      buffer += '`'.repeat(open)
      index += open
      continue
    }

    // ---- Strong + emphasis -----------------------------------------------
    // The delimiter RUN length decides which construct is even a candidate:
    // `***` is strong+emphasis, `**` is strong, `*` is emphasis. Deciding by run
    // length is what stops `**bold` (an unmatched strong run) from being read as
    // an empty emphasis followed by the word, and it is also why `***both***`
    // no longer leaves a stray asterisk on each side.
    if (char === '*' || char === '_') {
      const run = runLength(text, index, char)
      // An opening `_` may not follow a word character, and its closer may not
      // precede one; that pair of rules is the whole `snake_case_name` fix.
      const opens = char !== '_' || !isWordChar(text, index - 1)

      if (opens && run >= 3) {
        const delimiter = char.repeat(3)
        const closing = findClosing(text, index + 3, delimiter, failedFor(delimiter))
        if (closing > index + 3) {
          flush()
          nodes.push(
            <strong key={nextKey()}>
              <em>{renderInline(text.slice(index + 3, closing), `${keyPrefix}-se`)}</em>
            </strong>,
          )
          index = closing + 3
          continue
        }
      }

      if (opens && run >= 2) {
        const delimiter = char + char
        const closing = findClosing(text, index + 2, delimiter, failedFor(delimiter))
        // `closing > index + 2` refuses an EMPTY span. `**` alone is not empty
        // emphasis; it is two literal asterisks the user is still typing.
        if (closing > index + 2) {
          flush()
          nodes.push(
            <strong key={nextKey()}>{renderInline(text.slice(index + 2, closing), `${keyPrefix}-s`)}</strong>,
          )
          index = closing + 2
          continue
        }
      }

      if (opens && run === 1) {
        const closing = findClosing(text, index + 1, char, failedFor(char))
        if (closing > index + 1) {
          flush()
          nodes.push(<em key={nextKey()}>{renderInline(text.slice(index + 1, closing), `${keyPrefix}-e`)}</em>)
          index = closing + 1
          continue
        }
      }

      // No construct opened here: emit the whole run literally and move past it,
      // so the scan can never stall on the same delimiter.
      buffer += char.repeat(run)
      index += run
      continue
    }

    // ---- Strikethrough ---------------------------------------------------
    if (char === '~' && text.startsWith('~~', index)) {
      const closing = findClosing(text, index + 2, '~~', failedFor('~~'))
      if (closing > index + 2) {
        flush()
        nodes.push(<s key={nextKey()}>{renderInline(text.slice(index + 2, closing), `${keyPrefix}-d`)}</s>)
        index = closing + 2
        continue
      }
    }

    // ---- Link ------------------------------------------------------------
    // A link label is rendered inline, but a link inside a link is invalid HTML
    // (`<a>` cannot nest): React warns and the browser un-nests it, so
    // `[https://a.com](https://b.com)` produced broken markup. Inside a label the
    // autolink and link branches are therefore skipped.
    if (char === '[' && !inLink) {
      // The target may contain one level of balanced parentheses, which is what
      // a Wikipedia-style URL needs; without it `[x](a(b)c)` leaked a trailing
      // `)` into the visible text.
      //
      // The `]` is located with `indexOf` FIRST. Running the pattern directly is
      // quadratic on a body full of unmatched brackets: `[^\]]*` has to scan to
      // the end of the string before it can fail, once per `[` — 57 seconds for
      // 200k brackets, which is a legal note body. A single `indexOf` is a plain
      // memory scan, and the pattern only runs where a `](` actually exists.
      const close = text.indexOf(']', index + 1)
      const match = close === -1 || text.charAt(close + 1) !== '('
        ? null
        : (LINK.lastIndex = index, LINK.exec(text))
      if (match !== null) {
        flush()
        const label = match[1] ?? ''
        const href = safeHref(match[2] ?? '')
        nodes.push(
          href === undefined ? (
            <span key={nextKey()}>{label}</span>
          ) : (
            <a key={nextKey()} className="skw-md-link" href={href} target="_blank" rel="noreferrer noopener">
              {renderInline(label, `${keyPrefix}-l`, true)}
            </a>
          ),
        )
        index += match[0].length
        continue
      }
    }

    // ---- Bare autolink ---------------------------------------------------
    if (!inLink && (char === 'h' || char === 'w')) {
      AUTOLINK.lastIndex = index
      const match = AUTOLINK.exec(text)
      if (match !== null) {
        // Trailing punctuation belongs to the sentence, not to the URL.
        const raw = match[0]
        const trimmed = raw.replace(/[.,;:!?]+$/, '')
        const href = safeHref(trimmed)
        if (href !== undefined) {
          flush()
          nodes.push(
            <a key={nextKey()} className="skw-md-link" href={href} target="_blank" rel="noreferrer noopener">
              {trimmed}
            </a>,
          )
          index += trimmed.length
          continue
        }
      }
    }

    buffer += char
    index += 1
  }

  flush()
  return nodes
}

/** Render a `- [ ]` / `- [x]` list item's checkbox as a static glyph. */
function renderTask(item: string, key: string): ReactNode {
  const match = TASK.exec(item)
  if (match === null) return renderInline(item, key)
  const checked = (match[1] ?? ' ') !== ' '
  return (
    <span key={key} className="skw-md-task" data-checked={checked}>
      <span className="skw-md-box" aria-hidden="true">{checked ? '✓' : ''}</span>
      {renderInline(match[2] ?? '', `${key}t`)}
    </span>
  )
}

/** Render one parsed block, recursing into quotes and nested list items. */
function renderBlock(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case 'heading': {
      // A note is a card, not a page: `#` maps to h3 so a note heading can never
      // outrank the shell's own title in the accessibility tree.
      const Tag = (`h${Math.min(block.level + 2, 6)}`) as 'h3'
      return (
        <Tag key={key} className="skw-md-heading">
          {renderInline(block.text, `${key}h`)}
        </Tag>
      )
    }
    case 'code':
      return (
        <pre key={key} className="skw-md-pre" data-language={block.language === '' ? undefined : block.language}>
          <code>{block.text}</code>
        </pre>
      )
    case 'indentedCode':
      return (
        <pre key={key} className="skw-md-pre">
          <code>{block.text}</code>
        </pre>
      )
    case 'quote':
      return (
        <blockquote key={key} className="skw-md-quote">
          {block.children.map((child, position) => renderBlock(child, `${key}q${position}`))}
        </blockquote>
      )
    case 'rule':
      return <hr key={key} className="skw-md-rule" />
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag key={key} className="skw-md-list" start={block.ordered && block.start !== 1 ? block.start : undefined}>
          {block.items.map((item, position) => {
            const itemKey = `${key}-${position}`
            const hasChildren = item.children.length > 0
            return (
              <li key={itemKey}>
                {item.text === '' ? null : renderTask(item.text, `${itemKey}t`)}
                {hasChildren
                  ? item.children.map((child, childIndex) => renderBlock(child, `${itemKey}c${childIndex}`))
                  : null}
              </li>
            )
          })}
        </Tag>
      )
    }
    case 'table':
      return (
        <table key={key} className="skw-md-table">
          <thead>
            <tr>
              {block.header.map((cell, position) => {
                const align = block.align[position] ?? null
                return (
                  <th key={`${key}-h-${position}`} style={align === null ? undefined : { textAlign: align }}>
                    {renderInline(cell, `${key}h${position}`)}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${key}-r-${rowIndex}`}>
                {row.map((cell, position) => {
                  const align = block.align[position] ?? null
                  return (
                    <td key={`${key}-r-${rowIndex}-${position}`} style={align === null ? undefined : { textAlign: align }}>
                      {renderInline(cell, `${key}r${rowIndex}${position}`)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'paragraph':
    default:
      return (
        <p key={key} className="skw-md-p">
          {renderInline(block.text, `${key}p`)}
        </p>
      )
  }
}

/**
 * Render a note body as Markdown.
 *
 * `compact` drops the outer wrapper's paragraph margins so a two-line note
 * stays two lines tall on the canvas instead of gaining block spacing.
 *
 * A parse failure degrades to the raw source rather than throwing: a card is
 * one of hundreds on the wall, and a renderer that throws takes the whole
 * sidebar down with it.
 */
export function Markdown({ source, compact = false }: { source: string; compact?: boolean }): JSX.Element {
  let blocks: Block[]
  try {
    blocks = parseBlocks(source)
  } catch {
    return (
      <div className="skw-md" data-compact={compact}>
        <p className="skw-md-p">{typeof source === 'string' ? source : ''}</p>
      </div>
    )
  }
  return (
    <div className="skw-md" data-compact={compact}>
      {blocks.map((block, index) => renderBlock(block, `b${index}`))}
    </div>
  )
}
