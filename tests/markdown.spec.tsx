// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown, parseBlocks, renderInline, safeHref } from '../src/client/markdown.jsx'

/**
 * Markdown renderer tests.
 *
 * The renderer is the one place user text becomes DOM, so the assertions are
 * about structure and safety: every construct produces the element it claims,
 * and a hostile target never becomes a live link.
 */

afterEach(cleanup)

describe('markdown parser', () => {
  it('splits a body into the block kinds the wall supports', () => {
    const blocks = parseBlocks([
      '# Heading',
      '',
      'A paragraph.',
      '',
      '- one',
      '- two',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '> quoted',
      '',
      '---',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'))

    expect(blocks.map((block) => block.kind)).toEqual([
      'heading', 'paragraph', 'list', 'code', 'quote', 'rule', 'table',
    ])
  })

  it('treats an unterminated code fence as code, not as broken markup', () => {
    // The user is mid-typing; the wall must not flash raw backticks.
    const blocks = parseBlocks('```js\nstill typing')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({ kind: 'code', text: 'still typing', language: 'js' })
  })

  it('keeps pipes as plain text when no divider row follows them', () => {
    const blocks = parseBlocks('a | b is just a sentence')
    expect(blocks[0]?.kind).toBe('paragraph')
  })

  it('reads ordered lists separately from bullet lists', () => {
    expect(parseBlocks('1. first\n2. second')[0]).toMatchObject({ kind: 'list', ordered: true })
    expect(parseBlocks('- first\n- second')[0]).toMatchObject({ kind: 'list', ordered: false })
  })
})

describe('markdown safety', () => {
  it('accepts http(s), mailto and bare www targets', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com')
    expect(safeHref('http://example.com')).toBe('http://example.com')
    expect(safeHref('mailto:someone@example.com')).toBe('mailto:someone@example.com')
    expect(safeHref('www.example.com')).toBe('https://www.example.com')
  })

  it('refuses script and data targets so a pasted link cannot become code', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeHref('vbscript:msgbox')).toBeUndefined()
    expect(safeHref('')).toBeUndefined()
  })

  it('renders a refused link as its label, with no anchor element', () => {
    const { container } = render(<Markdown source="[click](javascript:alert(1))" />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('click')
  })

  it('renders raw HTML in a note as visible text instead of markup', () => {
    const { container } = render(<Markdown source="<img src=x onerror=alert(1)>" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img')
  })
})

describe('markdown rendering', () => {
  it('renders inline emphasis, code and links as real elements', () => {
    const { container } = render(<Markdown source={'**bold** and *italic* and `code` and [link](https://example.com)'} />)
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('em')?.textContent).toBe('italic')
    expect(container.querySelector('code')?.textContent).toBe('code')
    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('href')).toBe('https://example.com')
    // A note link must never hand the shell's window to the target page.
    expect(anchor?.getAttribute('rel')).toBe('noreferrer noopener')
    expect(anchor?.getAttribute('target')).toBe('_blank')
  })

  it('renders a heading one step smaller than a document outline', () => {
    const { container } = render(<Markdown source={'# Title\n\n## Section'} />)
    // `#` maps to h3: a note is a card, not a page, so a level-1 heading must
    // not outrank the wall's own title in the accessibility tree.
    expect(container.querySelector('h3')?.textContent).toBe('Title')
    expect(container.querySelector('h4')?.textContent).toBe('Section')
  })

  it('renders checkbox list items with their checked state', () => {
    const { container } = render(<Markdown source={'- [x] done\n- [ ] todo'} />)
    const tasks = container.querySelectorAll('.skw-md-task')
    expect(tasks).toHaveLength(2)
    expect(tasks[0]?.getAttribute('data-checked')).toBe('true')
    expect(tasks[1]?.getAttribute('data-checked')).toBe('false')
  })

  it('renders a code block with its language and without inline reflow', () => {
    const { container } = render(<Markdown source={'```json\n{"a":1}\n```'} />)
    const pre = container.querySelector('pre')
    expect(pre?.getAttribute('data-language')).toBe('json')
    expect(pre?.querySelector('code')?.textContent).toBe('{"a":1}')
  })

  it('renders a table with header and body cells', () => {
    const { container } = render(<Markdown source={'| h1 | h2 |\n| --- | --- |\n| a | b |'} />)
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelectorAll('td')).toHaveLength(2)
  })

  it('turns a single newline inside a paragraph into a line break', () => {
    const { container } = render(<Markdown source={'first line\nsecond line'} />)
    expect(container.querySelectorAll('br')).toHaveLength(1)
    expect(container.textContent).toContain('first line')
    expect(container.textContent).toContain('second line')
  })

  it('leaves an unclosed emphasis marker as literal text', () => {
    const nodes = renderInline('a *b')
    expect(nodes.filter((node) => typeof node === 'string').join('')).toContain('*b')
  })

  it('marks the compact variant so card bodies drop outer block margins', () => {
    const { container } = render(<Markdown source="body" compact />)
    expect(container.querySelector('.skw-md')?.getAttribute('data-compact')).toBe('true')
  })
})
