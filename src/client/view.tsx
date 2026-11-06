/**
 * The sticky wall page, its free canvas and its composer sheet.
 *
 * State rules: the Host owns every note AND its placement; this page holds only
 * view state (search text, filter, camera zoom/pan, the in-flight drag). Every
 * mutation goes to the Host and the response is reconciled in place, so two
 * windows on the same wall converge instead of fighting over local state.
 *
 * The canvas has three view modes:
 * - `canvas` — the free board: cards sit where the Host says, drag to move,
 *   scroll to pan, ⌘/Ctrl + wheel to zoom, "整理" repacks them into a tidy
 *   shelf arrangement on the Host.
 * - `grid` — the same notes as a responsive masonry grid, for scanning a lot of
 *   text without the spatial noise.
 * - `list` — a dense one-line-per-note index, for finding a note by title.
 *
 * Markdown is rendered, never parsed as HTML: see `markdown.tsx`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { LIMITS, WIDTH_PX, type Note, type NoteColor, type NoteLayout, type NotePatch, type NoteWidth } from '../types.js'
import type { ClientApi } from './api.js'
import { ActionError } from './api.js'
import type { ClientLocaleLike } from './contracts.js'
import { layoutOf } from '../layout.js'
import { Markdown } from './markdown.jsx'
import { SWATCHES, WALL_CSS } from './styles.js'
import type { Translate } from './text.js'

/** Which notes the wall shows. */
type Filter = 'all' | 'pinned' | 'archived'
/** The orderings the Host accepts. */
type Sort = 'pinned' | 'created' | 'updated'
/** How the wall lays its notes out. */
type ViewMode = 'canvas' | 'grid' | 'list'

/** One draft the composer edits; a null id means "new note". */
interface Draft {
  id: string | null
  title: string
  body: string
  tags: string
  color: NoteColor
  width: NoteWidth
}

/** The camera over the world canvas: pan offset plus zoom. */
interface Camera {
  x: number
  y: number
  zoom: number
}

/** Props the `main` slot passes through; the wall owns its own data. */
export interface WallPageProps {
  api: ClientApi
  locale: ClientLocaleLike
  t: Translate
}

/** Zoom limits: below 0.4 a note is unreadable, above 2 it is a magnifier. */
const ZOOM_MIN = 0.4
const ZOOM_MAX = 2
/** Pointer travel, in px, before a press becomes a drag instead of a click. */
const DRAG_THRESHOLD = 3
/** Width cycle order for the resize action. */
const WIDTH_CYCLE: NoteWidth[] = ['sm', 'md', 'lg']

