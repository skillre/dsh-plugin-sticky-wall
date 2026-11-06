/**
 * A small, self-contained Markdown renderer for note bodies.
 *
 * Why not a library: the browser half may only `require()` the platform module
 * table (react, react/jsx-runtime, …). Every other dependency has to be bundled
 * by esbuild, and a full CommonMark engine would add hundreds of kilobytes to a
 * sidebar plugin for the handful of constructs people actually type on a
 * sticky note. So this module implements a deliberate subset and renders it
 * directly to React elements:
 *
 * - ATX headings (`#`…`####`) and setext-free single-line headings;
 * - paragraphs, hard line breaks;
 * - `**bold**`, `*italic*`, `_italic_`, `` `code` ``, `~~strike~~`;
 * - fenced code blocks (``` and ~~~) and indented-free inline code;
 * - unordered (`-`, `*`, `+`) and ordered (`1.`) lists, plus `- [ ]` checkboxes;
 * - block quotes (`> `), horizontal rules (`---`), and pipe tables;
 * - links `[text](url)` and bare autolinks, restricted to http(s)/mailto.
 *
 * Everything is emitted as React elements — never as an HTML string — so a
 * note can never inject markup, and a malformed construct degrades to the
 * literal text the user typed instead of vanishing. Raw HTML in a note stays
 * visible as text on purpose: this is a note wall, not a web page.
 */

import type { ReactNode } from 'react'

/** One parsed block of a note body. */
export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string; language: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'rule' }
  | { kind: 'table'; header: string[]; rows: string[][] }

const FENCE = /^(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/
const HEADING = /^(#{1,4})\s+(.*)$/
const RULE = /^(?:[-*_]\s*){3,}$/
const BULLET = /^[-*+]\s+(.*)$/
const ORDERED = /^\d{1,3}[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const TABLE_DIVIDER = /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** Split a table row on pipes, dropping the optional leading/trailing pipe. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

/**
 * Parse a note body into blocks.
 *
 * Exported so the parser is unit-testable without a DOM, and so a future
 * "copy as plain text" action can reuse the same structure.
 */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }

    const fence = line.trim().match(FENCE)
    if (fence !== null) {
      const marker = fence[1] ?? '```'
      const language = fence[2] ?? ''
      const body: string[] = []
      index += 1
      while (index < lines.length && (lines[index] ?? '').trim() !== marker) {
        body.push(lines[index] ?? '')
        index += 1
      }
      // An unterminated fence still renders as code; the user is mid-typing.
      if (index < lines.length) index += 1
      blocks.push({ kind: 'code', text: body.join('\n'), language })
      continue
    }

    const heading = line.match(HEADING)
    if (heading !== null) {
      const level = Math.min(4, (heading[1] ?? '#').length) as 1 | 2 | 3 | 4
      blocks.push({ kind: 'heading', level, text: (heading[2] ?? '').trim() })
      index += 1
      continue
    }

    if (RULE.test(line.trim())) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    if (QUOTE.test(line.trim())) {
      const body: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const match = current.match(QUOTE)
        if (match === null) break
        body.push(match[1] ?? '')
        index += 1
      }
      blocks.push({ kind: 'quote', text: body.join('\n').trim() })
      continue
    }

    // A table needs its divider row; without it the pipes are just text.
    if (line.includes('|') && TABLE_DIVIDER.test(lines[index + 1] ?? '')) {
      const header = splitRow(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim() !== '') {
        rows.push(splitRow(lines[index] ?? ''))
        index += 1
      }
      blocks.push({ kind: 'table', header, rows })
      continue
    }

    if (BULLET.test(line.trim()) || ORDERED.test(line.trim())) {
      const ordered = ORDERED.test(line.trim())
      const items: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const match = current.trim().match(ordered ? ORDERED : BULLET)
        if (match === null) break
        items.push((match[1] ?? '').trim())
        index += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    // Paragraph: consume until a blank line or the start of another block.
    const body: string[] = [line.trim()]
    index += 1
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (current.trim() === '') break
      if (FENCE.test(current.trim()) || HEADING.test(current) || RULE.test(current.trim())) break
      if (BULLET.test(current.trim()) || ORDERED.test(current.trim()) || QUOTE.test(current.trim())) break
      body.push(current.trim())
      index += 1
    }
    blocks.push({ kind: 'paragraph', text: body.join('\n') })
  }

  return blocks
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

