// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EDITOR_CSS, MarkdownEditor, TOOLBAR_KEYS, indentLevelOf } from '../src/client/editor.jsx'
import { en, textOf, zh } from '../src/client/text.js'

/**
 * Markdown editor tests.
 *
 * The editor is the one place a note is WRITTEN, so these tests target the
 * failure modes a rendering test can never see: a Chinese input method broken by
 * a shortcut, a value silently reflowed on write-back, a caret lost when a
 * toolbar button runs, and a listener left behind after unmount.
 *
 * Everything runs against a controlled host component, because the caret
 * contract only exists when the parent accepts the value and re-renders.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

interface HostProps {
  initial: string
  onSave?(): void
  onEscape?(): void
  onWrite?(value: string): void
  maxLength?: number
  toolbar?: boolean
  autoFocus?: boolean
  disabled?: boolean
  locale?: 'zh' | 'en'
  fill?: boolean
  hidden?: boolean
  t?: (key: string, params?: Record<string, string | number>) => string
}

/** A controlled parent: the editor's real contract, plus spies. */
function Host(props: HostProps): JSX.Element {
  const [value, setValue] = useState(props.initial)
  return (
    <MarkdownEditor
      value={value}
      onChange={(next) => {
        props.onWrite?.(next)
        setValue(next)
      }}
      onSave={() => {
        props.onSave?.()
      }}
      onEscape={() => {
        props.onEscape?.()
      }}
      label="正文"
      toolbar={props.toolbar ?? true}
      autoFocus={props.autoFocus ?? true}
      {...(props.fill === undefined ? {} : { fill: props.fill })}
      disabled={props.disabled ?? false}
      locale={props.locale ?? 'zh'}
      // `exactOptionalPropertyTypes` forbids passing `undefined`, and an editor
      // without a limit must not receive one.
      {...(props.maxLength === undefined ? {} : { maxLength: props.maxLength })}
      {...(props.hidden === undefined ? {} : { hidden: props.hidden })}
      {...(props.t === undefined ? {} : { t: props.t })}
    />
  )
}