/** The sidebar glyph: a small stack of notes, sized by the sidebar slot. */
export function SidebarGlyph({ size = 18 }: { size?: number }): JSX.Element {
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
  const [preview, setPreview] = useState(false)
  useEffect(() => {
    bodyRef.current?.focus()
  }, [])
  return (
    <div className="skw-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}>
      <div className="skw-sheet" role="dialog" aria-modal="true" aria-label={draft.id ? t('edit') : t('new')}
        onKeyDown={(event) => {
          if (event.repeat) return
          if (event.key === 'Escape' && !busy) onCancel()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !busy) {
            event.preventDefault()
            onSave()
          }
        }}>
        <div className="skw-sheet-head">
          {draft.id ? t('edit') : t('new')}
          <span className="skw-spacer" />
          <button className="skw-btn skw-btn-quiet" type="button" data-on={preview} aria-pressed={preview}
            onClick={() => setPreview((value) => !value)}>{preview ? t('edit') : t('preview')}</button>
        </div>
        <div className="skw-sheet-body">
          <input className="skw-input" value={draft.title} placeholder={t('titlePlaceholder')} maxLength={LIMITS.title}
            onChange={(event) => onChange({ title: event.target.value })} aria-label={t('titlePlaceholder')} />
          {preview ? (
            <div className="skw-preview-box">
              {draft.body.trim() === '' ? <p className="skw-preview-empty">{t('bodyPlaceholder')}</p> : <Markdown source={draft.body} />}
            </div>
          ) : (
            <textarea ref={bodyRef} className="skw-textarea" value={draft.body} placeholder={t('bodyPlaceholder')} maxLength={LIMITS.body}
              onChange={(event) => onChange({ body: event.target.value })} aria-label={t('bodyPlaceholder')} />
          )}
          <input className="skw-input" value={draft.tags} placeholder={t('tagsPlaceholder')}
            onChange={(event) => onChange({ tags: event.target.value })} aria-label={t('tagsPlaceholder')} />
          <div className="skw-sheet-row">
            <div className="skw-swatches" role="group" aria-label={t('colorLabel')}>
              {SWATCHES.map((swatch) => (
                <button key={swatch.key} type="button" className="skw-swatch" data-on={draft.color === swatch.key}
                  style={{ background: swatch.css }} aria-label={swatch.key} aria-pressed={draft.color === swatch.key}
                  onClick={() => onChange({ color: swatch.key as NoteColor })} />
              ))}
            </div>
            <span className="skw-spacer" />
            <div className="skw-sizes" role="group" aria-label={t('widthLabel')}>
              {WIDTH_CYCLE.map((width) => (
                <button key={width} type="button" className="skw-size" data-on={draft.width === width}
                  aria-pressed={draft.width === width} onClick={() => onChange({ width })}>{t(`width_${width}`)}</button>
              ))}
            </div>
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

/**
 * The destructive-confirmation sheet.
 *
 * It is a real modal for keyboards too: an accessible name, Escape to dismiss,
 * initial focus on Cancel (the safe action) and focus restored to whatever
 * opened it, so a keyboard user can never get trapped behind a delete prompt.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  busy: boolean
  onConfirm(): void
  onCancel(): void
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const previous = typeof document === 'undefined' ? null : document.activeElement
    cancelRef.current?.focus()
    return () => {
      if (previous !== null && typeof (previous as HTMLElement).focus === 'function') (previous as HTMLElement).focus()
    }
  }, [])
  return (
    <div
      className="skw-scrim"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}
    >
      <div
        className="skw-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: 'min(420px, 100%)' }}
        onKeyDown={(event) => {
          if (event.repeat) return
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation()
            onCancel()
          }
        }}
      >
        <div className="skw-sheet-head">{title}</div>
        <div className="skw-sheet-body">
          <p style={{ margin: 0 }}>{message}</p>
        </div>
        <div className="skw-sheet-foot">
          <span className="skw-spacer" />
          <button ref={cancelRef} className="skw-btn" type="button" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button className="skw-btn skw-btn-danger" type="button" onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

/** One note card on the canvas; drag moves it, click selects, double-click edits. */
function NoteCard({
  note,
  index,
  t,
  locale,
  dragging,
  onEdit,
  onPatch,
  onRemove,
  onResize,
  onDragStart,
  onDragEnd,
}: {
  note: Note
  index: number
  t: Translate
  locale: string
  dragging: boolean
  onEdit(note: Note): void
  onPatch(note: Note, patch: NotePatch): void
  onRemove(note: Note): void
  onResize(note: Note, width: NoteWidth): void
  onDragStart(note: Note, event: React.PointerEvent<HTMLElement>): void
  onDragEnd(moved: boolean): void
}): JSX.Element {
  const layout = layoutOf(note, index)
  const style: React.CSSProperties = {
    left: `${layout.x}px`,
    top: `${layout.y}px`,
    width: `${WIDTH_PX[layout.width]}px`,
    transform: `rotate(${layout.rotate}deg)`,
  }
  return (
    <article
      className="skw-note"
      data-color={note.color}
      data-pinned={note.pinned}
      data-archived={note.archived}
      data-width={layout.width}
      data-dragging={dragging}
      style={style}
      aria-label={note.title || note.body.slice(0, 40)}
      tabIndex={0}
      onPointerDown={(event) => onDragStart(note, event)}
      onDoubleClick={() => onEdit(note)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
          event.preventDefault()
          onEdit(note)
        }
      }}
    >
      {/*
        Two stacked rows: the actions own the top-right row, the title owns the
        full-width row below it. Sharing one line made a long title wrap early
        because the buttons ate the right side of the row, and an absolute
        overlay covered the text outright. Each row is always rendered, so
        nothing reflows on hover.
      */}
      <div className="skw-note-bar">
        <span className="skw-note-dot" aria-hidden="true" />
        <span className="skw-spacer" />
        <div className="skw-note-tools">
          <button className="skw-icon-btn" type="button" title={note.pinned ? t('unpin') : t('pin')}
            data-on={note.pinned} aria-label={note.pinned ? t('unpin') : t('pin')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onPatch(note, { pinned: !note.pinned })}>
            <span className="skw-pin" aria-hidden="true">{note.pinned ? '★' : '☆'}</span>
          </button>
          <button className="skw-icon-btn" type="button" title={t('resize')} aria-label={t('resize')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onResize(note, WIDTH_CYCLE[(WIDTH_CYCLE.indexOf(layout.width) + 1) % WIDTH_CYCLE.length] ?? 'md')}>⤢</button>
          <button className="skw-icon-btn" type="button" title={t('edit')} aria-label={t('edit')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onEdit(note)}>✎</button>
          <button className="skw-icon-btn" type="button" title={note.archived ? t('restore') : t('archive')}
            aria-label={note.archived ? t('restore') : t('archive')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onPatch(note, { archived: !note.archived })}>{note.archived ? '↩' : '▤'}</button>
          <button className="skw-icon-btn" type="button" title={t('delete')} aria-label={t('delete')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onRemove(note)}>✕</button>
        </div>
      </div>
      {note.title !== '' && <div className="skw-note-head"><span className="skw-note-title">{note.title}</span></div>}
      <div className="skw-note-body is-clamped">
        <Markdown source={note.body} compact />
      </div>
      {note.tags.length > 0 && <div className="skw-note-tags">{note.tags.map((tag) => <span key={tag} className="skw-tag">#{tag}</span>)}</div>}
      <div className="skw-note-foot">
        <span>{formatTime(note.updatedAt, locale)}</span>
        <span className="skw-spacer" />
        {note.archived && <span className="skw-note-badge">{t('archive')}</span>}
        {note.pinned && <span className="skw-note-badge" aria-hidden="true">★ {t('pin')}</span>}
      </div>
    </article>
  )
}

/** One row in the dense list view. */
function NoteRow({ note, t, locale, onEdit }: { note: Note; t: Translate; locale: string; onEdit(note: Note): void }): JSX.Element {
  return (
    <button className="skw-row" type="button" data-color={note.color} data-archived={note.archived} onClick={() => onEdit(note)}>
      <span className="skw-row-dot" aria-hidden="true" />
      <span className="skw-row-title">{note.title || note.body.split('\n')[0]}</span>
      {note.tags.length > 0 && <span className="skw-row-tags">{note.tags.map((tag) => `#${tag}`).join(' ')}</span>}
      <span className="skw-spacer" />
      {note.pinned && <span className="skw-row-badge" aria-hidden="true">★</span>}
      <span className="skw-row-time">{formatTime(note.updatedAt, locale)}</span>
    </button>
  )
}

/** The wall page mounted into the `main` slot. */
export function WallPage({ api, locale, t }: WallPageProps): JSX.Element {
  const [notes, setNotes] = useState<Note[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('pinned')
  const [view, setView] = useState<ViewMode>('canvas')
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftError, setDraftError] = useState('')
  const [confirming, setConfirming] = useState<'clear' | Note | null>(null)
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 })
  const [draggingId, setDraggingId] = useState<string | null>(null)
  // Re-render on locale switch: relative times and copy are read from the
  // active locale, so the page must observe the locale revision.
  const [, setLocaleRevision] = useState(0)
  const alive = useRef(true)
  const life = useRef(new AbortController())
  const sequence = useRef(0)
  /** Synchronous write fence: React state is too late for same-tick events. */
  const inFlight = useRef(false)
  /** The live drag, kept in a ref so pointermove does not re-render per frame. */
  const drag = useRef<{
    id: string
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
    /** Local preview position while dragging, so the card follows the pointer. */
    x: number
    y: number
  } | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)

  const activeLocale = locale.getSnapshot().active

  // Track locale switches so relative times and copy re-render without a reload.
  useEffect(() => {
    const unsubscribe = locale.subscribe(() => {
      if (alive.current) setLocaleRevision((value) => value + 1)
    })
    return unsubscribe
  }, [locale])

  /**
   * Refetch the wall.
   *
   * `clearError` defaults to true for a fresh user-initiated load; the
   * reconcile after a mutation passes false so a successful refetch does not
   * erase the error that mutation just reported.
   */
  const reload = useMemo(() => async (options: { includeArchived: boolean; sort: Sort; clearError?: boolean }): Promise<void> => {
    const seq = ++sequence.current
    setLoading(true)
    try {
      const next = await api.list(options.includeArchived, options.sort, life.current.signal)
      if (alive.current && seq === sequence.current) {
        setNotes(next)
        if (options.clearError !== false) setError('')
      }
    } catch (cause) {
      if (alive.current && seq === sequence.current && !life.current.signal.aborted) setError(errorText(cause, t))
    } finally {
      if (alive.current && seq === sequence.current) setLoading(false)
    }
  }, [api, t])

  // The archived filter is useless without archived records, so it implies
  // `includeArchived` regardless of the "show archived" toggle. This also makes
  // the archived count (and therefore the clear-archive action) real on a
  // normal wall.
  const includeArchived = showArchived || filter === 'archived'

  useEffect(() => {
    alive.current = true
    life.current = new AbortController()
    void reload({ includeArchived, sort })
    return () => {
      alive.current = false
      life.current.abort()
      sequence.current += 1
    }
  }, [reload, includeArchived, sort])

  /**
   * Run one mutation, reconcile with the Host, and surface a failure inline.
   *
   * The reload runs on BOTH outcomes: a rejected request may still have written
   * something (a batch that failed midway), and the wall must never keep
   * showing a snapshot the Host no longer has.
   */
  async function mutate(run: () => Promise<Note[] | string[] | void>): Promise<void> {
    // A ref, not the `busy` state: two events in one tick would both read the
    // pre-flush state value and both fire.
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await run()
    } catch (cause) {
      if (alive.current && !life.current.signal.aborted) setError(errorText(cause, t))
    } finally {
      if (alive.current) {
        await reload({ includeArchived, sort, clearError: false }).catch(() => {})
        setBusy(false)
      }
      inFlight.current = false
    }
  }

  function openComposer(note?: Note): void {
    setDraftError('')
    setDraft(note
      ? { id: note.id, title: note.title, body: note.body, tags: note.tags.join(' '), color: note.color, width: layoutOf(note, 0).width }
      : { id: null, title: '', body: '', tags: '', color: 'yellow', width: 'md' })
  }

  async function saveDraft(): Promise<void> {
    if (!draft || inFlight.current) return
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
        // A width change is a placement change, so it goes through `move`
        // rather than the content patch (which must not bump `updatedAt`).
        const current = notes.find((note) => note.id === draft.id)
        if (current !== undefined) {
          const layout = layoutOf(current, 0)
          if (layout.width !== draft.width) await api.move(current.id, { ...layout, width: draft.width }, life.current.signal)
        }
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

  /**
   * The world extent of the visible notes.
   *
   * The canvas is one large absolutely-positioned surface; its size comes from
   * the furthest card plus padding, so a wall of three notes does not scroll
   * for three screens of empty paper.
   */
  const extent = useMemo(() => {
    let maxX = 0
    let maxY = 0
    for (const [index, note] of visible.entries()) {
      const layout = layoutOf(note, index)
      maxX = Math.max(maxX, layout.x + WIDTH_PX[layout.width])
      maxY = Math.max(maxY, layout.y + 220)
    }
    return { width: maxX + 420, height: maxY + 320 }
  }, [visible])

  /** Begin a drag; the move itself is applied on pointerup through the Host. */
  function startDrag(note: Note, event: React.PointerEvent<HTMLElement>): void {
    if (event.button !== 0) return
    const index = visible.findIndex((candidate) => candidate.id === note.id)
    const layout = layoutOf(note, index < 0 ? 0 : index)
    // Assign through a named value, not an inline literal: a literal followed
    // by a `(` on the next line parses as a call expression, not as ASI.
    drag.current = {
      id: note.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: layout.x,
      originY: layout.y,
      moved: false,
      x: layout.x,
      y: layout.y,
    }
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture?.(event.pointerId)
    setDraggingId(note.id)
  }

  /** Track the pointer; only a real move becomes a drag. */
  useEffect(() => {
    if (draggingId === null) return
    const zoom = camera.zoom
    const move = (event: PointerEvent): void => {
      const current = drag.current
      if (current === null || event.pointerId !== current.pointerId) return
      const dx = (event.clientX - current.startX) / zoom
      const dy = (event.clientY - current.startY) / zoom
      if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD) return
      current.moved = true
      current.x = current.originX + dx
      current.y = current.originY + dy
      // Move the DOM node directly: a React state update per pointermove would
      // re-render the whole wall on every frame.
      const node = canvasRef.current?.querySelector<HTMLElement>(`[data-note-id="${current.id}"]`)
      if (node !== null && node !== undefined) node.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(0deg)`
    }
    const end = (event: PointerEvent): void => {
      const current = drag.current
      drag.current = null
      setDraggingId(null)
      if (current === null || event.pointerId !== current.pointerId) return
      const node = canvasRef.current?.querySelector<HTMLElement>(`[data-note-id="${current.id}"]`)
      if (node !== null && node !== undefined) node.style.transform = ''
      if (!current.moved) return
      const layout: NoteLayout = { x: current.x, y: current.y, rotate: 0, width: layoutOf(notes.find((note) => note.id === current.id) ?? notes[0]!, 0).width }
      void mutate(async () => { await api.move(current.id, layout, life.current.signal) })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [draggingId, camera.zoom, notes, api, mutate])

  /** Zoom with the wheel; trackpad pinch arrives as ctrl+wheel. */
  function onWheel(event: React.WheelEvent<HTMLDivElement>): void {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.zoom - event.deltaY * 0.002))
    setCamera((current) => ({ ...current, zoom: next }))
  }

  const zoomBy = (delta: number): void => {
    setCamera((current) => ({ ...current, zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current.zoom + delta)) }))
  }

  return (
    <section className="skw-page" aria-label={t('title')}>
      <style>{WALL_CSS}</style>
      <header className="skw-head">
        <div className="skw-head-text">
          <h1 className="skw-title">
            <span className="skw-title-mark" aria-hidden="true"><SidebarGlyph size={15} /></span>
            {t('title')}
          </h1>
          <p className="skw-subtitle">{t('subtitle')}</p>
        </div>
        <div className="skw-actions">
          {archivedCount > 0 && (
            <button className="skw-btn skw-btn-quiet" type="button" onClick={() => setConfirming('clear')} disabled={busy}>
              {t('clearArchived')}
            </button>
          )}
          {view === 'canvas' && (
            <button className="skw-btn skw-btn-quiet" type="button" disabled={busy || visible.length === 0}
              onClick={() => void mutate(async () => { await api.arrange(life.current.signal) })}>
              {t('arrange')}
            </button>
          )}
          <button className="skw-btn skw-btn-primary" type="button" onClick={() => openComposer()} disabled={busy}>
            + {t('new')}
          </button>
        </div>
      </header>

      <div className="skw-toolbar">
        <div className="skw-search-wrap">
          <span className="skw-search-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="10.5" cy="10.5" r="6.2" stroke="currentColor" strokeWidth="1.8" />
              <path d="M15.4 15.4L20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <input className="skw-search" type="search" value={query} placeholder={t('search')} aria-label={t('search')}
            onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="skw-seg" role="group" aria-label={t('filters')}>
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
        <div className="skw-seg skw-view-seg" role="group" aria-label={t('viewLabel')}>
          {(['canvas', 'grid', 'list'] as const).map((mode) => (
            <button key={mode} type="button" data-on={view === mode} onClick={() => setView(mode)} aria-label={t(`view_${mode}`)}>
              {t(`view_${mode}`)}
            </button>
          ))}
        </div>
        <span className="skw-count">{t('count', { count: visible.length })}</span>
      </div>

      <div className="skw-body" data-view={view}>
        {error !== '' && (
          <p className="skw-error" role="alert">
            {error} <button className="skw-btn skw-btn-quiet" type="button" onClick={() => void reload({ includeArchived, sort })}>{t('retry')}</button>
          </p>
        )}
        {loading && notes.length === 0 ? (
          <div className="skw-empty"><p>{t('loading')}</p></div>
        ) : visible.length === 0 ? (
          <div className="skw-empty">
            <span className="skw-empty-icon" aria-hidden="true">🗒️</span>
            <p>{filter === 'archived' ? t('emptyArchived') : query.trim() !== '' ? t('noResults') : t('empty')}</p>
            {filter !== 'archived' && query.trim() === '' && (
              <button className="skw-btn" type="button" onClick={() => openComposer()}>{t('new')}</button>
            )}
          </div>
        ) : view === 'list' ? (
          <div className="skw-list">
            {visible.map((note) => (
              <NoteRow key={note.id} note={note} t={t} locale={activeLocale} onEdit={openComposer} />
            ))}
          </div>
        ) : view === 'grid' ? (
          <div className="skw-grid">
            {visible.map((note, index) => (
              <NoteCard key={note.id} note={note} index={index} t={t} locale={activeLocale} dragging={false}
                onEdit={openComposer}
                onPatch={(target, patch) => void mutate(async () => { await api.update(target.id, patch, life.current.signal) })}
                onRemove={(target) => setConfirming(target)}
                onResize={(target, width) => void mutate(async () => {
                  const current = notes.find((candidate) => candidate.id === target.id)
                  if (current !== undefined) await api.move(target.id, { ...layoutOf(current, index), width }, life.current.signal)
                })}
                onDragStart={() => {}} onDragEnd={() => {}} />
            ))}
          </div>
        ) : (
          <div className="skw-canvas-scroll">
            <div
              ref={canvasRef}
              className="skw-canvas"
              data-zoomed={camera.zoom !== 1}
              style={{ width: `${extent.width}px`, height: `${extent.height}px` }}
              onWheel={onWheel}
            >
              <div className="skw-world" style={{ transform: `scale(${camera.zoom})`, transformOrigin: '0 0' }}>
                {visible.map((note, index) => (
                  <div key={note.id} className="skw-note-slot" data-note-id={note.id}>
                    <NoteCard note={note} index={index} t={t} locale={activeLocale} dragging={draggingId === note.id}
                      onEdit={openComposer}
                      onPatch={(target, patch) => void mutate(async () => { await api.update(target.id, patch, life.current.signal) })}
                      onRemove={(target) => setConfirming(target)}
                      onResize={(target, width) => void mutate(async () => {
                        const current = notes.find((candidate) => candidate.id === target.id)
                        if (current !== undefined) await api.move(target.id, { ...layoutOf(current, index), width }, life.current.signal)
                      })}
                      onDragStart={startDrag} onDragEnd={() => {}} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {view === 'canvas' && (
        <div className="skw-cameras" role="group" aria-label={t('zoomLabel')}>
          <button className="skw-camera-btn" type="button" aria-label={t('zoomOut')} onClick={() => zoomBy(-0.15)}>−</button>
          <span className="skw-camera-value">{Math.round(camera.zoom * 100)}%</span>
          <button className="skw-camera-btn" type="button" aria-label={t('zoomIn')} onClick={() => zoomBy(0.15)}>+</button>
          <button className="skw-camera-btn" type="button" aria-label={t('zoomReset')}
            onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}>⌖</button>
        </div>
      )}

      {draft && (
        <Composer draft={draft} t={t} busy={busy} error={draftError}
          onChange={(patch) => setDraft((current) => (current === null ? current : { ...current, ...patch }))}
          onSave={() => void saveDraft()}
          onCancel={() => { if (!busy) { setDraft(null); setDraftError('') } }} />
      )}

      {confirming !== null && (
        <ConfirmDialog
          title={confirming === 'clear' ? t('clearArchived') : t('delete')}
          message={confirming === 'clear' ? t('confirmClear') : t('confirmDelete')}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          busy={busy}
          onConfirm={() => {
            const target = confirming
            setConfirming(null)
            void mutate(async () => {
              if (target === 'clear') await api.clearArchived(life.current.signal)
              else await api.remove([target.id], life.current.signal)
            })
          }}
          onCancel={() => setConfirming(null)}
        />
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
