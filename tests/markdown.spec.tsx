// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown, parseBlocks, plainTextSummary, renderInline, safeHref } from '../src/client/markdown.jsx'

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

describe('plainTextSummary', () => {
  it('strips a heading marker but keeps its text', () => {
    expect(plainTextSummary('## Heading')).toBe('Heading')
  })

  it('drops the task marker of a to-do list item', () => {
    expect(plainTextSummary('- [ ] task')).toBe('task')
    expect(plainTextSummary('- [x] done')).toBe('done')
  })

  it('strips emphasis markers but keeps the words they wrap', () => {
    expect(plainTextSummary('**bold** text')).toBe('bold text')
    expect(plainTextSummary('*italic* and ~~gone~~ and `code`')).toBe('italic and gone and code')
  })

  it('summarises a leading code block with its first line', () => {
    expect(plainTextSummary('```ts\nconst a = 1\nconst b = 2\n```')).toBe('const a = 1')
  })

  it('summarises a table with its header cells', () => {
    expect(plainTextSummary('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('a b')
  })

  it('reduces a link to its label and leaves a bare URL alone', () => {
    expect(plainTextSummary('[label](https://x)')).toBe('label')
    // A bare URL is the visible text, so deleting it would lose information.
    expect(plainTextSummary('see https://x for details')).toBe('see https://x for details')
  })

  it('skips a leading rule and summarises the first visible block', () => {
    // `---` carries no text, so a digest that stopped there would be empty.
    expect(plainTextSummary('---\n\n## After the rule')).toBe('After the rule')
  })

  it('skips an empty heading instead of returning nothing', () => {
    // `## ` (with the space) IS a heading with no text; a bare `##` is a
    // paragraph that the renderer prints literally, so it is not skipped.
    expect(plainTextSummary('## \n\nA real line')).toBe('A real line')
    expect(plainTextSummary('##')).toBe('##')
  })

  it('truncates to max characters and appends an ellipsis', () => {
    const long = 'word '.repeat(40).trim()
    const digest = plainTextSummary(long, 10)
    expect(digest).toBe(`${'word '.repeat(40).trim().slice(0, 10).trimEnd()}…`)
    // `max` counts the returned TEXT, never the ellipsis on top of it.
    expect(digest.replace(/…$/, '').length).toBeLessThanOrEqual(10)
  })

  it('leaves a short note untouched and does not add an ellipsis', () => {
    expect(plainTextSummary('short note')).toBe('short note')
    expect(plainTextSummary('short note', 90)).toBe('short note')
  })

  it('returns an empty string for empty input', () => {
    expect(plainTextSummary('')).toBe('')
    expect(plainTextSummary('   \n\n  ')).toBe('')
    expect(plainTextSummary('---')).toBe('')
  })

  it('collapses whitespace runs into single spaces', () => {
    // The digest is one block's text, and a blank line starts a new block, so
    // the run to collapse is the one INSIDE a block.
    expect(plainTextSummary('a  b\t\tc')).toBe('a b c')
  })

  it('never throws and guards a non-positive or unusable max', () => {
    expect(plainTextSummary('text', 0)).toBe('')
    expect(plainTextSummary('text', -5)).toBe('')
    expect(plainTextSummary('text', Number.NaN)).toBe('')
    // Weird-but-typed-as-string input still produces a best-effort digest.
    expect(plainTextSummary('**\n```\n|')).toBeTypeOf('string')
  })

  it('uses a 90 character default budget', () => {
    const digest = plainTextSummary('x'.repeat(200))
    expect(digest).toBe(`${'x'.repeat(90)}…`)
  })
})

/**
 * Parser robustness regressions.
 *
 * The defect these lock down was not a cosmetic one: `parseBlocks` had a branch
 * that could return the same index forever, and it runs on EVERY render (card
 * body, card aria-label, list-row digest). A single note containing an indented
 * quote therefore froze the sidebar with no way back short of editing the file
 * on disk — and the editor could produce that note from one Tab keypress.
 */
describe('parser termination', () => {
  it('parses an indented block quote instead of looping forever', () => {
    // Before the fix this call never returned: the branch tested the TRIMMED
    // line for `>` but matched the RAW line inside its loop, so `index` never
    // advanced. The test hangs rather than fails if the invariant regresses.
    expect(parseBlocks('  > indented quote')).toEqual([
      { kind: 'quote', children: [{ kind: 'paragraph', text: 'indented quote' }] },
    ])
    expect(parseBlocks('\t> tab quote')).toEqual([
      { kind: 'quote', children: [{ kind: 'paragraph', text: 'tab quote' }] },
    ])
    expect(parseBlocks('> a\n  > b')[0]).toMatchObject({ kind: 'quote' })
  })

  it('terminates on every two- and three-line combination of block markers', () => {
    // The exact fuzz that found the loop: 34 atoms taken two and three at a
    // time. It must complete quickly and never throw.
    const atoms = ['> q', '  > q', '\t> q', '>', '> > q', '- a', '  - b', '# h', '  # h',
      '---', '| a | b |', '| --- | --- |', '```', '~~~', 'text', '  text', '', '- [ ] t', '1. o']
    const started = Date.now()
    for (const a of atoms) {
      for (const b of atoms) {
        parseBlocks(`${a}\n${b}`)
        plainTextSummary(`${a}\n${b}`)
        for (const c of atoms) parseBlocks(`${a}\n${b}\n${c}`)
      }
    }
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('never throws on unterminated constructs', () => {
    for (const source of ['```', '> ', '- ', '| a |', '**', '`', '~~~', '\n\n\n', '  \n\t\n', '####### h7']) {
      expect(() => parseBlocks(source)).not.toThrow()
      expect(() => plainTextSummary(source)).not.toThrow()
    }
  })

  it('parses a deeply nested document without blowing up', () => {
    const deep = Array.from({ length: 200 }, (_, index) => `${' '.repeat(index * 2)}- level ${index}`).join('\n')
    expect(() => parseBlocks(deep)).not.toThrow()
  })
})

/**
 * Indentation is structure.
 *
 * These lock the contract the editor's Tab key now relies on: a block marker is
 * recognised after leading whitespace, so indenting a line can never silently
 * un-syntax it. The old parser matched headings and quotes on the raw line, which
 * is why the toolbar's own output (`  # title`) rendered as a paragraph.
 */
describe('indentation as structure', () => {
  it('recognises a heading behind leading whitespace', () => {
    expect(parseBlocks('  # title')[0]).toEqual({ kind: 'heading', level: 1, text: 'title' })
  })

  it('nests lists by two-space indentation', () => {
    const [block] = parseBlocks('- one\n  - two\n    - three')
    expect(block).toMatchObject({ kind: 'list', ordered: false })
    const list = block as Extract<ReturnType<typeof parseBlocks>[number], { kind: 'list' }>
    expect(list.items).toHaveLength(1)
    expect(list.items[0]?.text).toBe('one')
    const child = list.items[0]?.children[0]
    expect(child).toMatchObject({ kind: 'list' })
    const childList = child as Extract<typeof child, { kind: 'list' }>
    expect(childList.items[0]?.text).toBe('two')
  })

  it('keeps a nested ordered list inside its parent item', () => {
    const [block] = parseBlocks('1. a\n   1. b\n2. c')
    const list = block as Extract<ReturnType<typeof parseBlocks>[number], { kind: 'list' }>
    expect(list.items.map((item) => item.text)).toEqual(['a', 'c'])
    expect(list.items[0]?.children[0]).toMatchObject({ kind: 'list', ordered: true })
  })

  it('folds a continuation line into its list item instead of splitting the list', () => {
    // This used to produce list + paragraph + list: three blocks for two items.
    const blocks = parseBlocks('- item one\n  continued text\n- item two')
    expect(blocks).toHaveLength(1)
    const list = blocks[0] as Extract<(typeof blocks)[number], { kind: 'list' }>
    expect(list.items).toHaveLength(2)
    expect(list.items[0]?.text).toBe('item one\ncontinued text')
  })

  it('keeps a loose list as ONE list', () => {
    const blocks = parseBlocks('- a\n\n- b')
    expect(blocks).toHaveLength(1)
    const list = blocks[0] as Extract<(typeof blocks)[number], { kind: 'list' }>
    expect(list.items.map((item) => item.text)).toEqual(['a', 'b'])
  })

  it('preserves an empty list item rather than dropping it', () => {
    const [block] = parseBlocks('- a\n- \n- b')
    const list = block as Extract<ReturnType<typeof parseBlocks>[number], { kind: 'list' }>
    expect(list.items.map((item) => item.text)).toEqual(['a', '', 'b'])
  })

  it('nests a block quote inside a block quote', () => {
    const [block] = parseBlocks('> outer\n> > inner')
    const quote = block as Extract<ReturnType<typeof parseBlocks>[number], { kind: 'quote' }>
    expect(quote.children.map((child) => child.kind)).toEqual(['paragraph', 'quote'])
  })

  it('parses an indented code block after a blank line', () => {
    const blocks = parseBlocks('para\n\n    const a = 1\n    const b = 2')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'indentedCode'])
    expect(blocks[1]).toMatchObject({ kind: 'indentedCode', text: 'const a = 1\nconst b = 2' })
  })
})

/** Fence and table details that used to leak syntax into the rendered text. */
describe('fence and table details', () => {
  it('accepts a fence with an attribute-carrying info string', () => {
    // ```` ```js title=x ```` used to fail the fence test entirely, so the code
    // leaked out as a paragraph and the closing fence became an empty code block.
    const blocks = parseBlocks('```js title=x\ncode\n```')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'code', text: 'code', language: 'js' })
  })

  it('closes a fence with a longer run of the same character', () => {
    expect(parseBlocks('```\ncode\n````')[0]).toMatchObject({ kind: 'code', text: 'code' })
  })

  it('does not close a backtick fence with a tilde fence', () => {
    const blocks = parseBlocks('```\ncode\n~~~\nmore\n```')
    expect(blocks[0]).toMatchObject({ kind: 'code', text: 'code\n~~~\nmore' })
  })

  it('reads table column alignment from the divider row', () => {
    const [block] = parseBlocks('| l | c | r |\n|:---|:---:|---:|\n| 1 | 2 | 3 |')
    expect(block).toMatchObject({ align: ['left', 'center', 'right'] })
  })

  it('renders an ordered list starting from a number other than one', () => {
    const [block] = parseBlocks('3. three\n4. four')
    expect(block).toMatchObject({ kind: 'list', ordered: true, start: 3 })
  })
})

