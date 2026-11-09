/**
 * The sticky wall page, its free canvas and its composer sheet.
 *
 * State rules: the Host owns every note AND its placement; this page holds only
 * view state (search text, filter, camera, the in-flight drag/pan). Every
 * mutation goes to the Host and the response is reconciled in place, so two
 * windows on the same wall converge instead of fighting over local state.
 *
 * The canvas has three view modes:
 * - `canvas` — the free board: cards sit where the Host says, drag a card to
 *   move it, drag the empty paper to pan, scroll to pan, ⌘/Ctrl + wheel to zoom,
 *   "整理" repacks them into a compact cluster centred on the world origin.
 * - `grid` — the same notes as a responsive masonry grid, for scanning a lot of
 *   text without the spatial noise.
 * - `list` — a dense one-line-per-note index, for finding a note by title.
 *
 * Four decisions shape the canvas half of this file, and each one is a measured
 * fix rather than a preference:
 *
 * 1. **The camera is a transform, not a scroll container.** A scroll container
 *    forced the wall into a padded surface whose origin moved whenever a card
 *    was dragged past the edge — so the whole wall visibly jumped mid-drag. The
 *    viewport is now `overflow: hidden` and the camera is
 *    `translate3d(pan) scale(zoom)` on one wrapper, written imperatively.
 * 2. **Panning and zooming never re-render.** They touch two style properties on
 *    two nodes. Cards keep their `left`/`top`/`width` and a `rotate()`, so a pan
 *    or a zoom costs zero React work and zero layout.
 * 3. **The wall has a middle.** `arrangeLayouts` packs a compact cluster around
 *    the origin, hugging the reserved centrepiece, and the camera opens on the
 *    wall's bounding-box centre instead of on a top-left corner.
 * 4. **A drop is optimistic.** The card is written to its final world position
 *    on the node and in the note list before the Host round-trip, so the card
 *    never snaps back to where it started while the write is in flight.
 *
 * Markdown is rendered, never parsed as HTML: see `markdown.tsx`.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CENTRE_RESERVE, LIMITS, WIDTH_PX, type CentreReserve, type Note, type NoteColor, type NoteLayout, type NotePatch, type NoteWidth } from '../types.js'
import type { ClientApi } from './api.js'
import { ActionError } from './api.js'
import type { ClientLocaleLike } from './contracts.js'
import { clampLayout, estimateHeight, footprintOf, layoutOf, pushOutOfReserve, rotatedExtent } from '../layout.js'
import { Markdown } from './markdown.jsx'
import { SWATCHES, WALL_CSS } from './styles.js'
import type { Translate } from './text.js'

/** Which notes the wall shows. */
type Filter = 'all' | 'pinned' | 'archived'
/** The orderings the Host accepts. */
type Sort = 'pinned' | 'created' | 'updated'
/** How the wall lays its notes out. */
type ViewMode = 'canvas' | 'grid' | 'list'
/** Where a card is being rendered: the free canvas or the flowing grid. */
type Surface = 'canvas' | 'grid'

/** One draft the composer edits; a null id means "new note". */
interface Draft {
  id: string | null
  title: string
  body: string
  tags: string
  color: NoteColor
  width: NoteWidth
}

/** Props the `main` slot passes through; the wall owns its own data. */
export interface WallPageProps {
  api: ClientApi
  locale: ClientLocaleLike
  t: Translate
}

/** Zoom limits: below 0.35 a note is unreadable, above 2 it is a magnifier. */
const ZOOM_MIN = 0.35
const ZOOM_MAX = 2
/** Pointer travel, in px, before a press becomes a drag instead of a click. */
const DRAG_THRESHOLD = 3
/** Width cycle order for the resize action. */
const WIDTH_CYCLE: NoteWidth[] = ['sm', 'md', 'lg']
/** World dot grid pitch, in pixels at zoom 1. */
const DOT_PITCH = 22
/** Wheel pan speed for a non-zooming wheel event. */
const WHEEL_PAN = 1
/** How long the "bring the new card into view" camera move takes, in ms. */
const REVEAL_MS = 340
/** How long the arrival highlight stays on a freshly created card, in ms. */
const ARRIVAL_MS = 900

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

/** Clamp one zoom value into the declared camera range. */
function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
}

/** True when two notes are field-for-field identical, placement included. */
function sameNote(left: Note, right: Note): boolean {
  if (
    left.title !== right.title ||
    left.body !== right.body ||
    left.color !== right.color ||
    left.pinned !== right.pinned ||
    left.archived !== right.archived ||
    left.createdAt !== right.createdAt ||
    left.updatedAt !== right.updatedAt ||
    left.tags.length !== right.tags.length ||
    left.tags.some((tag, index) => tag !== right.tags[index])
  ) {
    return false
  }
  if (left.layout === right.layout) return true
  if (left.layout === null || right.layout === null) return false
  return (
    left.layout.x === right.layout.x &&
    left.layout.y === right.layout.y &&
    left.layout.rotate === right.layout.rotate &&
    left.layout.width === right.layout.width
  )
}

/**
 * Keep the previous object identity for notes that did not change.
 *
 * The RPC hands back a freshly parsed array after every mutation, so a plain
 * `setNotes` would give every card a new object and re-render the whole wall —
 * including re-parsing the Markdown of hundreds of notes that did not change.
 * Reusing the old objects lets `memo` skip them. Returns the previous array
 * itself when nothing changed at all, which also stops the parent re-rendering.
 */