/** The one textarea on screen. */
function editor(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

/** Place the caret the way a user would: focus, then select. */
function select(start: number, end: number): HTMLTextAreaElement {
  const node = editor()
  node.focus()
  node.setSelectionRange(start, end)
  return node
}

/** Press a toolbar button and stay in the editor, like a real mouse press. */
function press(label: string): void {
  const button = screen.getByRole('button', { name: label })
  fireEvent.mouseDown(button)
  fireEvent.click(button)
}

describe('IME safety', () => {
  it('keeps Escape, save and Enter inert while composing', () => {
    const onSave = vi.fn()
    const onEscape = vi.fn()
    render(<Host initial={'- item'} onSave={onSave} onEscape={onEscape} autoFocus={false} />)
    const node = select(6, 6)

    fireEvent.compositionStart(node)

    // Enter would normally continue the list and Cmd+S would save; neither may
    // fire, because the IME is mid-word and the keystroke is its own.
    const escape = fireEvent.keyDown(node, { key: 'Escape' })
    const save = fireEvent.keyDown(node, { key: 's', metaKey: true })
    const enter = fireEvent.keyDown(node, { key: 'Enter' })

    expect(onEscape).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
    expect(node.value).toBe('- item')
    // An inert keystroke must not swallow the default either: the IME needs it.
    expect(escape).toBe(true)
    expect(save).toBe(true)
    expect(enter).toBe(true)
  })

  it('guards a keydown that carries isComposing or the legacy 229 key code', () => {
    const onSave = vi.fn()
    const onEscape = vi.fn()
    render(<Host initial={'- item'} onSave={onSave} onEscape={onEscape} autoFocus={false} />)
    const node = select(6, 6)

    // No compositionstart at all: some browsers only mark the event itself.
    fireEvent.keyDown(node, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(node, { key: 's', metaKey: true, keyCode: 229 })
    fireEvent.keyDown(node, { key: 'Enter', isComposing: true })

    expect(onEscape).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
    expect(node.value).toBe('- item')
  })

  it('stays guarded for the ONE keydown that trails compositionend, then recovers', () => {
    const onSave = vi.fn()
    const onEscape = vi.fn()
    render(<Host initial={'- item'} onSave={onSave} onEscape={onEscape} autoFocus={false} />)
    const node = select(6, 6)

    fireEvent.compositionStart(node)
    fireEvent.compositionEnd(node)
    // One keydown still arrives after compositionend on some IMEs; without the
    // justEnded latch that Enter would also continue the list.
    fireEvent.keyDown(node, { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
    expect(node.value).toBe('- item')

    // The NEXT keydown is the user's own and must be honoured. This is the
    // regression: the latch used to wait for a `keyup` that a mouse-committed
    // candidate never produces, so every later Enter/Tab/Cmd+S was discarded and
    // the browser inserted a bare newline instead of continuing the list.
    fireEvent.keyDown(node, { key: 'Enter' })
    expect(node.value).toBe('- item\n- ')
  })

  it('does not let a mouse-committed composition swallow the following Enters', () => {
    // Committing a candidate with the mouse fires compositionend and NO keyup.
    // Every later Enter must still continue the list; the old latch discarded
    // all of them and the browser inserted a bare newline instead.
    render(<Host initial={'- 第一项'} autoFocus={false} />)
    const node = select(5, 5)

    fireEvent.compositionStart(node)
    fireEvent.compositionEnd(node)
    // The commit's own trailing keydown (if any) is the one inert key.
    fireEvent.keyDown(node, { key: 'Enter' })

    // First real Enter: continues the list with a fresh marker.
    fireEvent.keyDown(node, { key: 'Enter' })
    expect(node.value).toBe('- 第一项\n- ')
    // Type the second item, then Enter again: still a sibling, not a paragraph.
    fireEvent.change(node, { target: { value: '- 第一项\n- 第二项' } })
    node.setSelectionRange(node.value.length, node.value.length)
    fireEvent.keyDown(node, { key: 'Enter' })
    expect(node.value).toBe('- 第一项\n- 第二项\n- ')
  })

  it('lets Tab indent immediately after a composition with no keyup', () => {
    render(<Host initial={'- 父项'} autoFocus={false} />)
    const node = select(4, 4)

    fireEvent.compositionStart(node)
    fireEvent.compositionEnd(node)
    fireEvent.keyDown(node, { key: 'Enter' }) // the trailing inert keydown
    fireEvent.keyDown(node, { key: 'Tab' })
    expect(node.value).toBe('  - 父项')
  })

  it('lets Cmd+S save immediately after a composition with no keyup', () => {
    const onSave = vi.fn()
    render(<Host initial={'正文'} onSave={onSave} autoFocus={false} />)
    const node = select(2, 2)

    fireEvent.compositionStart(node)
    fireEvent.compositionEnd(node)
    fireEvent.keyDown(node, { key: 'Enter' }) // the trailing inert keydown
    fireEvent.keyDown(node, { key: 's', metaKey: true })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('builds a nested Chinese list across real task boundaries (the reported bug)', async () => {
    // The user flow that failed: insert a bullet, type Chinese through the IME,
    // press Enter for the next item, type again, then Tab to nest. Every step
    // happens in its own task, which is what a real keyboard produces.
    render(<Host initial={''} autoFocus={false} />)
    const node = select(0, 0)
    press('无序列表')
    expect(node.value).toBe('- ')

    fireEvent.compositionStart(node)
    fireEvent.change(node, { target: { value: '- 第一项' } })
    fireEvent.compositionEnd(node)
    await new Promise((resolve) => { setTimeout(resolve, 3) })

    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
    fireEvent.keyDown(node, { key: 'Enter' })
    // The marker AND its indent survive; the browser's bare newline does not.
    expect(node.value).toBe('- 第一项\n- ')

    fireEvent.compositionStart(node)
    fireEvent.change(node, { target: { value: '- 第一项\n- 第二项' } })
    fireEvent.compositionEnd(node)
    await new Promise((resolve) => { setTimeout(resolve, 3) })

    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
    fireEvent.keyDown(node, { key: 'Tab' })
    expect(node.value).toBe('- 第一项\n  - 第二项')
  })

  it('expires a latch that no keydown ever consumes', async () => {
    // An IME can end a composition without delivering any further key event.
    // The scheduled expiry must disarm the guard, or the editor stays dead.
    render(<Host initial={'- item'} autoFocus={false} />)
    const node = select(6, 6)

    fireEvent.compositionStart(node)
    fireEvent.compositionEnd(node)
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    fireEvent.keyDown(node, { key: 'Enter' })
    expect(node.value).toBe('- item\n- ')
  })

  it('clears a stuck composition on a window blur', () => {
    const onEscape = vi.fn()
    render(<Host initial="value" onEscape={onEscape} autoFocus={false} />)
    const node = select(5, 5)

    fireEvent.compositionStart(node)
    // A window that loses focus mid-composition may never see compositionend,
    // so blur has to reset the state or every later shortcut dies.
    fireEvent(window, new Event('blur'))
    fireEvent.keyDown(node, { key: 'Escape' })

    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('never writes the selection while composing', () => {
    render(<Host initial="abc" autoFocus={false} />)
    const node = select(1, 2)
    const setRange = vi.spyOn(HTMLTextAreaElement.prototype, 'setSelectionRange')

    fireEvent.compositionStart(node)
    // Any programmatic selection write resets Safari's pinyin buffer, so an edit
    // that happens mid-composition must reach the value without moving the caret.
    press('粗体')

    expect(editor().value).toBe('a**b**c')
    expect(setRange).not.toHaveBeenCalled()
  })
})

describe('write-back fidelity', () => {
  it('passes the textarea value through unchanged', () => {
    const onWrite = vi.fn()
    render(<Host initial="" onWrite={onWrite} autoFocus={false} />)
    const node = editor()

    // Whitespace is content in Markdown: a trailing space is a hard break, and a
    // leading newline starts a block. Trimming any of it corrupts the note.
    const raw = '\n  trailing space \nsecond  line\n\n'
    fireEvent.change(node, { target: { value: raw } })

    expect(onWrite).toHaveBeenCalledTimes(1)
    expect(onWrite).toHaveBeenLastCalledWith(raw)
    expect(node.value).toBe(raw)
  })

  it('does not rewrite the value on mount', () => {
    const onWrite = vi.fn()
    render(<Host initial={'  padded \n'} onWrite={onWrite} />)
    expect(onWrite).not.toHaveBeenCalled()
    expect(editor().value).toBe('  padded \n')
  })
})

describe('toolbar insertion', () => {
  it('wraps a selection in bold markers', () => {
    render(<Host initial={'hello world'} autoFocus={false} />)
    select(6, 11)
    press('粗体')

    expect(editor().value).toBe('hello **world**')
    // The wrapped text stays selected, so it can be wrapped again immediately.
    expect(editor().selectionStart).toBe(8)
    expect(editor().selectionEnd).toBe(13)
  })

  it('inserts paired markers and keeps the caret between them', () => {
    render(<Host initial="" autoFocus={false} />)
    select(0, 0)
    press('粗体')

    expect(editor().value).toBe('****')
    expect(editor().selectionStart).toBe(2)
    expect(editor().selectionEnd).toBe(2)
  })

  it('keeps the caret in place and the focus in the textarea', () => {
    render(<Host initial="title" autoFocus={false} />)
    select(3, 3)
    press('一级标题')

    const node = editor()
    expect(node.value).toBe('# title')
    // Caret after "ti", i.e. shifted by the two inserted characters.
    expect(node.selectionStart).toBe(5)
    expect(node.selectionEnd).toBe(5)
    expect(document.activeElement).toBe(node)
  })

  it('keeps the caret for an inline insert in the middle of a line', () => {
    render(<Host initial="ab" autoFocus={false} />)
    select(1, 1)
    press('粗体')

    expect(editor().value).toBe('a****b')
    expect(editor().selectionStart).toBe(3)
    expect(document.activeElement).toBe(editor())
  })

  it('prefixes every touched line for a list and keeps the selection', () => {
    render(<Host initial={'one\ntwo\nthree'} autoFocus={false} />)
    select(0, 7)
    press('无序列表')

    expect(editor().value).toBe('- one\n- two\nthree')
    expect(editor().selectionStart).toBe(0)
    expect(editor().selectionEnd).toBe(11)
  })

  it('builds a 3x3 table skeleton with the caret in the body', () => {
    render(<Host initial="" autoFocus={false} />)
    select(0, 0)
    press('插入表格')

    const node = editor()
    // The block ends with a newline so the caret can continue below the table.
    expect(node.value.endsWith('\n')).toBe(true)
    const lines = node.value.replace(/\n$/, '').split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatch(/^\| 列 1 \| 列 2 \| 列 3 \|$/)
    expect(lines[1]).toBe('| --- | --- | --- |')
    expect(lines[2]).toBe('|   |   |   |')
    expect(lines[3]).toBe('|   |   |   |')
    // "3x3" means three columns by a header plus two body rows; the caret lands
    // in the first empty body cell, not after the table.
    expect(node.selectionStart).toBe(node.value.indexOf('|   |   |   |') + 2)
  })

  it('inserts a divider and a code fence on their own lines', () => {
    render(<Host initial={'text'} autoFocus={false} />)
    select(4, 4)
    press('分割线')
    expect(editor().value).toBe('text\n---\n')
    // The caret ends after the rule, on the line below it.
    expect(editor().selectionStart).toBe(9)
    cleanup()

    render(<Host initial={''} autoFocus={false} />)
    select(0, 0)
    press('代码块')
    expect(editor().value).toBe('```\n\n```\n')
    // On the empty fence line: type and it becomes code, no hunting for backticks.
    expect(editor().selectionStart).toBe(4)
  })

  it('keeps a selected block inside the code fence', () => {
    render(<Host initial={'const a = 1'} autoFocus={false} />)
    select(0, 11)
    press('代码块')
    expect(editor().value).toBe('```\nconst a = 1\n```\n')
    expect(editor().selectionStart).toBe(15)
  })

  it('inserts a wall-clock timestamp at the caret', () => {
    render(<Host initial={'x'} autoFocus={false} />)
    select(1, 1)
    press('日期时间')
    expect(editor().value).toMatch(/^x\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(editor().selectionStart).toBe(editor().value.length)
  })

  it('italicises a word that sits inside a sentence', () => {
    // The reported inconsistency: bold worked on a word mid-sentence but italic
    // produced literal text, because `_` next to a word character is refused.
    render(<Host initial={'abcd'} autoFocus={false} />)
    select(1, 3)
    press('斜体')
    expect(editor().value).toBe('a*bc*d')
    cleanup()

    // An empty selection must not become a STRONG run (`__`).
    render(<Host initial={''} autoFocus={false} />)
    select(0, 0)
    press('斜体')
    expect(editor().value).toBe('**')
    cleanup()
  })

  it('replaces an H5 marker instead of stacking a second one', () => {
    // The parser accepts #{1,6}; the editor only stripped #{1,4}.
    render(<Host initial={'##### five'} autoFocus={false} />)
    select(0, 0)
    press('一级标题')
    expect(editor().value).toBe('# five')
    cleanup()
  })

  it('replaces a 4-digit ordered marker instead of stacking', () => {
    // The parser accepts \d{1,9}; the editor only stripped \d{1,3}.
    render(<Host initial={'1234. item'} autoFocus={false} />)
    select(0, 0)
    press('无序列表')
    expect(editor().value).toBe('- item')
    cleanup()
  })

  it('does not turn a divider into a bullet whose text is a divider', () => {
    // `- ---` is a RULE with the bullet lost, not a bullet containing a rule.
    render(<Host initial={'---'} autoFocus={false} />)
    select(0, 0)
    press('无序列表')
    expect(editor().value).toBe('- ')
  })

  it('wraps italic, strike, inline code and a link', () => {
    // Italic emits `*`, not `_`: the parser's intraword-underscore rule would
    // leave `ab_cd_` as literal text and read a bare `__` as STRONG.
    render(<Host initial={'word'} autoFocus={false} />)
    select(0, 4)
    press('斜体')
    expect(editor().value).toBe('*word*')
    cleanup()

    render(<Host initial={'word'} autoFocus={false} />)
    select(0, 4)
    press('删除线')
    expect(editor().value).toBe('~~word~~')
    cleanup()

    render(<Host initial={'word'} autoFocus={false} />)
    select(0, 4)
    press('行内代码')
    expect(editor().value).toBe('`word`')
    cleanup()

    render(<Host initial={'word'} autoFocus={false} />)
    select(0, 4)
    press('链接')
    expect(editor().value).toBe('[word](https://)')
    // The brackets wrap the label and the caret stays on it, ready for a URL.
    expect(editor().selectionStart).toBe(1)
  })

  it('converts between list kinds instead of stacking markers', () => {
    render(<Host initial={'- one'} autoFocus={false} />)
    select(5, 5)
    press('有序列表')
    expect(editor().value).toBe('1. one')
    press('待办')
    expect(editor().value).toBe('- [ ] one')
    press('无序列表')
    expect(editor().value).toBe('- one')
  })

  it('retitles a heading instead of prefixing it twice', () => {
    render(<Host initial={'# one'} autoFocus={false} />)
    select(5, 5)
    press('三级标题')
    expect(editor().value).toBe('### one')
  })

  it('toggles a blockquote instead of stacking markers', () => {
    render(<Host initial="quoted" autoFocus={false} />)
    select(0, 0)
    press('引用')
    expect(editor().value).toBe('> quoted')

    press('引用')
    expect(editor().value).toBe('quoted')
  })

  it('labels every toolbar button and keeps the toolbar keyboard reachable', () => {
    render(<Host initial="" onEscape={() => {}} />)
    const toolbar = screen.getByRole('toolbar', { name: '编辑工具栏' })
    expect(toolbar).toBeTruthy()
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(10)
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toBeTruthy()
      // A disabled button is the only one that may leave the tab order.
      expect(button.hasAttribute('tabindex')).toBe(false)
    }
  })

  it('speaks English when asked', () => {
    render(<Host initial="" locale="en" />)
    expect(screen.getByRole('toolbar', { name: 'Formatting toolbar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Bold' })).toBeTruthy()
  })

  it('hides the toolbar on request', () => {
    render(<Host initial="" toolbar={false} />)
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(editor()).toBeTruthy()
  })
})

describe('keyboard editing', () => {
  it('indents the caret line with Tab and outdents it with Shift+Tab', () => {
    render(<Host initial="hello" autoFocus={false} />)
    select(2, 2)

    const tab = fireEvent.keyDown(editor(), { key: 'Tab' })
    expect(tab).toBe(false) // prevented: Tab must never move focus away
    expect(editor().value).toBe('  hello')
    expect(editor().selectionStart).toBe(4)
    expect(editor().selectionEnd).toBe(4)
    expect(document.activeElement).toBe(editor())

    fireEvent.keyDown(editor(), { key: 'Tab', shiftKey: true })
    expect(editor().value).toBe('hello')
    expect(editor().selectionStart).toBe(2)
  })

  it('indents every selected line with Tab', () => {
    render(<Host initial={'a\nb'} autoFocus={false} />)
    select(0, 3)
    fireEvent.keyDown(editor(), { key: 'Tab' })
    expect(editor().value).toBe('  a\n  b')
    expect(editor().selectionStart).toBe(0)
    expect(editor().selectionEnd).toBe(7)
  })

  it('continues an unordered list', () => {
    render(<Host initial={'- item'} autoFocus={false} />)
    select(6, 6)
    const result = fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(result).toBe(false) // prevented: we insert the marker ourselves
    expect(editor().value).toBe('- item\n- ')
    expect(editor().selectionStart).toBe(9)
  })

  it('continues a todo item and an ordered list', () => {
    render(<Host initial={'- [ ] task'} autoFocus={false} />)
    select(10, 10)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(editor().value).toBe('- [ ] task\n- [ ] ')

    cleanup()
    render(<Host initial={'1. first'} autoFocus={false} />)
    select(8, 8)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(editor().value).toBe('1. first\n2. ')
  })

  it('ends the list on an empty item instead of adding another one', () => {
    render(<Host initial={'a\n- '} autoFocus={false} />)
    select(4, 4)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(editor().value).toBe('a\n')
    expect(editor().selectionStart).toBe(2)
  })

  it('leaves a plain Enter to the browser', () => {
    render(<Host initial="plain text" autoFocus={false} />)
    select(10, 10)
    const result = fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(result).toBe(true) // not prevented
    expect(editor().value).toBe('plain text')
  })
})

describe('save and escape', () => {
  it('saves on Cmd/Ctrl+S and suppresses the browser dialog', () => {
    const onSave = vi.fn()
    render(<Host initial="note" onSave={onSave} autoFocus={false} />)
    select(4, 4)

    const meta = fireEvent.keyDown(editor(), { key: 's', metaKey: true })
    expect(meta).toBe(false)
    const ctrl = fireEvent.keyDown(editor(), { key: 's', ctrlKey: true })
    expect(ctrl).toBe(false)
    expect(onSave).toHaveBeenCalledTimes(2)
  })

  it('saves on Cmd/Ctrl+Enter and fires once for a held key', () => {
    const onSave = vi.fn()
    render(<Host initial="note" onSave={onSave} autoFocus={false} />)
    select(4, 4)

    expect(fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true })).toBe(false)
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true, repeat: true })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('calls onEscape for a plain Escape', () => {
    const onEscape = vi.fn()
    render(<Host initial="note" onEscape={onEscape} autoFocus={false} />)
    select(4, 4)
    fireEvent.keyDown(editor(), { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('lets Tab leave once Escape has been pressed', () => {
    const onEscape = vi.fn()
    render(<Host initial="note" onEscape={onEscape} autoFocus={false} />)
    select(4, 4)

    fireEvent.keyDown(editor(), { key: 'Escape' })
    // Tab is swallowed for indentation, so Escape arms a one-shot escape hatch;
    // without it a keyboard-only user could never leave the field.
    const tab = fireEvent.keyDown(editor(), { key: 'Tab' })
    expect(tab).toBe(true)
    expect(editor().value).toBe('note')
  })

  it('refuses to write past maxLength', () => {
    const onWrite = vi.fn()
    render(<Host initial="12345" maxLength={5} onWrite={onWrite} autoFocus={false} />)
    select(5, 5)
    press('粗体')
    expect(onWrite).not.toHaveBeenCalled()
    expect(editor().value).toBe('12345')
  })
})

describe('auto height', () => {
  /**
   * Fill mode is the composer's: the sheet owns the height, so the field must not
   * write one of its own. A stale inline pixel height would survive every resize
   * and pin the editor to whatever the content needed when the sheet opened.
   */
  it('writes no inline height in fill mode', () => {
    const reads: number[] = []
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => {
      reads.push(1)
      return 100_000
    })
    render(<Host initial="anything" fill />)
    const node = editor()
    expect(node.style.height).toBe('')
    expect(node.style.overflowY).toBe('')
    // The measurement is skipped entirely, not merely overridden: reading
    // scrollHeight forces a layout flush on every keystroke for nothing.
    expect(reads).toHaveLength(0)
  })

  it('marks its root as filling, so the sheet can size it', () => {
    render(<Host initial="x" fill />)
    const root = document.querySelector('.skw-ed-root') as HTMLElement
    expect(root.getAttribute('data-fill')).toBe('true')
  })

  it('observes no wrapper in fill mode', () => {
    // The observer exists to re-measure on a width change, and fill mode has
    // nothing to re-measure.
    let observed = 0
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void { observed += 1 }
        unobserve(): void {}
        disconnect(): void {}
      },
    )
    render(<Host initial="x" fill />)
    expect(observed).toBe(0)
  })

  it('clears a height it wrote before switching to fill mode', () => {
    const onChange = vi.fn()
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(140)
    const { rerender } = render(<MarkdownEditor value="a" onChange={onChange} label="正文" autoFocus={false} />)
    expect(editor().style.height).toBe('140px')
    rerender(<MarkdownEditor value="a" onChange={onChange} label="正文" autoFocus={false} fill />)
    expect(editor().style.height).toBe('')
  })

  it('measures the content and caps the growth', () => {
    const reads: number[] = []
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => {
      reads.push(1)
      return 120
    })
    render(<Host initial="short" />)
    const node = editor()
    // 120px of content fits under the 60%-of-viewport cap, so the box grows.
    expect(reads.length).toBeGreaterThan(0)
    expect(node.style.height).toBe('120px')
    expect(node.style.overflowY).toBe('hidden')
  })

  it('scrolls internally once the content exceeds the viewport cap', () => {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(100_000)
    render(<Host initial="long" />)
    const node = editor()
    const cap = Math.round(window.innerHeight * 0.6)
    expect(node.style.height).toBe(`${cap}px`)
    expect(node.style.overflowY).toBe('auto')
  })

  it('re-measures when the value changes from outside', () => {
    const reads: number[] = []
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => {
      reads.push(1)
      return 100
    })
    const onChange = vi.fn()
    const { rerender } = render(<MarkdownEditor value="a" onChange={onChange} label="正文" autoFocus={false} />)
    const before = reads.length
    rerender(<MarkdownEditor value={'a\nb\nc'} onChange={onChange} label="正文" autoFocus={false} />)
    expect(reads.length).toBeGreaterThan(before)
    expect(editor().style.height).toBe('100px')
  })

  it('observes its wrapper and disconnects the observer on unmount', () => {
    const observed: Element[] = []
    let disconnected = 0
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(target: Element): void {
          observed.push(target)
        }
        unobserve(): void {}
        disconnect(): void {
          disconnected += 1
        }
      },
    )
    const { unmount } = render(<Host initial="a" />)
    // The wrapper, never the textarea: observing the node whose height we write
    // is how a resize loop starts.
    expect(observed).toHaveLength(1)
    expect(observed[0]?.className).toBe('skw-ed-root')
    unmount()
    expect(disconnected).toBe(1)
  })
})

describe('lifecycle', () => {
  it('removes every listener it added on unmount', () => {
    interface Registration {
      where: 'textarea' | 'window'
      type: string
      fn: unknown
    }
    const added: Registration[] = []
    const removed: Registration[] = []

    const nodeAdd = HTMLTextAreaElement.prototype.addEventListener
    const nodeRemove = HTMLTextAreaElement.prototype.removeEventListener
    const windowAdd = window.addEventListener.bind(window)
    const windowRemove = window.removeEventListener.bind(window)

    vi.spyOn(HTMLTextAreaElement.prototype, 'addEventListener').mockImplementation(function (
      this: HTMLTextAreaElement,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      added.push({ where: 'textarea', type, fn: listener })
      nodeAdd.call(this, type, listener as EventListener, options)
    })
    vi.spyOn(HTMLTextAreaElement.prototype, 'removeEventListener').mockImplementation(function (
      this: HTMLTextAreaElement,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      removed.push({ where: 'textarea', type, fn: listener })
      nodeRemove.call(this, type, listener as EventListener, options)
    })
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener, options) => {
      added.push({ where: 'window', type, fn: listener })
      windowAdd(type, listener as EventListener, options)
    })
    vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, listener, options) => {
      removed.push({ where: 'window', type, fn: listener })
      windowRemove(type, listener as EventListener, options)
    })

    const onEscape = vi.fn()
    const { unmount } = render(<Host initial={'- item'} onEscape={onEscape} autoFocus={false} />)
    const node = select(6, 6)

    // The IME guard is the whole reason these exist: all four surfaces. jsdom
    // also registers its own "invalid" listener on a textarea, so the assertion
    // is about OUR types being present, not about the exact listener list.
    const types = added.filter((entry) => entry.where === 'textarea').map((entry) => entry.type)
    expect(types).toContain('compositionstart')
    expect(types).toContain('compositionend')
    expect(types).toContain('keyup')
    expect(added.some((entry) => entry.where === 'window' && entry.type === 'blur')).toBe(true)

    unmount()

    // Only the editor's own surfaces: React and jsdom register further listeners
    // on a textarea (jsdom's "invalid" handler, for one) that this component
    // never owned and must not be blamed for.
    const ours = new Set(['compositionstart', 'compositionend', 'keyup'])
    const key = (entry: Registration): string => `${entry.where}:${entry.type}:${String(entry.fn)}`
    const addedOurs = added.filter((entry) => (entry.where === 'textarea' ? ours.has(entry.type) : entry.type === 'blur' || entry.type === 'resize'))
    expect(addedOurs.length).toBeGreaterThanOrEqual(4)
    const removedKeys = new Set(removed.map(key))
    for (const entry of addedOurs) expect(removedKeys.has(key(entry))).toBe(true)

    // A detached node must not keep firing into a torn-down component.
    fireEvent.compositionStart(node)
    fireEvent.keyDown(node, { key: 'Escape' })
    fireEvent(window, new Event('blur'))
    expect(onEscape).not.toHaveBeenCalled()
  })

  it('respects autoFocus and the disabled state', () => {
    render(<Host initial="a" autoFocus={false} />)
    expect(document.activeElement).not.toBe(editor())
    cleanup()

    render(<Host initial="a" />)
    const node = editor()
    expect(document.activeElement).toBe(node)
    // Reopening a draft should start where writing left off.
    expect(node.selectionStart).toBe(1)
    cleanup()

    render(<Host initial="a" disabled />)
    expect(editor().disabled).toBe(true)
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps focus in the textarea when a toolbar button is pressed', () => {
    render(<Host initial="x" autoFocus={false} />)
    const node = select(1, 1)
    const button = screen.getByRole('button', { name: '斜体' })
    act(() => {
      fireEvent.mouseDown(button)
    })
    // preventDefault on mousedown is what stops the browser from moving focus to
    // the button before the click handler runs.
    expect(document.activeElement).toBe(node)
  })
})