/** Inline constructs that a left-to-right regex scan could not express. */
describe('inline parsing', () => {
  const text = (source: string): string => renderInline(source).filter((node) => typeof node === 'string').join('')

  it('renders triple emphasis as strong inside emphasis, with no stray asterisks', () => {
    // Used to render as `*<strong>both</strong>*`.
    const { container } = render(<Markdown source="***both***" />)
    expect(container.querySelector('strong > em')?.textContent).toBe('both')
    expect(container.textContent).toBe('both')
  })

  it('leaves an intraword underscore literal', () => {
    // `snake_case_name` used to render as `snake<em>case</em>name`.
    const { container } = render(<Markdown source="snake_case_name" />)
    expect(container.querySelector('em')).toBeNull()
    expect(container.textContent).toBe('snake_case_name')
  })

  it('honours a backslash escape', () => {
    // Used to render the backslash verbatim AND apply the emphasis.
    const { container } = render(<Markdown source={'\\*not italic\\*'} />)
    expect(container.querySelector('em')).toBeNull()
    expect(container.textContent).toBe('*not italic*')
  })

  it('keeps an unmatched emphasis run literal', () => {
    // Used to render an empty <em> followed by the word.
    expect(text('**bold')).toBe('**bold')
    expect(text('*a')).toBe('*a')
  })

  it('supports a code span that itself contains a backtick', () => {
    const { container } = render(<Markdown source="``a`b``" />)
    expect(container.querySelector('code')?.textContent).toBe('a`b')
  })

  it('keeps trailing sentence punctuation out of an autolink', () => {
    const { container } = render(<Markdown source="see https://a.com." />)
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://a.com')
    expect(container.textContent).toBe('see https://a.com.')
  })

  it('accepts one level of balanced parentheses in a link target', () => {
    const { container } = render(<Markdown source="[x](https://en.wikipedia.org/wiki/Foo_(bar))" />)
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(container.textContent).toBe('x')
  })
})

