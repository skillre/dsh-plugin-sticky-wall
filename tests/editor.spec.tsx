// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from '../src/client/editor.jsx'

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
      disabled={props.disabled ?? false}
      locale={props.locale ?? 'zh'}
      // `exactOptionalPropertyTypes` forbids passing `undefined`, and an editor
      // without a limit must not receive one.
      {...(props.maxLength === undefined ? {} : { maxLength: props.maxLength })}
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

  it('stays guarded between compositionend and the closing keyup, then recovers', () => {
    const onSave = vi.fn()
    const onEscape = vi.fn()
    render(<Host initial={'- item'} onSave={onSave} onEscape={onEscape} autoFocus={false} />)
    const node = select(6, 6)

    fireEvent.compositionStart(node)
    fireEvent.compositionEnd(node)
    // One keydown still arrives after compositionend on some IMEs; without the
    // justEnded latch that Enter would also continue the list.
    fireEvent.keyDown(node, { key: 'Escape' })
    fireEvent.keyDown(node, { key: 'Enter' })
    expect(onEscape).not.toHaveBeenCalled()
    expect(node.value).toBe('- item')

    fireEvent.keyUp(node, { key: 'Process' })
    fireEvent.keyDown(node, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
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

  it('wraps italic, strike, inline code and a link', () => {
    render(<Host initial={'word'} autoFocus={false} />)
    select(0, 4)
    press('斜体')
    expect(editor().value).toBe('_word_')
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