/**
 * The indentation contract, shared with `src/markdown-parse.ts`.
 *
 * One level is two spaces, a line's level is `floor(leading columns / 2)`, and
 * the parser recognises every block marker on the whitespace-STRIPPED line — so
 * indentation never breaks syntax, and the editor's only job is to land on whole
 * levels. These tests pin that job down; the parser's half is covered by
 * `markdown.spec.tsx`.
 */
describe('indentation contract', () => {
  it('leaves a blank line alone instead of writing invisible whitespace', () => {
    // Blocker 1: Tab on an empty line wrote "  " — trailing whitespace nobody
    // can see, which Markdown then reads as content. The caret stays put too.
    render(<Host initial="" autoFocus={false} />)
    const node = select(0, 0)

    fireEvent.keyDown(node, { key: 'Tab' })

    expect(editor().value).toBe('')
    expect(editor().selectionStart).toBe(0)
  })

  it('leaves a whitespace-only line alone too', () => {
    // The same rule for a line someone already padded: indenting it would make
    // the invisible run longer, and there is no content to nest.
    render(<Host initial={'a\n   \nb'} autoFocus={false} />)
    select(3, 3)
    fireEvent.keyDown(editor(), { key: 'Tab' })
    expect(editor().value).toBe('a\n   \nb')
  })

  it('outdents a 3-space line all the way to column 0', () => {
    // Blocker 2: Shift+Tab removed exactly two spaces, so "   - item" (level 1,
    // because 3 spaces floors to 1) came back as " - item" — a level-0 line with
    // a stray space. It must land on the PREVIOUS whole level: 3 -> 0.
    render(<Host initial={'   - item'} autoFocus={false} />)
    select(10, 10)

    fireEvent.keyDown(editor(), { key: 'Tab', shiftKey: true })

    expect(editor().value).toBe('- item')
  })

  it('outdents one whole level at a time from a deeper line', () => {
    // 6 spaces is off every grid, so the first outdent SNAPS it onto the nearest
    // grid line (4). From there the document is a clean 4-space note, so the next
    // outdent lands on 0. Snapping is what keeps the result on a level the parser
    // reads as nesting instead of leaving a stray 1- or 3-space offset.
    render(<Host initial={'      deep'} autoFocus={false} />)
    select(10, 10)
    fireEvent.keyDown(editor(), { key: 'Tab', shiftKey: true })
    expect(editor().value).toBe('    deep')
    fireEvent.keyDown(editor(), { key: 'Tab', shiftKey: true })
    expect(editor().value).toBe('deep')
  })

  it('never leaves a stray space when outdenting an odd indent', () => {
    render(<Host initial={'   text'} autoFocus={false} />)
    select(7, 7)
    fireEvent.keyDown(editor(), { key: 'Tab', shiftKey: true })
    expect(editor().value).toBe('text')
    // Already flush: another outdent is a no-op, not a negative indent.
    fireEvent.keyDown(editor(), { key: 'Tab', shiftKey: true })
    expect(editor().value).toBe('text')
  })

  it('indents a list line into the next nesting level', () => {
    // Blocker 3: Tab on a list line must make it a CHILD of the item above, i.e.
    // exactly one more level — and the parser has to read it that way, which is
    // the half that makes this a real nesting test rather than a string test.
    render(<Host initial={'- a\n- b'} autoFocus={false} />)
    select(8, 8)

    fireEvent.keyDown(editor(), { key: 'Tab' })

    expect(editor().value).toBe('- a\n  - b')
    // The caret follows the two inserted characters into the indented line.
    expect(editor().selectionStart).toBe(9)
  })

  it('follows the document\'s own 4-space grid instead of forcing 2', () => {
    // A pasted or hand-written note commonly nests with 4 spaces. Tab used to add
    // 2, landing a child on 6 — between the document's levels — and Shift+Tab
    // walked 4 -> 2 -> 0, through an indent no other line used.
    render(<Host initial={'- parent\n    - child'} autoFocus={false} />)
    select(21, 21)
    fireEvent.keyDown(editor(), { key: 'Tab' })
    expect(editor().value).toBe('- parent\n        - child')
    fireEvent.keyDown(editor(), { key: 'Tab', shiftKey: true })
    expect(editor().value).toBe('- parent\n    - child')
    fireEvent.keyDown(editor(), { key: 'Tab', shiftKey: true })
    expect(editor().value).toBe('- parent\n- child')
  })

  it('keeps the 2-space step when the document declares no wider grid', () => {
    // One indented line is not a grid, so the documented default still applies.
    render(<Host initial={'- a\n  - b'} autoFocus={false} />)
    select(9, 9)
    fireEvent.keyDown(editor(), { key: 'Tab' })
    expect(editor().value).toBe('- a\n    - b')
  })

  it('nests one level per press, whatever the line started at', () => {
    // Appending a unit to any prefix raises floor(columns/2) by exactly one, so
    // Tab from a 3-space line reaches level 2 (5 spaces -> floor 2), not level 1.
    render(<Host initial={'   - a'} autoFocus={false} />)
    select(5, 5)
    fireEvent.keyDown(editor(), { key: 'Tab' })
    expect(editor().value).toBe('     - a')
    fireEvent.keyDown(editor(), { key: 'Tab' })
    expect(editor().value).toBe('       - a')
  })
})