/** The digest must agree with what the card renders, including nesting. */
describe('digest of nested content', () => {
  it('summarises a nested list with its first visible text', () => {
    expect(plainTextSummary('- one\n  - two')).toBe('one')
  })

  it('summarises an indented quote', () => {
    expect(plainTextSummary('  > quoted')).toBe('quoted')
  })

  it('reaches into a list item that only holds nested content', () => {
    expect(plainTextSummary('- \n  - nested')).toBe('nested')
  })
})

/**
 * Nested rendering.
 *
 * The parser change is only half the fix: the block renderer has to recurse, or
 * a nested list still renders as one flat `<ul>` — which is exactly the "预览没有
 * 缩进效果" the user reported. These assert the DOM shape, not the model.
 */
describe('nested rendering', () => {
  it('renders a nested list as nested <ul> elements', () => {
    const { container } = render(<Markdown source={'- one\n  - two\n    - three'} />)
    const lists = container.querySelectorAll('ul.skw-md-list')
    expect(lists).toHaveLength(3)
    // The inner lists must be INSIDE the parent <li>, not siblings of it.
    expect(lists[0]?.querySelector('li > ul')).not.toBeNull()
    expect(container.querySelectorAll('li')).toHaveLength(3)
  })

  it('renders a nested ordered list inside an unordered one', () => {
    const { container } = render(<Markdown source={'- a\n  1. b\n  2. c'} />)
    expect(container.querySelector('ul > li > ol')).not.toBeNull()
    expect(container.querySelectorAll('ol > li')).toHaveLength(2)
  })

  it('renders a nested block quote as a blockquote inside a blockquote', () => {
    const { container } = render(<Markdown source={'> outer\n> > inner'} />)
    expect(container.querySelector('blockquote blockquote')).not.toBeNull()
  })

  it('renders an indented code block as <pre>', () => {
    const { container } = render(<Markdown source={'para\n\n    const a = 1'} />)
    const pre = container.querySelector('pre')
    expect(pre?.querySelector('code')?.textContent).toBe('const a = 1')
  })

  it('applies the declared column alignment to table cells', () => {
    const { container } = render(<Markdown source={'| l | r |\n|:--- | ---:|\n| 1 | 2 |'} />)
    expect(container.querySelector('th')?.style.textAlign).toBe('left')
    expect(container.querySelectorAll('th')[1]?.style.textAlign).toBe('right')
  })

  it('renders an ordered list from its declared start number', () => {
    const { container } = render(<Markdown source={'3. three\n4. four'} />)
    expect(container.querySelector('ol')?.getAttribute('start')).toBe('3')
  })

  it('renders a continuation line inside the list item, not as a stray paragraph', () => {
    const { container } = render(<Markdown source={'- item one\n  continued text\n- item two'} />)
    expect(container.querySelectorAll('p')).toHaveLength(0)
    expect(container.querySelectorAll('li')).toHaveLength(2)
    // The soft break inside the item becomes a <br>, keeping it one item.
    expect(container.querySelectorAll('br')).toHaveLength(1)
  })
})

