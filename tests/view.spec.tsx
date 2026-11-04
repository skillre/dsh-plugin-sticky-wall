// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientApi } from '../src/client/api.js'
import { ActionError } from '../src/client/api.js'
import type { ClientLocaleLike } from '../src/client/contracts.js'
import { en, textOf } from '../src/client/text.js'
import type { Translate } from '../src/client/text.js'
import { ConfirmDialog, WallPage } from '../src/client/view.jsx'
import type { Note } from '../src/types.js'

/**
 * Client component behavior tests.
 *
 * These cover the failure modes a bundle-level test cannot see: double submit,
 * the archived filter's data scope, reload-after-failure, and the destructive
 * dialog's keyboard contract.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Translate through the shipped English dictionary so copy is stable. */
const t: Translate = (key, params) => {
  const template = textOf(en, key)
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

/** Dictionary value as a plain string for assertions. */
const copy = (key: string): string => textOf(en, key)

/** A locale service double that never switches locale. */
const locale: ClientLocaleLike = {
  getSnapshot: () => ({ active: 'en', locales: [{ id: 'en' }], revision: 0 }),
  subscribe: () => () => {},
  register: () => () => {},
  bind: () => t,
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    title: '',
    body: 'hello',
    tags: [],
    color: 'yellow',
    pinned: false,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A ClientApi double recording every call, with overridable behavior. */
function makeApi(overrides: Partial<ClientApi> = {}): ClientApi & { calls: string[] } {
  const calls: string[] = []
  const api: ClientApi = {
    async list(includeArchived, sort) {
      calls.push(`list:${String(includeArchived)}:${sort}`)
      return overrides.list ? await overrides.list(includeArchived, sort) : [makeNote()]
    },
    async create(input) {
      calls.push('create')
      if (overrides.create) return overrides.create(input)
      return makeNote({ id: 'created', body: input.body })
    },
    async update(id, patch) {
      calls.push('update')
      if (overrides.update) return overrides.update(id, patch)
      return makeNote({ id, ...(patch as Partial<Note>) })
    },
    async archive(ids, archived) {
      calls.push('archive')
      if (overrides.archive) return overrides.archive(ids, archived)
      return ids.map((id) => makeNote({ id, archived }))
    },
    async remove(ids) {
      calls.push('remove')
      if (overrides.remove) return overrides.remove(ids)
      return ids
    },
    async clearArchived() {
      calls.push('clearArchived')
      if (overrides.clearArchived) return overrides.clearArchived()
      return []
    },
  }
  return Object.assign(api, { calls })
}

/** Open the composer and fill its body, then press the save shortcut. */
async function composeAndSave(body: string): Promise<void> {
  fireEvent.click(screen.getByText(/New/))
  await waitFor(() => expect(document.querySelector('.skw-textarea')).not.toBeNull())
  fireEvent.change(document.querySelector('.skw-textarea')!, { target: { value: body } })
}

describe('wall page', () => {
  it('loads the archived set when the archived filter is selected', async () => {
    const api = makeApi({ list: async () => [makeNote({ id: 'a', archived: true })] })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(api.calls).toContain('list:false:pinned'))
    fireEvent.click(screen.getByRole('button', { name: /Archive/ }))
    await waitFor(() => expect(api.calls).toContain('list:true:pinned'))
    // The archived note is visible, so the "empty archive" copy is not shown.
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBeGreaterThan(0))
    expect(screen.queryByText(copy('emptyArchived'))).toBeNull()
  })

  it('offers clear-archived whenever an archived note exists', async () => {
    const api = makeApi({ list: async () => [makeNote({ id: 'a', archived: true })] })
    render(<WallPage api={api} locale={locale} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /Show archived/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: copy('clearArchived') })).toBeTruthy())
  })

  it('reloads after a failed mutation so a partial write cannot stay hidden', async () => {
    const api = makeApi({ update: async () => { throw new ActionError('sticky-wall/internal', 'nope') } })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    const before = api.calls.filter((call) => call.startsWith('list:')).length
    // The filter segment also carries the "Pin" label; the card action is the
    // one inside a note card.
    const card = document.querySelector('.skw-note')!
    fireEvent.click(card.querySelector('button[aria-label="' + copy('pin') + '"]')!)
    await waitFor(() => expect(api.calls.filter((call) => call.startsWith('list:')).length).toBeGreaterThan(before))
    await waitFor(() => expect(document.querySelector('.skw-error')).not.toBeNull())
  })

  it('submits a note once even when the save shortcut fires twice', async () => {
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await composeAndSave('double submit check')
    const sheet = document.querySelector('.skw-sheet')!
    fireEvent.keyDown(sheet, { key: 'Enter', metaKey: true })
    fireEvent.keyDown(sheet, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(api.calls.filter((call) => call === 'create')).toHaveLength(1))
  })

  it('ignores an auto-repeated save shortcut', async () => {
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await composeAndSave('repeat check')
    fireEvent.keyDown(document.querySelector('.skw-sheet')!, { key: 'Enter', metaKey: true, repeat: true })
    expect(api.calls.filter((call) => call === 'create')).toHaveLength(0)
  })

  it('renders a distinct message when a search matches nothing', async () => {
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz-no-match' } })
    await waitFor(() => expect(screen.getByText(copy('noResults'))).toBeTruthy())
  })
})