/**
 * What Enter does on each kind of line.
 *
 * The rule the parser imposes is that a marker is only a marker at the start of
 * the stripped line, so continuation has to be decided per line KIND — a fence
 * owns its newlines, a table row repeats its column count, a quote repeats its
 * marker run, and prose carries its indent.
 */
describe('Enter continuation per line kind', () => {
  it('keeps the indent on a plain paragraph line', () => {
    // Blocker 4: Enter on "  paragraph" produced a flush new line, so an
    // indented paragraph lost its shape after the first line break.
    render(<Host initial={'  paragraph'} autoFocus={false} />)
    select(11, 11)

    fireEvent.keyDown(editor(), { key: 'Enter' })

    expect(editor().value).toBe('  paragraph\n  ')
    expect(editor().selectionStart).toBe(14)
  })

  it('still leaves a flush paragraph to the browser', () => {
    // The fix must not start reimplementing the browser's own newline: with no
    // indent to carry over there is nothing to insert, and preventing the default
    // would risk the IME for no gain.
    render(<Host initial={'plain text'} autoFocus={false} />)
    select(10, 10)
    expect(fireEvent.keyDown(editor(), { key: 'Enter' })).toBe(true)
    expect(editor().value).toBe('plain text')
  })

  it('deletes an empty list item without splitting the list', () => {
    // Blocker 5: Enter on the empty item of "- a\n- \n- b" removed only the
    // marker text and left the newline, so the list became two lists with a blank
    // line between them. The whole marker line goes instead.
    render(<Host initial={'- a\n- \n- b'} autoFocus={false} />)
    select(6, 6)

    fireEvent.keyDown(editor(), { key: 'Enter' })

    expect(editor().value).toBe('- a\n- b')
    expect(editor().selectionStart).toBe(4)
  })

  it('ends a list at the end of the note without leaving a trailing blank', () => {
    // The same repair where there is no following line: the marker goes and the
    // caret lands at the end, with no extra newline left behind.
    render(<Host initial={'a\n- '} autoFocus={false} />)
    select(4, 4)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(editor().value).toBe('a\n')
    expect(editor().selectionStart).toBe(2)
  })

  it('inserts a plain newline inside a fenced code block', () => {
    // Blocker 6: the list continuation ran INSIDE the fence, injecting "- " into
    // the user's code. A fence owns its newlines: Enter is a plain newline.
    render(<Host initial={'```\n- code line\n```'} autoFocus={false} />)
    select(15, 15)

    fireEvent.keyDown(editor(), { key: 'Enter' })

    expect(editor().value).toBe('```\n- code line\n\n```')
    expect(editor().selectionStart).toBe(16)
  })

  it('keeps a tilde fence inert as well', () => {
    render(<Host initial={'~~~\n1. code\n~~~'} autoFocus={false} />)
    select(11, 11)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(editor().value).toBe('~~~\n1. code\n\n~~~')
  })

  it('treats text after a CLOSED fence as prose again', () => {
    // The fence marking has to end with the closing fence, or every later list
    // in the note would silently stop continuing.
    render(<Host initial={'```\nx\n```\n- item'} autoFocus={false} />)
    select(16, 16)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(editor().value).toBe('```\nx\n```\n- item\n- ')
  })

  it('continues a blockquote', () => {
    // Blocker 7: Enter on "> quoted" did nothing at all, because only list
    // markers were recognised.
    render(<Host initial={'> quoted'} autoFocus={false} />)
    select(8, 8)

    fireEvent.keyDown(editor(), { key: 'Enter' })

    expect(editor().value).toBe('> quoted\n> ')
    expect(editor().selectionStart).toBe(11)
  })

  it('keeps nested quote depth', () => {
    // The whole marker run is copied, so "> > deep" continues at the same depth
    // instead of silently dropping a level.
    render(<Host initial={'> > deep'} autoFocus={false} />)
    select(8, 8)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(editor().value).toBe('> > deep\n> > ')
  })

  it('closes an empty quote instead of stacking markers', () => {
    render(<Host initial={'> '} autoFocus={false} />)
    select(2, 2)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(editor().value).toBe('')
  })

  it('continues a table with a row of the same column count', () => {
    // Blocker 8: Enter on a table row was ignored, so the writer had to type
    // pipes by hand — and a row one cell short breaks the table.
    const table = '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |'
    render(<Host initial={table} autoFocus={false} />)
    select(table.length, table.length)

    fireEvent.keyDown(editor(), { key: 'Enter' })

    const lines = editor().value.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe('|   |   |   |')
    // The caret sits inside the new row's first cell, ready to type — the same
    // "after `| `" position the table skeleton uses.
    expect(editor().selectionStart).toBe(editor().value.indexOf('|   |   |   |') + 2)
  })

  it('counts the columns of a two-column table', () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    render(<Host initial={table} autoFocus={false} />)
    select(table.length, table.length)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(editor().value.split('\n')[3]).toBe('|   |   |')
  })

  it('appends below the table when Enter is pressed on the header row', () => {
    // Inserting a row directly under the header would push the divider away and
    // split the table into a one-row table plus a paragraph. The new row belongs
    // after the LAST body row, so the table stays whole either way round.
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    render(<Host initial={table} autoFocus={false} />)
    // Caret at the end of the header line.
    select(9, 9)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(editor().value.split('\n')).toEqual([
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '|   |   |',
    ])
  })

  it('leaves a caret in the middle of a table row to the browser', () => {
    // Splitting a cell is the browser's own job. Falling through to the paragraph
    // rule would also duplicate an indented row's indent into a stray line.
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    render(<Host initial={table} autoFocus={false} />)
    select(20, 20)
    expect(fireEvent.keyDown(editor(), { key: 'Enter' })).toBe(true)
    expect(editor().value).toBe(table)
  })

  it('does not turn a pipe in prose into a table row', () => {
    // "a | b" is a paragraph, not a table: there is no divider row under it, so
    // Enter must be the browser's plain newline.
    render(<Host initial={'a | b'} autoFocus={false} />)
    select(5, 5)
    expect(fireEvent.keyDown(editor(), { key: 'Enter' })).toBe(true)
    expect(editor().value).toBe('a | b')
  })

  it('leaves Shift+Enter to the writer as a plain newline', () => {
    render(<Host initial={'- item'} autoFocus={false} />)
    select(6, 6)
    // Shift+Enter is the explicit "break the line, not the item" gesture.
    expect(fireEvent.keyDown(editor(), { key: 'Enter', shiftKey: true })).toBe(true)
    expect(editor().value).toBe('- item')
  })
})

