/**
 * The sticky wall page and its composer sheet.
 *
 * State rules: the Host owns every note; this page holds only view state
 * (search text, sort, filter) plus the last snapshot it received. Every
 * mutation goes to the Host and the response is reconciled in place, so two
 * windows on the same wall converge instead of fighting over local state.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note, NoteColor, NotePatch } from '../types.js'
import type { ClientApi } from './api.js'
import { ActionError } from './api.js'
import type { ClientLocaleLike } from './contracts.js'
import { SWATCHES, WALL_CSS } from './styles.js'
import type { Translate } from './text.js'

/** Which notes the wall shows. */
type Filter = 'all' | 'pinned' | 'archived'
/** The orderings the Host accepts. */
type Sort = 'pinned' | 'created' | 'updated'

/** One draft the composer edits; a null id means "new note". */
interface Draft {
  id: string | null
  title: string
  body: string
  tags: string
  color: NoteColor
}

/** Props the `main` slot passes through; the wall owns its own data. */
export interface WallPageProps {
  api: ClientApi
  locale: ClientLocaleLike
  t: Translate
}

/** The sidebar glyph: a small stack of notes, sized by the sidebar slot. */
export function SidebarGlyph({ size = 18 }: { size?: number; active?: boolean }): JSX.Element {
  return (
    <svg className="skw-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="7.5" width="11.5" height="11.5" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.5 5.2h8.2a2.4 2.4 0 0 1 2.4 2.4v8.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M6.9 11h5.7M6.9 14.4h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.75" />
    </svg>
  )
}

/** Localized relative time; falls back to the date for older notes. */
function formatTime(iso: string, locale: string): string {
  const stamp = new Date(iso)
  if (Number.isNaN(stamp.getTime())) return iso
  const now = Date.now()
  const minutes = Math.round((now - stamp.getTime()) / 60_000)
  const zh = locale.toLowerCase().startsWith('zh')
  if (minutes < 1) return zh ? '刚刚' : 'just now'
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return zh ? `${days} 天前` : `${days}d ago`
  return stamp.toLocaleDateString(zh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' })
}

/** Split a comma/space separated tag field into the list the Host accepts. */
function parseTags(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
}

/** The composer sheet: create or edit one note. */
function Composer({
  draft,
  t,
  busy,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft
  t: Translate
  busy: boolean
  error: string
  onChange(patch: Partial<Draft>): void
  onSave(): void
  onCancel(): void
}): JSX.Element {
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    bodyRef.current?.focus()
  }, [])
  return (
    <div className="skw-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}>
      <div className="skw-sheet" role="dialog" aria-modal="true" aria-label={draft.id ? t('edit') : t('new')}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) onCancel()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !busy) onSave()
        }}>
        <div className="skw-sheet-head">{draft.id ? t('edit') : t('new')}</div>
        <div className="skw-sheet-body">
          <input className="skw-input" value={draft.title} placeholder={t('titlePlaceholder')} maxLength={120}
            onChange={(event) => onChange({ title: event.target.value })} aria-label={t('titlePlaceholder')} />
          <textarea ref={bodyRef} className="skw-textarea" value={draft.body} placeholder={t('bodyPlaceholder')} maxLength={4000}
            onChange={(event) => onChange({ body: event.target.value })} aria-label={t('bodyPlaceholder')} />
          <input className="skw-input" value={draft.tags} placeholder={t('tagsPlaceholder')}
            onChange={(event) => onChange({ tags: event.target.value })} aria-label={t('tagsPlaceholder')} />
          <div className="skw-swatches" role="group" aria-label={t('colorLabel')}>
            {SWATCHES.map((swatch) => (
              <button key={swatch.key} type="button" className="skw-swatch" data-on={draft.color === swatch.key}
                style={{ background: swatch.css }} aria-label={swatch.key} aria-pressed={draft.color === swatch.key}
                onClick={() => onChange({ color: swatch.key as NoteColor })} />
            ))}
          </div>
          {error !== '' && <p className="skw-error" role="alert">{error}</p>}
        </div>
        <div className="skw-sheet-foot">
          <span className="skw-hint">{t('saveHint')}</span>
          <span className="skw-spacer" />
          <button className="skw-btn" type="button" onClick={onCancel} disabled={busy}>{t('cancel')}</button>
          <button className="skw-btn skw-btn-primary" type="button" onClick={onSave} disabled={busy}>{t('save')}</button>
        </div>
      </div>
    </div>
  )
}