describe('note card layout', () => {
  it('keeps the actions inside the header row instead of overlaying the text', async () => {
    // Regression: the actions used to be an absolute overlay pinned to the
    // card's top-right corner, which covered a long title and hid the body.
    const api = makeApi({
      list: async () => [makeNote({ title: '一个很长很长很长很长很长很长的便签标题', body: '正文' })],
    })
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    const card = document.querySelector('.skw-note')!
    const head = card.querySelector('.skw-note-head')!
    const tools = card.querySelector('.skw-note-tools')!
    // The actions belong to the header row, and are not absolutely positioned.
    expect(head.contains(tools)).toBe(true)
    expect(getComputedStyle(tools).position).not.toBe('absolute')
    // The title and the actions are siblings in the same row, not stacked.
    const title = head.querySelector('.skw-note-title')!
    expect(head.contains(title)).toBe(true)
    expect(title.parentElement).toBe(head)
    // The header reserves height even while the actions are hidden on hover.
    expect(getComputedStyle(head).minHeight).not.toBe('')
  })

  it('leaves the body and footer outside the header row', async () => {
    const api = makeApi()
    render(<WallPage api={api} locale={locale} t={t} />)
    await waitFor(() => expect(document.querySelectorAll('.skw-note').length).toBe(1))
    const card = document.querySelector('.skw-note')!
    const head = card.querySelector('.skw-note-head')!
    expect(head.contains(card.querySelector('.skw-note-body'))).toBe(false)
    expect(head.contains(card.querySelector('.skw-note-foot'))).toBe(false)
  })
})

describe('confirm dialog', () => {
  it('is a labelled modal that Escape dismisses', () => {
    const onCancel = vi.fn()
    render(
      <ConfirmDialog title={copy('delete')} message={copy('confirmDelete')} confirmLabel={copy('delete')} cancelLabel={copy('cancel')} busy={false}
        onConfirm={() => {}} onCancel={onCancel} />,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe(copy('delete'))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('focuses Cancel on open and restores the previous focus on close', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const { unmount } = render(
      <ConfirmDialog title={copy('delete')} message={copy('confirmDelete')} confirmLabel={copy('delete')} cancelLabel={copy('cancel')} busy={false}
        onConfirm={() => {}} onCancel={() => {}} />,
    )
    await waitFor(() => expect(document.activeElement?.textContent).toBe(copy('cancel')))
    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('does not confirm twice on a repeated click', () => {
    let confirmed = 0
    render(
      <ConfirmDialog title={copy('delete')} message={copy('confirmDelete')} confirmLabel={copy('delete')} cancelLabel={copy('cancel')} busy={true}
        onConfirm={() => { confirmed += 1 }} onCancel={() => {}} />,
    )
    const button = screen.getByRole('button', { name: copy('delete') })
    act(() => { fireEvent.click(button) })
    expect(confirmed).toBe(0)
  })
})