function reconcileNotes(previous: readonly Note[], next: readonly Note[]): Note[] {
  const byId = new Map(previous.map((note) => [note.id, note]))
  let changed = previous.length !== next.length
  const merged = next.map((note) => {
    const old = byId.get(note.id)
    if (old !== undefined && sameNote(old, note)) return old
    changed = true
    return note
  })
  return changed ? merged : (previous as Note[])
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

/** The card actions, in one stable object so `NoteCard` can be memoized. */
interface CardActions {
  edit(note: Note): void
  patch(note: Note, patch: NotePatch): void
  remove(note: Note): void
  resize(note: Note, width: NoteWidth): void
  drag(note: Note, event: React.PointerEvent<HTMLElement>): void
}

/**
 * One note card.
 *
 * Memoized: the wall reconciles note objects by identity, so a mutation that
 * touches one note re-renders one card instead of every card on the wall. On
 * the canvas the card's world position is `left`/`top` and only the tilt is a
 * transform, so a drag can be a pure transform write and a drop is a `left`/`top`
 * update that lands exactly where the card already is.
 */
const NoteCard = memo(function NoteCard({
  note,
  index,
  surface,
  t,
  locale,
  actions,
  arrived = false,
}: {
  note: Note
  index: number
  surface: Surface
  t: Translate
  locale: string
  actions: CardActions
  /** True for one beat after the note was created, to play the arrival pop. */
  arrived?: boolean
}): JSX.Element {
  const layout = layoutOf(note, index)
  const style: React.CSSProperties = surface === 'canvas'
    ? {
      left: `${layout.x}px`,
      top: `${layout.y}px`,
      width: `${WIDTH_PX[layout.width]}px`,
      // The HEIGHT is the Host's own estimate, not a CSS max-height.
      //
      // This is what makes the packer's geometry exact: the collision check runs
      // on `estimateHeight`, so unless the rendered box is that same height, a
      // card whose content renders taller than its estimate overlaps its
      // neighbour — which is precisely the residual overlap this fixes (a code
      // block's padding and border are not something a line count can see).
      height: `${estimateHeight(note, layout.width)}px`,
      transform: `rotate(${layout.rotate}deg)`,
    }
    : {}
  return (
    <article
      className="skw-note"
      data-note-id={note.id}
      data-color={note.color}
      data-pinned={note.pinned}
      data-archived={note.archived}
      data-width={layout.width}
      data-arrived={arrived}
      style={style}
      aria-label={note.title || note.body.slice(0, 40)}
      tabIndex={0}
      onPointerDown={(event) => actions.drag(note, event)}
      onDoubleClick={() => actions.edit(note)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
          event.preventDefault()
          actions.edit(note)
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
            onClick={() => actions.patch(note, { pinned: !note.pinned })}>
            <span className="skw-pin" aria-hidden="true">{note.pinned ? '★' : '☆'}</span>
          </button>
          <button className="skw-icon-btn" type="button" title={t('resize')} aria-label={t('resize')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => actions.resize(note, WIDTH_CYCLE[(WIDTH_CYCLE.indexOf(layout.width) + 1) % WIDTH_CYCLE.length] ?? 'md')}>⤢</button>
          <button className="skw-icon-btn" type="button" title={t('edit')} aria-label={t('edit')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => actions.edit(note)}>✎</button>
          <button className="skw-icon-btn" type="button" title={note.archived ? t('restore') : t('archive')}
            aria-label={note.archived ? t('restore') : t('archive')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => actions.patch(note, { archived: !note.archived })}>{note.archived ? '↩' : '▤'}</button>
          <button className="skw-icon-btn" type="button" title={t('delete')} aria-label={t('delete')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => actions.remove(note)}>✕</button>
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
})

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
  /** Zoom is state because the readout is rendered; pan is not (see below). */
  const [zoom, setZoom] = useState(1)
  /** Bumped when the canvas remounts or the wall goes from empty to populated. */
  const [viewportTick, setViewportTick] = useState(0)
  /** The quick-capture field at the wall's centre. */
  const [capture, setCapture] = useState('')
  /** The note that just arrived, so it can play its arrival animation once. */
  const [arrivedId, setArrivedId] = useState<string | null>(null)
  /** Whether the dock's overflow menu is open (sort, archive options). */
  const [menuOpen, setMenuOpen] = useState(false)
  // Re-render on locale switch: relative times and copy are read from the
  // active locale, so the page must observe the locale revision.
  const [, setLocaleRevision] = useState(0)
  const alive = useRef(true)
  const life = useRef(new AbortController())
  const sequence = useRef(0)
  /** Synchronous write fence: React state is too late for same-tick events. */
  const inFlight = useRef(false)
  /**
   * The canvas node.
   *
   * A ref rather than state, mirrored by a callback ref so the wheel listener can
   * be bound exactly when the node is created: the canvas does not exist while
   * the wall is still loading, and an effect-based binding attached to `null` and
   * then silently never retried.
   */
  const viewportRefCurrent = useRef<HTMLDivElement | null>(null)
  const worldRef = useRef<HTMLDivElement | null>(null)
  /** The centrepiece overlay, measured to derive the world-space reserve. */
  const centreRef = useRef<HTMLDivElement | null>(null)
  /** The dock's overflow menu, so a click outside it can close it. */
  const menuRef = useRef<HTMLDivElement | null>(null)
  /** The dock itself, measured so the camera frames the wall above it. */
  const dockRef = useRef<HTMLDivElement | null>(null)
  /** Detaches the wheel listener bound to the current canvas node. */
  const detachWheel = useRef<(() => void) | null>(null)

  /**
   * The camera.
   *
   * Zoom lives in React state (the percentage readout renders from it); pan does
   * not, because nothing in the tree depends on it. Both are mirrored here so
   * the imperative pointer loop and the style writer always read the truth.
   */
  const camera = useRef({ zoom: 1, panX: 0, panY: 0 })
  /**
   * A pending "frame the whole wall" request.
   *
   * Consumed by the camera layout effect against the CURRENT `wallBounds`, which
   * is why every request is issued only after the data it depends on has been
   * committed (see `tidyWall`, which sequences its own refit after the write).
   */
  const centreRequest = useRef(true)
  /**
   * Set when the next committed note list must be framed.
   *
   * Tidy issues this BEFORE the write and it is consumed by an effect that runs
   * after the reconcile has committed, so `fitWall` sees the placements tidy
   * actually produced. Requesting a fit at the call site framed the pre-tidy
   * wall, and the tidied one then opened overflowing at 100%.
   */

  /**
   * The live drag.
   *
   * Kept entirely in refs: React state is far too slow for a pointer loop (a
   * state write per move re-renders the whole wall and drops frames), and the
   * node, its geometry and the current offset are all needed on every event.
   * The card is moved by writing one `transform` on the element itself.
   */
  const drag = useRef<{
    id: string
    /** The note itself, so the drop can test its footprint against the reserve. */
    note: Note
    pointerId: number
    /** The card element being dragged, captured once at pointerdown. */
    node: HTMLElement | null
    startX: number
    startY: number
    originX: number
    originY: number
    /** The card's own rotation, so a drag keeps its tilt instead of flattening. */
    rotate: number
    width: NoteWidth
    moved: boolean
    /** Whether the browser pointer is captured, so cleanup knows to release. */
    captured: boolean
    /** Pending animation frame, coalescing several pointermoves into one paint. */
    frame: number
    /** Latest pointer position, in client coordinates. */
    lastX: number
    lastY: number
  } | null>(null)

  /** The live canvas pan, kept in a ref for the same reason as the drag. */
  const pan = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    node: HTMLElement | null
    frame: number
    lastX: number
    lastY: number
  } | null>(null)

  /**
   * The latest mutation runner for the pointer loop.
   *
   * Assigned on every render rather than through an effect: the drop handler
   * can fire in the same task as a render, and an effect assignment would still
   * be holding the previous closure (which captured a stale note list).
   */
  const live = useRef({ mutate: (_run: () => Promise<Note[] | string[] | void>): void => {} })
  live.current.mutate = (run) => { void mutate(run) }

  const activeLocale = locale.getSnapshot().active

  /**
   * A note's stable index for the derived preview position.
   *
   * The preview position is derived from the note's index, so that index MUST
   * come from the unfiltered snapshot: keying it off the filtered list made a
   * legacy (never-placed) note jump sideways as soon as the user typed in the
   * search box or toggled archived, because removing one earlier note shifted
   * every later index.
   */
  const stableIndex = useMemo(() => {
    const map = new Map<string, number>()
    notes.forEach((note, index) => map.set(note.id, index))
    return map
  }, [notes])

  const indexOf = (note: Note): number => stableIndex.get(note.id) ?? 0

  // Track locale switches so relative times and copy re-render without a reload.
  useEffect(() => {
    const unsubscribe = locale.subscribe(() => {
      if (alive.current) setLocaleRevision((value) => value + 1)
    })
    return unsubscribe
  }, [locale])

  // An open dock menu closes on Escape or on a press anywhere else. A menu that
  // only closes by pressing its own trigger is a trap on a canvas: the user's
  // next click is usually "get me back to the wall".
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const node = menuRef.current
      if (node !== null && event.target instanceof Node && node.contains(event.target)) return
      setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

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
        setNotes((previous) => reconcileNotes(previous, next))
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
  async function mutate(run: () => Promise<Note[] | string[] | void>): Promise<boolean> {
    // A ref, not the `busy` state: two events in one tick would both read the
    // pre-flush state value and both fire.
    if (inFlight.current) return false
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
    return true
  }

  /**
   * Tidy the wall, then frame what it produced.
   *
   * The refit is sequenced HERE rather than through a render effect: `mutate`
   * resolves after its own reload, so when it returns the new placements are
   * already in state. Waiting one frame then lets the browser lay them out before
   * `fitWall` measures them; a fit issued any earlier measured the pre-tidy wall,
   * which is why the tidied wall kept opening overflowing at 100%.
   */
  async function tidyWall(): Promise<void> {
    const ran = await mutate(async () => { await api.arrange(life.current.signal, { centreReserve: centreReserve() }) })
    if (!ran) return
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()) })
    if (!alive.current) return
    centreRequest.current = true
    setViewportTick((value) => value + 1)
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
        const note = await api.create(
          { body, title: draft.title.trim(), tags, color: draft.color },
          life.current.signal,
          { centreReserve: centreReserve() },
        )
        arrival.current = { id: note.id, token: Date.now() }
        setArrivedId(note.id)
      } else {
        await api.update(draft.id, { body, title: draft.title.trim(), tags, color: draft.color }, life.current.signal)
        // A width change is a placement change, so it goes through `move`
        // rather than the content patch (which must not bump `updatedAt`).
        const current = notes.find((note) => note.id === draft.id)
        if (current !== undefined) {
          const layout = layoutOf(current, stableIndex.get(current.id) ?? 0)
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
   * The greeting above the capture field.
   *
   * Time-aware and localized, because the wall's centre is the first thing a
   * user sees and a static "Sticky wall" there reads as a header, not as an
   * invitation to write something down.
   */
  const greeting = useMemo(() => {
    const hour = new Date().getHours()
    const key = hour < 5 ? 'greetNight' : hour < 12 ? 'greetMorning' : hour < 18 ? 'greetAfternoon' : 'greetEvening'
    return t(key)
    // The locale revision is observed through `activeLocale`, so switching the
    // GUI language recomputes this copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, activeLocale])

  /** What an empty view says, depending on why it is empty. */
  const emptyCopy = filter === 'archived'
    ? t('emptyArchived')
    : query.trim() !== ''
      ? t('noResults')
      : t('empty')

  /**
   * The centre of the visible wall, in world coordinates.
   *
   * This is what the camera opens on and what "reset view" returns to, so the
   * wall reads as a composition with a middle rather than as a document that
   * happens to start at a corner.
   */
  const wallBounds = useMemo(() => {
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    let sumX = 0
    let sumY = 0
    let count = 0
    for (const note of visible) {
      const layout = layoutOf(note, indexOf(note))
      const width = WIDTH_PX[layout.width]
      const height = estimateHeight(note, layout.width)
      const box = rotatedExtent(width, height, layout.rotate)
      const centreX = layout.x + width / 2
      const centreY = layout.y + height / 2
      minX = Math.min(minX, centreX - box.width / 2)
      maxX = Math.max(maxX, centreX + box.width / 2)
      minY = Math.min(minY, centreY - box.height / 2)
      maxY = Math.max(maxY, centreY + box.height / 2)
      sumX += centreX
      sumY += centreY
      count += 1
    }
    if (count === 0) return { centre: { x: 0, y: 0 }, width: 0, height: 0 }
    return {
      // The bounding box's middle, not the centroid: "frame the whole wall" means
      // the wall's outer edges are equidistant from the viewport edges, and only
      // the box middle guarantees that. A lopsided two-card wall has a centroid
      // far from its visual middle, which left one card half off screen.
      centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      width: maxX - minX,
      height: maxY - minY,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, stableIndex])

  const wallCentre = wallBounds.centre

  /**
   * The live wall bounds, mirrored for `fitWall`.
   *
   * `fitWall` is a `useCallback` closed over `wallBounds`; a fit requested from
   * an effect that runs in the same commit as a `setNotes` still sees the PREVIOUS
   * bounds, which framed the pre-tidy wall. Reading a ref makes the fit always
   * use the committed geometry.
   */
  const boundsRef = useRef(wallBounds)
  boundsRef.current = wallBounds

  const hasNotes = visible.length > 0



  /** Write the camera onto the two nodes that own it. No React, no layout. */
  const applyCamera = useCallback((): void => {
    const current = camera.current
    const world = worldRef.current
    const viewport = viewportRefCurrent.current
    if (world !== null) world.style.transform = `translate3d(${current.panX}px, ${current.panY}px, 0) scale(${current.zoom})`
    // The centrepiece is screen-space (it must stay at the viewport's middle), but
    // its WORLD footprint has to stay constant or the reserve cannot be an
    // invariant. Counter-scaling below 1 does exactly that: zoomed out, the block
    // shrinks on screen while covering the same world rectangle. Above 1 it is
    // capped, so a magnified wall simply gets extra margin around the field.
    const centre = centreRef.current
    if (centre !== null) {
      const scale = Math.min(1, current.zoom)
      centre.style.transform = `translate(-50%, -50%) scale(${scale})`
    }
    if (viewport !== null) {
      // The paper's dots belong to the world, so their pitch and offset follow
      // the camera instead of staying a fixed screen texture under the cards.
      viewport.style.backgroundSize = `${DOT_PITCH * current.zoom}px ${DOT_PITCH * current.zoom}px`
      viewport.style.backgroundPosition = `${current.panX}px ${current.panY}px`
    }
  }, [])

  /** A pending animated camera move, cancelled by any direct camera write. */
  const tween = useRef<number>(0)
  const stopTween = useCallback((): void => {
    if (tween.current !== 0) {
      cancelAnimationFrame(tween.current)
      tween.current = 0
    }
  }, [])

  /**
   * Animate the camera to a target, so the wall glides instead of jumping.
   *
   * A hard cut when a new card arrives outside the viewport is disorienting: the
   * user cannot tell whether the wall moved or a different wall appeared. A short
   * ease makes the relationship between "where I was" and "where the card is"
   * legible, which is the whole point of revealing it.
   */
  const glideTo = useCallback((zoomTarget: number, worldX: number, worldY: number): void => {
    const viewport = viewportRefCurrent.current
    if (viewport === null) return
    stopTween()
    const from = { ...camera.current }
    const to = {
      zoom: clampZoom(zoomTarget),
      panX: viewport.clientWidth / 2 - worldX * clampZoom(zoomTarget),
      panY: viewport.clientHeight / 2 - worldY * clampZoom(zoomTarget),
    }
    if (typeof requestAnimationFrame !== 'function') {
      camera.current = { ...to }
      setZoom(to.zoom)
      applyCamera()
      return
    }
    const started = performance.now()
    const frame = (now: number): void => {
      const progress = Math.min(1, (now - started) / REVEAL_MS)
      // Ease-out cubic: fast at first so the move feels responsive, settled at
      // the end so the card does not arrive still sliding.
      const eased = 1 - (1 - progress) ** 3
      camera.current = {
        zoom: from.zoom + (to.zoom - from.zoom) * eased,
        panX: from.panX + (to.panX - from.panX) * eased,
        panY: from.panY + (to.panY - from.panY) * eased,
      }
      applyCamera()
      if (progress < 1) {
        tween.current = requestAnimationFrame(frame)
        return
      }
      tween.current = 0
      camera.current = { ...to }
      setZoom(to.zoom)
      applyCamera()
    }
    tween.current = requestAnimationFrame(frame)
    // The zoom readout updates once at the end: per-frame setState would re-render
    // the whole wall during the animation.
    setZoom(to.zoom)
  }, [applyCamera, stopTween])

  /** Put one world point in the middle of the visible area, at the current zoom. */
  const centreOn = useCallback((worldX: number, worldY: number): void => {
    stopTween()
    const viewport = viewportRefCurrent.current
    const current = camera.current
    if (viewport !== null) {
      // "Middle" is the middle of the VISIBLE area, not of the viewport: the dock
      // floats over the bottom of the canvas, so centring on the raw viewport
      // pushes the wall's bottom row under it.
      const dock = dockRef.current
      const bottomInset = dock === null ? 0 : dock.offsetHeight + 24
      current.panX = viewport.clientWidth / 2 - worldX * current.zoom
      current.panY = (viewport.clientHeight - bottomInset) / 2 - worldY * current.zoom
    }
    applyCamera()
  }, [applyCamera, stopTween])

  /**
   * A wall that just went from empty to populated must open on its middle.
   *
   * The tick forces the camera layout effect to run once more after the canvas
   * has actually mounted: the first centre request happens while the viewport
   * still has no size, so it would otherwise leave the wall in a corner.
   */
  useEffect(() => {
    if (hasNotes) centreRequest.current = true
    setViewportTick((value) => value + 1)
  }, [hasNotes, view])

  /** Zoom, keeping the world point under `anchor` fixed. */
  const zoomTo = useCallback((next: number, anchor?: { x: number; y: number }): void => {
    const viewport = viewportRefCurrent.current
    const current = camera.current
    const target = clampZoom(next)
    if (viewport === null) {
      current.zoom = target
      setZoom(target)
      return
    }
    const ax = anchor?.x ?? viewport.clientWidth / 2
    const ay = anchor?.y ?? viewport.clientHeight / 2
    // The world point under the anchor must not move.
    const worldX = (ax - current.panX) / current.zoom
    const worldY = (ay - current.panY) / current.zoom
    current.zoom = target
    current.panX = ax - worldX * target
    current.panY = ay - worldY * target
    setZoom(target)
    applyCamera()
  }, [applyCamera])

  /**
   * Frame the whole wall: pick the zoom that fits it, then centre it.
   *
   * A wall that overflows the viewport at 100% shows a middle but not a wall, and
   * a wall of three cards at 40% is unreadable. So the fit zoom is capped at 1
   * (never magnify a small wall) and floored at the readable minimum; the
   * resulting camera is what "reset view" and the first open use.
   */
  const fitWall = useCallback((): void => {
    const viewport = viewportRefCurrent.current
    if (viewport === null) return
    // A zero-sized viewport has no framing to compute (jsdom, a hidden panel), but
    // the camera must still be written: the transform is the only thing that says
    // where the wall is, and leaving it unset would silently skip the centre.
    const availableWidth = viewport.clientWidth || 960
    const availableHeight = viewport.clientHeight || 640

    // Prefer the rendered geometry, fall back to the computed bounds.
    //
    // `offsetLeft`/`offsetWidth` are the card's untransformed layout box, so they
    // are the truth about what occupies space. They are zero in a DOM without
    // layout (jsdom, a hidden panel), which is why the computed bounds remain the
    // fallback rather than being replaced.
    const world = worldRef.current
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    if (world !== null) {
      for (const node of world.querySelectorAll<HTMLElement>('.skw-note')) {
        const x = node.offsetLeft
        const y = node.offsetTop
        const width = node.offsetWidth
        const height = node.offsetHeight
        if (width === 0 || height === 0) continue
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x + width)
        maxY = Math.max(maxY, y + height)
      }
    }
    const measured = Number.isFinite(minX) && Number.isFinite(minY) && maxX > minX
    const bounds = boundsRef.current
    const boxWidth = measured ? maxX - minX : bounds.width
    const boxHeight = measured ? maxY - minY : bounds.height
    const centreX = measured ? (minX + maxX) / 2 : bounds.centre.x
    const centreY = measured ? (minY + maxY) / 2 : bounds.centre.y

    // A margin so the outermost cards do not touch the viewport edge, and a
    // floor so framing never shrinks the wall into unreadable confetti: below
    // this the user is better off seeing part of the wall at a legible size and
    // panning for the rest.
    //
    // The floor is 42%, not 50%. It was chosen when the packer laid cards out in
    // rings, whose first radius is the reserve's half-diagonal, so a 14-card wall
    // needed ~2300x2000 of world and a 50% floor left its outer cards outside the
    // viewport. The contour packer is roughly twice as tight (a 14-card wall now
    // needs ~1290x670), so the floor is now a backstop rather than the normal
    // case — kept because a genuinely huge wall must still stay legible rather
    // than be shrunk into confetti.
    //
    // The bottom inset is the dock's own height: it floats OVER the canvas, so
    // framing against the raw viewport put the wall's bottom row behind it. The
    // number is measured rather than assumed, because the dock's height changes
    // with the locale's label lengths.
    const margin = 48
    const dock = dockRef.current
    const bottomInset = dock === null ? 0 : dock.offsetHeight + 24
    const usableHeight = Math.max(120, availableHeight - margin - bottomInset)
    const fit = Math.min(
      (availableWidth - margin * 2) / Math.max(1, boxWidth),
      usableHeight / Math.max(1, boxHeight),
    )
    const FIT_FLOOR = 0.42
    const target = clampZoom(Math.min(1, Math.max(FIT_FLOOR, fit)))
    camera.current.zoom = target
    setZoom(target)
    centreOn(centreX, centreY)
  }, [centreOn])

  /** Put the wall back in view at the zoom that frames it. */
  const resetView = useCallback((): void => {
    // `fitWall` computes AND applies the zoom; setting zoom=1 first would leave
    // the readout and the transform disagreeing whenever the wall needs <100%.
    fitWall()
  }, [fitWall])

  /**
   * The clear rectangle the wall must leave for its centrepiece, in WORLD pixels.
   *
   * This is deliberately ZOOM-INDEPENDENT, and that is the whole point. The first
   * version derived it from the rendered overlay divided by the zoom, which made
   * the reserve grow as the camera zoomed out — but placements are PERSISTED, so
   * a card packed clear at 100% became an offender at 50%, and a single zoom-out
   * put a card behind the capture field. A reserve that moves when the camera
   * moves cannot be an invariant.
   *
   * The fixed rectangle works because the overlay is counter-scaled to match it
   * (see `applyCamera`): at zoom 1 the centrepiece exactly fills the reserve, and
   * zoomed out it shrinks on screen to cover the same world rectangle. So "no card
   * in the reserve" and "no card behind the field" are the same statement at every
   * zoom level.
   */
  const centreReserve = useCallback((): CentreReserve => CENTRE_RESERVE, [])

  /**
   * Bring one world box into view, zooming out only as far as it takes.
   *
   * Creating a card must never be a guess: if the nearest free gap is off screen,
   * the wall glides so the card is visible, and it zooms out only when the card
   * genuinely does not fit. A card that is already visible moves nothing, because
   * stealing the view from someone who is reading is worse than the card being
   * slightly off-centre.
   */
  const revealBox = useCallback((box: { x: number; y: number; width: number; height: number }): void => {
    const viewport = viewportRefCurrent.current
    if (viewport === null) return
    const zoomNow = camera.current.zoom
    const centreX = box.x + box.width / 2
    const centreY = box.y + box.height / 2
    // Where the box centre currently sits in viewport space.
    const screenX = centreX * zoomNow + camera.current.panX
    const screenY = centreY * zoomNow + camera.current.panY
    const margin = 72
    const visible =
      screenX > margin &&
      screenX < viewport.clientWidth - margin &&
      screenY > margin &&
      screenY < viewport.clientHeight - margin
    if (visible) return
    // Fit the card with room for its neighbours, but never magnify: a card that
    // already fits at the current zoom just needs the camera to move.
    const targetZoom = Math.min(
      zoomNow,
      Math.max(ZOOM_MIN, Math.min(
        (viewport.clientWidth - margin * 2) / Math.max(1, box.width),
        (viewport.clientHeight - margin * 2) / Math.max(1, box.height),
      )),
    )
    glideTo(targetZoom, centreX, centreY)
  }, [glideTo])

  /** The card that just arrived, so it can be highlighted and revealed once. */
  const arrival = useRef<{ id: string; token: number } | null>(null)

  /**
   * React to a freshly created note: highlight it, then make sure it is visible.
   *
   * This is the second half of "creating a note must not be a leap of faith". The
   * Host places the card in the nearest free gap; this effect then finds the card
   * in the committed list, marks it for the arrival animation and, if the gap is
   * outside the current viewport, moves the camera to it.
   */
  useEffect(() => {
    const pending = arrival.current
    if (pending === null) return
    const note = notes.find((candidate) => candidate.id === pending.id)
    if (note === undefined) return
    arrival.current = null
    const layout = layoutOf(note, stableIndex.get(note.id) ?? 0)
    // One frame so the card's DOM box exists at its final placement; measuring it
    // synchronously here would read the pre-placement geometry.
    const frame = requestAnimationFrame(() => {
      if (!alive.current) return
      revealBox(footprintOf(note, layout))
    })
    const timer = setTimeout(() => {
      if (alive.current) setArrivedId((current) => (current === pending.id ? null : current))
    }, ARRIVAL_MS)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
    // `notes` is the trigger: the card exists only after the reconcile commits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes])

  /**
   * Wheel: pan by default, zoom with ⌘/Ctrl (which is also how a trackpad pinch
   * arrives). Bound through a callback ref, not an effect: an effect keyed on
   * render state can run before the canvas exists (the wall is still loading) or
   * keep a listener on a node React has since replaced, and both failures are
   * silent — the wheel simply does nothing. A callback ref attaches exactly when
   * the node is created and detaches exactly when it goes away.
   *
   * It is also registered natively rather than through React so the listener can
   * be non-passive and actually suppress the browser's own page zoom.
   */
  const onWheel = useCallback((event: WheelEvent): void => {
    const node = viewportRefCurrent.current
    if (node === null) return
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      const rect = node.getBoundingClientRect()
      zoomTo(camera.current.zoom - event.deltaY * 0.0022, { x: event.clientX - rect.left, y: event.clientY - rect.top })
      return
    }
    // A plain wheel pans the wall. `preventDefault` stops the surrounding page
    // from scrolling behind the canvas, which made the wall feel detached.
    event.preventDefault()
    camera.current.panX -= event.deltaX * WHEEL_PAN
    camera.current.panY -= event.deltaY * WHEEL_PAN
    applyCamera()
  }, [applyCamera, zoomTo])

  /** Attach the wheel listener to the canvas node, and only to that node. */
  const bindViewport = useCallback((node: HTMLDivElement | null): void => {
    viewportRefCurrent.current = node
    detachWheel.current?.()
    detachWheel.current = null
    if (node === null) return
    node.addEventListener('wheel', onWheel, { passive: false })
    detachWheel.current = () => node.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // A new handler identity must be re-bound to the node that is already mounted.
  useEffect(() => {
    const node = viewportRefCurrent.current
    if (node === null) return
    detachWheel.current?.()
    node.addEventListener('wheel', onWheel, { passive: false })
    detachWheel.current = () => node.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // A viewport resize (window drag, sidebar collapse) must not leave the wall
  // half off screen: re-fit it, but only when it is not being interacted with.
  useEffect(() => {
    const node = viewportRefCurrent.current
    if (node === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (drag.current !== null || pan.current !== null) return
      centreRequest.current = true
      setViewportTick((value) => value + 1)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [view])

  /**
   * Re-apply the camera after every render.
   *
   * Cheap (two style writes) and always correct: the pointer loop mutates
   * `camera.current` directly, so a render triggered by anything else must not
   * leave the nodes showing a stale transform.
   */
  useLayoutEffect(() => {
    if (view !== 'canvas') return
    if (centreRequest.current) {
      centreRequest.current = false
      fitWall()
      return
    }
    applyCamera()
  }, [applyCamera, fitWall, view, viewportTick])

  /** Begin a drag; the move itself is applied on pointerup through the Host. */
  function startDrag(note: Note, event: React.PointerEvent<HTMLElement>): void {
    if (event.button !== 0 || event.isPrimary === false) return
    const layout = layoutOf(note, indexOf(note))
    const node = event.currentTarget as HTMLElement
    // Mark the card as dragging directly on the node: going through React state
    // here re-rendered the entire wall on press and release, which is the main
    // reason the drag felt laggy. The CSS hook is a data attribute, so it costs
    // one attribute write instead — and it disables the placement transition,
    // which is what keeps the card glued to the pointer.
    node.setAttribute('data-dragging', 'true')
    // Assign through a named value, not an inline literal: a literal followed
    // by a `(` on the next line parses as a call expression, not as ASI.
    drag.current = {
      id: note.id,
      note,
      pointerId: event.pointerId,
      node,
      startX: event.clientX,
      startY: event.clientY,
      originX: layout.x,
      originY: layout.y,
      rotate: layout.rotate,
      width: layout.width,
      moved: false,
      captured: false,
      frame: 0,
      lastX: event.clientX,
      lastY: event.clientY,
    }
    // Capture is an optimisation, not a requirement: the move/up listeners are
    // on `window`, so the drag works without it. Guarded because a capture call
    // throws when the pointer id is no longer active (and in DOM-less tests).
    try {
      node.setPointerCapture?.(event.pointerId)
      drag.current.captured = true
    } catch {
      // Ignore: the window-level listeners still receive the drag.
    }
  }

  /** Begin a canvas pan when the press lands on empty paper, not on a card. */
  function startPan(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || event.isPrimary === false) return
    const target = event.target as HTMLElement | null
    if (target !== null && target.closest('.skw-note') !== null) return
    const node = viewportRefCurrent.current
    if (node === null) return
    node.setAttribute('data-panning', 'true')
    pan.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: camera.current.panX,
      originY: camera.current.panY,
      node,
      frame: 0,
      lastX: event.clientX,
      lastY: event.clientY,
    }
  }

  /**
   * The pointer loop.
   *
   * Registered ONCE for the page's lifetime, not per drag: an effect keyed on
   * `draggingId` tore down and re-added three window listeners on every press
   * and release, and re-registered whenever `notes` changed mid-drag. Every
   * handler below reads live state from refs, so a single registration is
   * correct for any number of drags and pans.
   *
   * Three things keep the drag smooth:
   * - the offset is written on one element's `transform`, and the placement
   *   transition is disabled while dragging (an animated transform fights every
   *   frame of input and reads as rubber-banding);
   * - several pointermoves are coalesced into one write per animation frame,
   *   because a high-rate trackpad emits far more events than there are paints;
   * - nothing in this path calls setState, so React never re-renders the wall
   *   while the pointer is down.
   */
  useEffect(() => {
    const paintDrag = (current: NonNullable<typeof drag.current>): void => {
      current.frame = 0
      const node = current.node
      if (node === null) return
      // The world wrapper is scaled, so a translate inside it is multiplied by
      // the zoom: dividing keeps the card exactly under the pointer.
      const zoomNow = camera.current.zoom
      const dx = (current.lastX - current.startX) / zoomNow
      const dy = (current.lastY - current.startY) / zoomNow
      node.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${current.rotate}deg)`
    }

    const paintPan = (current: NonNullable<typeof pan.current>): void => {
      current.frame = 0
      camera.current.panX = current.originX + (current.lastX - current.startX)
      camera.current.panY = current.originY + (current.lastY - current.startY)
      applyCamera()
    }

    const move = (event: PointerEvent): void => {
      const current = drag.current
      if (current !== null && event.pointerId === current.pointerId) {
        current.lastX = event.clientX
        current.lastY = event.clientY
        if (!current.moved) {
          if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD) return
          current.moved = true
        }
        // Coalesce: one transform write per frame instead of one per event.
        if (current.frame === 0) current.frame = requestAnimationFrame(() => paintDrag(current))
        return
      }
      const panning = pan.current
      if (panning !== null && event.pointerId === panning.pointerId) {
        panning.lastX = event.clientX
        panning.lastY = event.clientY
        if (panning.frame === 0) panning.frame = requestAnimationFrame(() => paintPan(panning))
      }
    }

    const finish = (event: PointerEvent): void => {
      const panning = pan.current
      if (panning !== null && event.pointerId === panning.pointerId) {
        pan.current = null
        // A pan that ends inside the same frame never got painted: cancelling
        // the pending frame would silently drop the whole gesture, which is
        // exactly what a quick flick does. Apply the final offset instead.
        if (panning.frame !== 0) {
          cancelAnimationFrame(panning.frame)
          panning.frame = 0
          camera.current.panX = panning.originX + (panning.lastX - panning.startX)
          camera.current.panY = panning.originY + (panning.lastY - panning.startY)
          applyCamera()
        }
        panning.node?.removeAttribute('data-panning')
      }
      const current = drag.current
      if (current === null || event.pointerId !== current.pointerId) return
      drag.current = null
      if (current.frame !== 0) cancelAnimationFrame(current.frame)
      const node = current.node
      const zoomNow = camera.current.zoom
      const release = (): void => {
        if (current.captured) {
          try {
            node?.releasePointerCapture?.(event.pointerId)
          } catch {
            // The pointer may already be gone; nothing to release.
          }
        }
      }
      if (!current.moved) {
        // A press that never travelled is a click: drop the drag hook and let
        // the browser's click land on the card's own handlers.
        node?.removeAttribute('data-dragging')
        if (node !== null) node.style.transform = `rotate(${current.rotate}deg)`
        release()
        return
      }
      const dx = (current.lastX - current.startX) / zoomNow
      const dy = (current.lastY - current.startY) / zoomNow
      // The card keeps the tilt and width it had: a drag only changes where it
      // sits, so `rotate`/`width` come from the captured layout, not defaults.
      // Clamped with the same function the Host uses, so the card lands exactly
      // where it will be stored and never snaps after the reload.
      // A dropped card may not land on the centrepiece: the reserve is a magnetic
      // edge, not a rule that is only enforced when the wall is tidied.
      const layout = pushOutOfReserve(
        current.note,
        clampLayout({ x: current.originX + dx, y: current.originY + dy, rotate: current.rotate, width: current.width }),
        centreReserve(),
      )
      if (node !== null) {
        node.removeAttribute('data-dragging')
        // Hand the drag offset over to `left`/`top` in the same frame: the new
        // world position is exactly where the card already is on screen, so the
        // React update below is invisible instead of a snap back to the corner
        // while the Host round-trip is still in flight.
        node.style.transform = `rotate(${current.rotate}deg)`
        node.style.left = `${layout.x}px`
        node.style.top = `${layout.y}px`
        release()
      }
      // Optimistic placement, reconciled by the reload that `mutate` runs.
      setNotes((previous) => previous.map((note) => (note.id === current.id ? { ...note, layout } : note)))
      live.current.mutate(async () => { await api.move(current.id, layout, life.current.signal) })
    }

    // `pointerup` and `pointercancel` share the same teardown; a cancel is not a
    // move, so `moved` decides whether a write happens.
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      const pending = drag.current
      if (pending !== null && pending.frame !== 0) cancelAnimationFrame(pending.frame)
      const pendingPan = pan.current
      if (pendingPan !== null && pendingPan.frame !== 0) cancelAnimationFrame(pendingPan.frame)
      pan.current?.node?.removeAttribute('data-panning')
    }
  }, [api, applyCamera])

  /** Stable action bag for the memoized cards. */
  const latestActions = useRef<CardActions | null>(null)
  latestActions.current = {
    edit: openComposer,
    patch: (note, patch) => { void mutate(async () => { await api.update(note.id, patch, life.current.signal) }) },
    remove: (note) => setConfirming(note),
    resize: (note, width) => {
      void mutate(async () => {
        const current = notes.find((candidate) => candidate.id === note.id)
        if (current !== undefined) await api.move(note.id, { ...layoutOf(current, stableIndex.get(current.id) ?? 0), width }, life.current.signal)
      })
    },
    drag: startDrag,
  }
  const actions = useMemo<CardActions>(() => ({
    edit: (note) => latestActions.current?.edit(note),
    patch: (note, patch) => latestActions.current?.patch(note, patch),
    remove: (note) => latestActions.current?.remove(note),
    resize: (note, width) => latestActions.current?.resize(note, width),
    drag: (note, event) => latestActions.current?.drag(note, event),
  }), [])

  return (
    <section className="skw-page" aria-label={t('title')}>
      <style>{WALL_CSS}</style>

      <div className="skw-body" data-view={view}>
        {error !== '' && (
          <p className="skw-error" role="alert">
            {error} <button className="skw-btn skw-btn-quiet" type="button" onClick={() => void reload({ includeArchived, sort })}>{t('retry')}</button>
          </p>
        )}
        {loading && notes.length === 0 ? (
          <div className="skw-empty"><p>{t('loading')}</p></div>
        ) : view === 'list' ? (
          <div className="skw-list">
            {visible.map((note) => (
              <NoteRow key={note.id} note={note} t={t} locale={activeLocale} onEdit={openComposer} />
            ))}
            {visible.length === 0 && <p className="skw-list-empty">{emptyCopy}</p>}
          </div>
        ) : view === 'grid' ? (
          <div className="skw-grid">
            {visible.map((note) => (
              <NoteCard key={note.id} note={note} index={indexOf(note)} surface="grid" t={t} locale={activeLocale} actions={actions} />
            ))}
            {visible.length === 0 && <p className="skw-list-empty">{emptyCopy}</p>}
          </div>
        ) : (
          <div ref={bindViewport} className="skw-canvas" data-zoomed={zoom !== 1} onPointerDown={startPan}>
            <div ref={worldRef} className="skw-world">
              {visible.map((note) => (
                <NoteCard key={note.id} note={note} index={indexOf(note)} surface="canvas" t={t} locale={activeLocale}
                  actions={actions} arrived={note.id === arrivedId} />
              ))}
            </div>

            {/*
              The wall's centrepiece.

              It is a SCREEN-space overlay, not part of the transformed world: the
              greeting and the capture field belong to the page, so they must stay
              put when the wall pans or zooms. `pointer-events: none` on the
              wrapper keeps the paper behind it draggable; only the field itself
              takes input. Tidy keeps a clear disc here (`CENTRE_RADIUS`), so a
              card is never hidden underneath.
            */}
            <div className="skw-centre" ref={centreRef} aria-hidden={false}>
              <p className="skw-centre-hello">{greeting}</p>
              <p className="skw-centre-tally" data-empty={visible.length === 0}>
                {/* An empty wall still explains itself: the reason (no notes, no
                    matches, empty archive) is more useful here than a bare zero,
                    and the capture field stays available either way. */}
                {visible.length === 0
                  ? emptyCopy
                  : t('centreTally', { count: visible.length, archived: archivedCount })}
              </p>
              <form
                className="skw-capture"
                onSubmit={(event) => {
                  event.preventDefault()
                  const body = capture.trim()
                  if (body === '' || busy) return
                  void mutate(async () => {
                    // The reserve makes the Host place the card in a gap that is
                    // genuinely free on the CURRENT view, and the arrival marker
                    // then reveals and highlights it.
                    const note = await api.create({ body }, life.current.signal, { centreReserve: centreReserve() })
                    arrival.current = { id: note.id, token: Date.now() }
                    setArrivedId(note.id)
                    setCapture('')
                  })
                }}
              >
                <span className="skw-capture-icon" aria-hidden="true">✎</span>
                <input
                  className="skw-capture-input"
                  value={capture}
                  placeholder={t('capturePlaceholder')}
                  aria-label={t('capturePlaceholder')}
                  maxLength={LIMITS.body}
                  onChange={(event) => setCapture(event.target.value)}
                />
                <button className="skw-capture-go" type="submit" disabled={busy || capture.trim() === ''} aria-label={t('captureGo')}>
                  ↵
                </button>
              </form>
            </div>
          </div>
        )}
      </div>

      {/*
        The floating dock.

        Everything that used to be a toolbar row across the top now lives at the
        bottom, over the canvas: the wall gets the whole window, and the controls
        sit where the pointer already is after a drag. It is one row of quiet
        pills, with the capture action on the right.
      */}
      {/*
        The floating dock.

        One quiet strip over the bottom of the canvas, so the wall gets the whole
        window and the controls sit where the pointer already is after a drag.
        It is deliberately SHORT: search, the filter that is actually in use, the
        view switch, zoom and the primary action. Everything that is a mode rather
        than a frequent click (sort order, the archive sweep) lives in one overflow
        menu, because nine always-visible controls in a row read as a toolbar and
        overflowed the page on a narrow window.
      */}
      <div className="skw-dock" ref={dockRef} role="toolbar" aria-label={t('title')}>
        <div className="skw-search-wrap">
          <span className="skw-search-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <circle cx="10.5" cy="10.5" r="6.2" stroke="currentColor" strokeWidth="1.8" />
              <path d="M15.4 15.4L20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <input className="skw-search" type="search" value={query} placeholder={t('search')} aria-label={t('search')}
            onChange={(event) => setQuery(event.target.value)} />
        </div>

        <span className="skw-dock-divider" aria-hidden="true" />

        <div className="skw-seg" role="group" aria-label={t('filters')}>
          {(['all', 'pinned', 'archived'] as const).map((key) => (
            <button key={key} type="button" data-on={filter === key} onClick={() => setFilter(key)}
              title={key === 'all' ? t('all') : key === 'pinned' ? t('pin') : t('archive')}>
              {key === 'all' ? t('all') : key === 'pinned' ? t('pin') : t('archive')}
            </button>
          ))}
        </div>

        <span className="skw-dock-divider" aria-hidden="true" />

        {/* Icons, not words: three words of view names made this the widest group
            in the dock, and the icons are unambiguous once the title explains them. */}
        <div className="skw-seg skw-seg-icons" role="group" aria-label={t('viewLabel')}>
          {(['canvas', 'grid', 'list'] as const).map((mode) => (
            <button key={mode} type="button" data-on={view === mode} onClick={() => setView(mode)}
              aria-label={t(`view_${mode}`)} title={t(`view_${mode}`)} aria-pressed={view === mode}>
              {mode === 'canvas' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="3" y="4" width="8" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.7" />
                  <rect x="13" y="7" width="8" height="6" rx="1.6" stroke="currentColor" strokeWidth="1.7" />
                  <rect x="6" y="14" width="8" height="6" rx="1.6" stroke="currentColor" strokeWidth="1.7" />
                </svg>
              ) : mode === 'grid' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.7" />
                  <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.7" />
                  <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.7" />
                  <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.7" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 6.5h16M4 12h16M4 17.5h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              )}
            </button>
          ))}
        </div>

        {view === 'canvas' && (
          <>
            <span className="skw-dock-divider" aria-hidden="true" />
            <div className="skw-dock-zoom" role="group" aria-label={t('zoomLabel')}>
              <button className="skw-camera-btn" type="button" aria-label={t('zoomOut')} title={t('zoomOut')}
                onClick={() => zoomTo(zoom - 0.15)}>−</button>
              <button className="skw-camera-value" type="button" aria-label={t('zoomReset')} title={t('zoomReset')}
                onClick={resetView}>{Math.round(zoom * 100)}%</button>
              <button className="skw-camera-btn" type="button" aria-label={t('zoomIn')} title={t('zoomIn')}
                onClick={() => zoomTo(zoom + 0.15)}>+</button>
              <button className="skw-camera-btn" type="button" aria-label={t('arrange')} title={t('arrange')}
                disabled={busy || visible.length === 0} onClick={() => void tidyWall()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9L12 3.5Z"
                    stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                  <path d="M18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" fill="currentColor" />
                </svg>
              </button>
            </div>
          </>
        )}

        <span className="skw-dock-divider" aria-hidden="true" />

        {/* Overflow: modes, not frequent clicks. */}
        <div className="skw-menu-wrap" ref={menuRef}>
          <button className="skw-camera-btn" type="button" data-on={menuOpen}
            aria-label={t('more')} title={t('more')} aria-expanded={menuOpen} aria-haspopup="menu"
            onClick={() => setMenuOpen((value) => !value)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="6" cy="12" r="1.6" fill="currentColor" />
              <circle cx="12" cy="12" r="1.6" fill="currentColor" />
              <circle cx="18" cy="12" r="1.6" fill="currentColor" />
            </svg>
          </button>
          {menuOpen && (
            <div className="skw-menu" role="menu" aria-label={t('more')}>
              <div className="skw-menu-label">{t('sortLabel')}</div>
              {(['pinned', 'created', 'updated'] as const).map((key) => (
                <button key={key} type="button" role="menuitemradio" aria-checked={sort === key} data-on={sort === key}
                  onClick={() => { setSort(key); setMenuOpen(false) }}>
                  <span className="skw-menu-tick" aria-hidden="true">{sort === key ? '✓' : ''}</span>
                  {key === 'pinned' ? t('sortPinned') : key === 'created' ? t('sortCreated') : t('sortUpdated')}
                </button>
              ))}
              <div className="skw-menu-rule" role="separator" />
              <button type="button" role="menuitemcheckbox" aria-checked={showArchived} data-on={showArchived}
                onClick={() => setShowArchived((value) => !value)}>
                <span className="skw-menu-tick" aria-hidden="true">{showArchived ? '✓' : ''}</span>
                {showArchived ? t('hideArchived') : t('showArchived')}
              </button>
              {archivedCount > 0 && (
                <button type="button" role="menuitem" className="skw-menu-danger"
                  disabled={busy} onClick={() => { setMenuOpen(false); setConfirming('clear') }}>
                  <span className="skw-menu-tick" aria-hidden="true" />
                  {t('clearArchived')}
                </button>
              )}
            </div>
          )}
        </div>

        <span className="skw-count">{t('count', { count: visible.length })}</span>
        <button className="skw-dock-new" type="button" onClick={() => openComposer()} disabled={busy} aria-label={t('new')} title={t('new')}>
          +
        </button>
      </div>

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