/**
 * Hiding the editor without unmounting it.
 *
 * The composer's preview toggle needs the textarea to stay in the tree: a
 * remount throws the selection away, and no caret arithmetic can reconstruct it.
 * The hiding mechanism matters too — `.skw-ed-root` sets `display: flex`, an
 * author rule that beats the UA sheet's `[hidden] { display: none }`.
 */
describe('hidden prop', () => {
  it('hides the root with an inline display:none and keeps the same node', () => {
    const { rerender } = render(<MarkdownEditor value="abc" onChange={() => {}} label="正文" autoFocus={false} />)
    const root = document.querySelector('.skw-ed-root') as HTMLElement
    expect(root.style.display).toBe('')

    rerender(<MarkdownEditor value="abc" onChange={() => {}} label="正文" autoFocus={false} hidden />)

    // The same element object: still mounted, only invisible.
    expect(document.querySelector('.skw-ed-root')).toBe(root)
    expect(root.style.display).toBe('none')
    // The attribute is a marker, not the mechanism; ARIA needs the hidden state
    // spelled out too, or a screen reader still walks the invisible toolbar.
    expect(root.getAttribute('data-hidden')).toBe('true')
    expect(root.getAttribute('aria-hidden')).toBe('true')
  })

  it('comes back visible with its value and selection intact', () => {
    function Toggle(): JSX.Element {
      const [hidden, setHidden] = useState(false)
      return (
        <div>
          <button type="button" onClick={() => setHidden((value) => !value)}>toggle</button>
          <MarkdownEditor value="hello world" onChange={() => {}} label="正文" autoFocus={false} hidden={hidden} />
        </div>
      )
    }
    render(<Toggle />)
    const node = select(5, 5)
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    expect((document.querySelector('.skw-ed-root') as HTMLElement).style.display).toBe('none')
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))

    expect((document.querySelector('.skw-ed-root') as HTMLElement).style.display).toBe('')
    expect(editor()).toBe(node)
    expect(editor().value).toBe('hello world')
    expect(editor().selectionStart).toBe(5)
  })

  it('gives focus back on unhide without moving the selection', () => {
    // The preview toggle takes focus onto its button, and the old remount used to
    // re-focus the fresh textarea. Keeping the node mounted must restore the
    // focus too — but never the selection, which is already exactly right.
    function Toggle(): JSX.Element {
      const [hidden, setHidden] = useState(false)
      return (
        <div>
          <button type="button" onClick={() => setHidden((value) => !value)}>toggle</button>
          <MarkdownEditor value="hello world" onChange={() => {}} label="正文" autoFocus={false} hidden={hidden} />
        </div>
      )
    }
    render(<Toggle />)
    const node = select(5, 5)
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    // jsdom does not move focus on a button click the way a browser does, so the
    // shift the toggle causes is made explicit here: the editor is not focused.
    act(() => {
      node.blur()
    })
    expect(document.activeElement).not.toBe(node)
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))

    expect(document.activeElement).toBe(node)
    expect(node.selectionStart).toBe(5)
    expect(node.selectionEnd).toBe(5)
  })

  it('carries a CSS fallback for the data attribute', () => {
    // Belt and braces: a caller that sets the attribute without the inline style
    // must still get a hidden editor, so the stylesheet needs the rule too.
    expect(EDITOR_CSS).toContain('.skw-ed-root[data-hidden="true"]')
  })
})