/** One note card; every action is a Host mutation with an optimistic-free flow. */
function NoteCard({ note, t, locale, onEdit, onPatch, onRemove }: {
  note: Note
  t: Translate
  locale: string
  onEdit(note: Note): void
  onPatch(note: Note, patch: NotePatch): void
  onRemove(note: Note): void
}): JSX.Element {
  return (
    <article className="skw-note" data-color={note.color} data-pinned={note.pinned} data-archived={note.archived}
      aria-label={note.title || note.body.slice(0, 40)} tabIndex={0}
      onDoubleClick={() => onEdit(note)}>
      <div className="skw-note-tools">
        <button className="skw-icon-btn" type="button" title={note.pinned ? t('unpin') : t('pin')}
          data-on={note.pinned} aria-label={note.pinned ? t('unpin') : t('pin')}
          onClick={() => onPatch(note, { pinned: !note.pinned })}>
          <span className="skw-pin" aria-hidden="true">{note.pinned ? '★' : '☆'}</span>
        </button>
        <button className="skw-icon-btn" type="button" title={t('edit')} aria-label={t('edit')} onClick={() => onEdit(note)}>✎</button>
        <button className="skw-icon-btn" type="button" title={note.archived ? t('restore') : t('archive')}
          aria-label={note.archived ? t('restore') : t('archive')}
          onClick={() => onPatch(note, { archived: !note.archived })}>{note.archived ? '↩' : '▤'}</button>
        <button className="skw-icon-btn" type="button" title={t('delete')} aria-label={t('delete')} onClick={() => onRemove(note)}>✕</button>
      </div>
      {note.title !== '' && <div className="skw-note-head"><span className="skw-note-title">{note.title}</span></div>}
      <p className="skw-note-body is-clamped">{note.body}</p>
      {note.tags.length > 0 && <div className="skw-note-tags">{note.tags.map((tag) => <span key={tag} className="skw-tag">#{tag}</span>)}</div>}
      <div className="skw-note-foot">
        <span>{formatTime(note.updatedAt, locale)}</span>
        <span className="skw-spacer" />
        {note.archived && <span>{t('archive')}</span>}
        {note.pinned && <span aria-hidden="true">★</span>}
      </div>
    </article>
  )
}

/** The wall page mounted into the `main` slot. */
export function WallPage({ api, locale, t }: WallPageProps): JSX.Element {
  const [notes, setNotes] = useState<Note[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('pinned')
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftError, setDraftError] = useState('')
  const [confirming, setConfirming] = useState<'clear' | Note | null>(null)
  // Re-render on locale switch: relative times and copy are read from the
  // active locale, so the page must observe the locale revision.
  const [, setLocaleRevision] = useState(0)
  const alive = useRef(true)
  const life = useRef(new AbortController())
  const sequence = useRef(0)

  const activeLocale = locale.getSnapshot().active

  // Track locale switches so relative times and copy re-render without a reload.
  useEffect(() => {
    const unsubscribe = locale.subscribe(() => {
      if (alive.current) setLocaleRevision((value) => value + 1)
    })
    return unsubscribe
  }, [locale])

  const reload = useMemo(() => async (options: { includeArchived: boolean; sort: Sort }): Promise<void> => {
    const seq = ++sequence.current
    setLoading(true)
    try {
      const next = await api.list(options.includeArchived, options.sort, life.current.signal)
      if (alive.current && seq === sequence.current) {
        setNotes(next)
        setError('')
      }
    } catch (cause) {
      if (alive.current && seq === sequence.current && !life.current.signal.aborted) setError(errorText(cause, t))
    } finally {
      if (alive.current && seq === sequence.current) setLoading(false)
    }
  }, [api, t])

  useEffect(() => {
    alive.current = true
    life.current = new AbortController()
    void reload({ includeArchived: showArchived, sort })
    return () => {
      alive.current = false
      life.current.abort()
      sequence.current += 1
    }
  }, [reload, showArchived, sort])


  /** Run one mutation, reconcile the response, and surface the failure inline. */
  async function mutate(run: () => Promise<Note[] | string[] | void>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await run()
      await reload({ includeArchived: showArchived, sort })
    } catch (cause) {
      if (alive.current && !life.current.signal.aborted) setError(errorText(cause, t))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  function openComposer(note?: Note): void {
    setDraftError('')
    setDraft(note
      ? { id: note.id, title: note.title, body: note.body, tags: note.tags.join(' '), color: note.color }
      : { id: null, title: '', body: '', tags: '', color: 'yellow' })
  }

  async function saveDraft(): Promise<void> {
    if (!draft) return
    const body = draft.body.trim()
    if (body === '') {
      setDraftError(t('emptyBody'))
      return
    }
    setDraftError('')
    await mutate(async () => {
      const tags = parseTags(draft.tags)
      if (draft.id === null) {
        await api.create({ body, title: draft.title.trim(), tags, color: draft.color }, life.current.signal)
      } else {
        await api.update(draft.id, { body, title: draft.title.trim(), tags, color: draft.color }, life.current.signal)
      }
      setDraft(null)
    })
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return notes.filter((note) => {
      if (filter === 'archived' && !note.archived) return false
      if (filter === 'pinned' && !note.pinned) return false
      if (filter === 'all' && note.archived && !showArchived) return false
      if (needle === '') return true
      return `${note.title} ${note.body} ${note.tags.join(' ')}`.toLowerCase().includes(needle)
    })
  }, [notes, filter, query, showArchived])

  const archivedCount = notes.filter((note) => note.archived).length

  return (
    <section className="skw-page" aria-label={t('title')}>
      <style>{WALL_CSS}</style>
      <header className="skw-head">
        <div className="skw-head-text">
          <h1 className="skw-title">{t('title')}</h1>
          <p className="skw-subtitle">{t('subtitle')}</p>
        </div>
        <div className="skw-actions">
          {archivedCount > 0 && (
            <button className="skw-btn skw-btn-quiet" type="button" onClick={() => setConfirming('clear')} disabled={busy}>
              {t('clearArchived')}
            </button>
          )}
          <button className="skw-btn skw-btn-primary" type="button" onClick={() => openComposer()} disabled={busy}>
            + {t('new')}
          </button>
        </div>
      </header>

      <div className="skw-toolbar">
        <input className="skw-search" type="search" value={query} placeholder={t('search')} aria-label={t('search')}
          onChange={(event) => setQuery(event.target.value)} />
        <div className="skw-seg" role="group" aria-label={t('all')}>
          {(['all', 'pinned', 'archived'] as const).map((key) => (
            <button key={key} type="button" data-on={filter === key} onClick={() => setFilter(key)}>
              {key === 'all' ? t('all') : key === 'pinned' ? t('pin') : t('archive')}
            </button>
          ))}
        </div>
        <button className="skw-toggle" type="button" data-on={showArchived} aria-pressed={showArchived}
          onClick={() => setShowArchived((value) => !value)}>
          {showArchived ? t('hideArchived') : t('showArchived')}
        </button>
        <div className="skw-seg" role="group" aria-label={t('sortPinned')}>
          {(['pinned', 'created', 'updated'] as const).map((key) => (
            <button key={key} type="button" data-on={sort === key} onClick={() => setSort(key)}>
              {key === 'pinned' ? t('sortPinned') : key === 'created' ? t('sortCreated') : t('sortUpdated')}
            </button>
          ))}
        </div>
        <span className="skw-count">{t('count', { count: visible.length })}</span>
      </div>

      <div className="skw-body">
        {error !== '' && (
          <p className="skw-error" role="alert">
            {error} <button className="skw-btn skw-btn-quiet" type="button" onClick={() => void reload({ includeArchived: showArchived, sort })}>{t('retry')}</button>
          </p>
        )}
        {loading && notes.length === 0 ? (
          <div className="skw-empty"><p>{t('loading')}</p></div>
        ) : visible.length === 0 ? (
          <div className="skw-empty">
            <span className="skw-empty-icon" aria-hidden="true">🗒️</span>
            <p>{filter === 'archived' ? t('emptyArchived') : query.trim() !== '' ? t('failed') : t('empty')}</p>
            {filter !== 'archived' && query.trim() === '' && (
              <button className="skw-btn" type="button" onClick={() => openComposer()}>{t('new')}</button>
            )}
          </div>
        ) : (
          <div className="skw-grid">
            {visible.map((note) => (
              <NoteCard key={note.id} note={note} t={t} locale={activeLocale}
                onEdit={openComposer}
                onPatch={(target, patch) => void mutate(async () => { await api.update(target.id, patch, life.current.signal) })}
                onRemove={(target) => setConfirming(target)} />
            ))}
          </div>
        )}
      </div>

      {draft && (
        <Composer draft={draft} t={t} busy={busy} error={draftError}
          onChange={(patch) => setDraft((current) => (current === null ? current : { ...current, ...patch }))}
          onSave={() => void saveDraft()}
          onCancel={() => { if (!busy) { setDraft(null); setDraftError('') } }} />
      )}

      {confirming !== null && (
        <div className="skw-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setConfirming(null) }}>
          <div className="skw-sheet" role="dialog" aria-modal="true" style={{ width: 'min(420px, 100%)' }}>
            <div className="skw-sheet-head">{confirming === 'clear' ? t('clearArchived') : t('delete')}</div>
            <div className="skw-sheet-body">
              <p style={{ margin: 0 }}>{confirming === 'clear' ? t('confirmClear') : t('confirmDelete')}</p>
            </div>
            <div className="skw-sheet-foot">
              <span className="skw-spacer" />
              <button className="skw-btn" type="button" onClick={() => setConfirming(null)} disabled={busy}>{t('cancel')}</button>
              <button className="skw-btn skw-btn-danger" type="button" disabled={busy}
                onClick={() => {
                  const target = confirming
                  setConfirming(null)
                  void mutate(async () => {
                    if (target === 'clear') await api.clearArchived(life.current.signal)
                    else await api.remove([target.id], life.current.signal)
                  })
                }}>{t('delete')}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/** Translate one thrown value into display text the user can act on. */
function errorText(cause: unknown, t: Translate): string {
  if (cause instanceof ActionError) {
    const known: Record<string, string> = {
      'sticky-wall/empty-body': 'emptyBody',
      'sticky-wall/wall-full': 'wallFull',
      'sticky-wall/body-too-long': 'tooLong',
      'sticky-wall/title-too-long': 'tooLong',
    }
    const key = known[cause.code]
    return key === undefined ? cause.message : t(key)
  }
  return cause instanceof Error ? cause.message : String(cause)
}