/** Render one line's inline constructs into React nodes. */
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const nodes: ReactNode[] = []
  let rest = text
  let counter = 0

  // One left-to-right scan; each match consumes the shortest sensible span so
  // nested constructs stay literal instead of being re-parsed twice.
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))|((?:https?:\/\/|www\.)[^\s<>()]+)/g

  let match: RegExpExecArray | null
  while ((match = pattern.exec(rest)) !== null) {
    if (match.index > 0) {
      const head = rest.slice(0, match.index)
      // Line breaks inside a paragraph render as real breaks.
      const parts = head.split('\n')
      parts.forEach((part, position) => {
        if (part !== '') nodes.push(part)
        if (position < parts.length - 1) nodes.push(<br key={`${keyPrefix}-br-${counter++}`} />)
      })
    }
    const token = match[0]
    const key = `${keyPrefix}-${counter++}`
    if (token.startsWith('`')) {
      nodes.push(<code key={key} className="skw-md-code">{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), `${key}s`)}</strong>)
    } else if (token.startsWith('~~')) {
      nodes.push(<s key={key}>{renderInline(token.slice(2, -2), `${key}s`)}</s>)
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), `${key}e`)}</em>)
    } else if (token.startsWith('_')) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), `${key}e`)}</em>)
    } else if (token.startsWith('[')) {
      const split = token.match(/\[([^\]]+)\]\(([^)\s]+)\)/)
      const label = split?.[1] ?? token
      const href = safeHref(split?.[2] ?? '')
      nodes.push(
        href === undefined ? (
          <span key={key}>{label}</span>
        ) : (
          <a key={key} className="skw-md-link" href={href} target="_blank" rel="noreferrer noopener">
            {renderInline(label, `${key}l`)}
          </a>
        ),
      )
    } else {
      const href = safeHref(token)
      nodes.push(
        href === undefined ? (
          <span key={key}>{token}</span>
        ) : (
          <a key={key} className="skw-md-link" href={href} target="_blank" rel="noreferrer noopener">
            {token}
          </a>
        ),
      )
    }
    rest = rest.slice(match.index + token.length)
    pattern.lastIndex = 0
  }

  if (rest !== '') {
    const parts = rest.split('\n')
    parts.forEach((part, position) => {
      if (part !== '') nodes.push(part)
      if (position < parts.length - 1) nodes.push(<br key={`${keyPrefix}-br-${counter++}`} />)
    })
  }

  return nodes
}

/** Render one parsed block. */
function renderBlock(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = (`h${Math.min(block.level + 2, 6)}`) as 'h3'
      return (
        <Tag key={key} className="skw-md-heading">
          {renderInline(block.text, `${key}h`)}
        </Tag>
      )
    }
    case 'code':
      return (
        <pre key={key} className="skw-md-pre" data-language={block.language || undefined}>
          <code>{block.text}</code>
        </pre>
      )
    case 'quote':
      return (
        <blockquote key={key} className="skw-md-quote">
          {renderInline(block.text, `${key}q`)}
        </blockquote>
      )
    case 'rule':
      return <hr key={key} className="skw-md-rule" />
    case 'list':
      return block.ordered ? (
        <ol key={key} className="skw-md-list">
          {block.items.map((item, position) => (
            <li key={`${key}-${position}`}>{renderTask(item, `${key}-${position}`)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="skw-md-list">
          {block.items.map((item, position) => (
            <li key={`${key}-${position}`}>{renderTask(item, `${key}-${position}`)}</li>
          ))}
        </ul>
      )
    case 'table':
      return (
        <table key={key} className="skw-md-table">
          <thead>
            <tr>
              {block.header.map((cell, position) => (
                <th key={`${key}-h-${position}`}>{renderInline(cell, `${key}h${position}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${key}-r-${rowIndex}`}>
                {row.map((cell, position) => (
                  <td key={`${key}-r-${rowIndex}-${position}`}>{renderInline(cell, `${key}r${rowIndex}${position}`)}</td>
                ))}
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

/** A `- [ ]` / `- [x]` list item renders its checkbox as a static glyph. */
function renderTask(item: string, key: string): ReactNode {
  const match = item.match(/^\[( |x|X)\]\s+(.*)$/)
  if (match === null) return renderInline(item, key)
  const checked = (match[1] ?? ' ') !== ' '
  return (
    <span key={key} className="skw-md-task" data-checked={checked}>
      <span className="skw-md-box" aria-hidden="true">{checked ? '✓' : ''}</span>
      {renderInline(match[2] ?? '', `${key}t`)}
    </span>
  )
}

/**
 * Render a note body as Markdown.
 *
 * `compact` drops the outer wrapper's paragraph margins so a two-line note
 * stays two lines tall on the canvas instead of gaining block spacing.
 */
export function Markdown({ source, compact = false }: { source: string; compact?: boolean }): JSX.Element {
  const blocks = parseBlocks(source)
  return (
    <div className="skw-md" data-compact={compact}>
      {blocks.map((block, index) => renderBlock(block, `b${index}`))}
    </div>
  )
}