/**
 * Toolbar copy through the shared dictionary.
 *
 * The editor may not import `text.ts` (the browser module table only resolves
 * `react`), so the Composer passes its `t` in. Without one the built-in labels
 * are used, which is what keeps every existing caller working.
 */
describe('toolbar localization', () => {
  /** The toolbar's accessible name, and one button's, for a given render. */
  function labels(): { toolbar: string; h1: string; rule: string; codeBlock: string } {
    const toolbar = screen.getByRole('toolbar')
    const byAction = (id: string): string =>
      document.querySelector(`.skw-ed-btn[data-action="${id}"]`)?.getAttribute('aria-label') ?? ''
    return {
      toolbar: toolbar.getAttribute('aria-label') ?? '',
      h1: byAction('h1'),
      rule: byAction('rule'),
      codeBlock: byAction('code-block'),
    }
  }

  it('uses the dictionary when a translate function is passed', () => {
    // The Composer's own `t`, against the shipped English dictionary.
    const t = (key: string): string => textOf(en, key)
    render(<MarkdownEditor value="" onChange={() => {}} label="正文" autoFocus={false} t={t} />)

    const copy = labels()
    expect(copy.toolbar).toBe(en.toolbarLabel)
    expect(copy.h1).toBe(en.mdH1)
    // The two ids that a naive `md + capitalise(id)` scheme gets wrong.
    expect(copy.rule).toBe(en.mdHr)
    expect(copy.codeBlock).toBe(en.mdCodeBlock)
  })

  it('re-translates when the dictionary changes', () => {
    const { rerender } = render(
      <MarkdownEditor value="" onChange={() => {}} label="正文" autoFocus={false} t={(key) => textOf(en, key)} />,
    )
    expect(labels().h1).toBe(en.mdH1)
    rerender(
      <MarkdownEditor value="" onChange={() => {}} label="正文" autoFocus={false} t={(key) => textOf(zh, key)} />,
    )
    expect(labels().h1).toBe(zh.mdH1)
  })

  it('falls back to the built-in Chinese labels without a translate function', () => {
    // Backward compatibility: an existing caller that never heard of `t` must
    // still get real words, not raw dictionary keys.
    render(<MarkdownEditor value="" onChange={() => {}} label="正文" autoFocus={false} />)
    expect(labels().toolbar).toBe('编辑工具栏')
    expect(labels().h1).toBe('一级标题')
    expect(labels().rule).toBe('分割线')
    expect(labels().codeBlock).toBe('代码块')
  })

  it('prefers the built-in label when the dictionary is missing a key', () => {
    // `textOf` falls back to the KEY itself, which would paint "mdH1" on a
    // button. A missing translation must degrade to the built-in label instead.
    render(<MarkdownEditor value="" onChange={() => {}} label="正文" autoFocus={false} t={(key) => key} />)
    expect(labels().h1).toBe('一级标题')
  })

  it('maps every toolbar key to a non-empty string in both dictionaries', () => {
    // One pass over the real toolbar locks all 21 keys: a group or action added
    // without a key (or a key renamed in text.ts) fails here rather than
    // rendering a raw key name in the UI.
    expect(TOOLBAR_KEYS.length).toBe(22)
    for (const key of TOOLBAR_KEYS) {
      expect(textOf(zh, key), `zh:${key}`).not.toBe(key)
      expect(textOf(en, key), `en:${key}`).not.toBe(key)
      expect(textOf(zh, key).trim(), `zh:${key}`).not.toBe('')
      expect(textOf(en, key).trim(), `en:${key}`).not.toBe('')
    }
  })
})

describe('indentLevelOf', () => {
  it('measures a line the way the parser measures it', () => {
    // floor(leading columns / 2), with a tab counting as one level — the exact
    // rule `src/markdown-parse.ts` uses for `indent`.
    expect(indentLevelOf('text')).toBe(0)
    expect(indentLevelOf(' text')).toBe(0)
    expect(indentLevelOf('  text')).toBe(1)
    expect(indentLevelOf('   text')).toBe(1)
    expect(indentLevelOf('     text')).toBe(2)
    expect(indentLevelOf('\ttext')).toBe(1)
    expect(indentLevelOf('\t\ttext')).toBe(2)
  })
})