/**
 * Nesting bound.
 *
 * Nesting is recursive, so an adversarial document (4000 lines each opening one
 * more `>`) recursed thousands of frames and cost quadratic time. The cap keeps
 * a hostile note from freezing the sidebar, while leaving real nesting intact.
 */
describe('nesting bound', () => {
  it('keeps ordinary nesting well under the cap', () => {
    const deep = Array.from({ length: 5 }, (_, index) => `${'  '.repeat(index)}- level ${index}`).join('\n')
    expect(JSON.stringify(parseBlocks(deep))).toContain('children')
  })

  it('parses an adversarial deep quote quickly instead of quadratically', () => {
    const hostile = Array.from({ length: 4000 }, (_, index) => `${'>'.repeat(index + 1)} x`).join('\n')
    const started = Date.now()
    expect(() => parseBlocks(hostile)).not.toThrow()
    // Was ~6s before the cap; anything near that means the cap stopped working.
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('keeps the over-cap content visible instead of dropping it', () => {
    const hostile = Array.from({ length: 40 }, (_, index) => `${'>'.repeat(index + 1)} x`).join('\n')
    const serialised = JSON.stringify(parseBlocks(hostile))
    expect(serialised).toContain('x')
  })
})

/**
 * The inline scanner must stay linear.
 *
 * A body of unmatched openers is legal input at the documented limit
 * (`LIMITS.body`, 200k characters) and used to take 57 seconds to render one
 * card — a frozen sidebar with no error and no timeout. The budget here is
 * deliberately loose (jsdom on a loaded CI box is slow) because the point is the
 * SHAPE of the curve: quadratic behaviour was four orders of magnitude over it.
 */
describe('inline scanner cost', () => {
  it('renders a body of unmatched openers in linear time', () => {
    for (const char of ['[', '*', '_', '~', '`']) {
      const source = char.repeat(50_000)
      const started = performance.now()
      render(<Markdown source={source} />)
      const elapsed = performance.now() - started
      cleanup()
      expect(elapsed, `${JSON.stringify(char)} x50000 took ${Math.round(elapsed)}ms`).toBeLessThan(5_000)
    }
  })

  it('does not nest a link inside a link label', () => {
    const { container } = render(<Markdown source={'[https://a.com](https://b.com)'} />)
    // One anchor only: `<a>` cannot nest, and React warns about it.
    expect(container.querySelectorAll('a')).toHaveLength(1)
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://b.com')
    cleanup()
  })
})
