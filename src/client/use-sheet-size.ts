/**
 * The composer sheet's resize behaviour.
 *
 * The geometry itself (defaults, clamps, storage format) lives in
 * `sheet-size.ts` as pure functions; this module only wires them to a pointer
 * loop, a keyboard handler and a viewport listener. Keeping the split means the
 * arithmetic is tested without a DOM and this file stays small enough to read in
 * one go.
 *
 * Two details are load-bearing:
 *
 * 1. **A resize starts from what is on screen, not from the stored preference.**
 *    A user whose preference is 880px wide opens the wall in a 700px window and
 *    sees 652px. Shrinking must respond from 652. Measured from the preference it
 *    would be 840, which the window clamps straight back to 652 — the grip would
 *    look dead across the whole range it can actually move in.
 * 2. **A press that never moves writes nothing.** `pointerdown`/`pointerup` with
 *    no movement is a click, and committing the clamped size there would silently
 *    replace an 880px preference with the smaller size the window happened to
 *    allow.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  SHEET_DEFAULT,
  arrowDelta,
  clampSheetSize,
  mergePreference,
  readSheetSize,
  resizeSheet,
  writeSheetSize,
  type SheetSize,
  type StorageLike,
  type Viewport,
} from './sheet-size.js'

/**
 * The live `localStorage`, or null.
 *
 * Reaching the property itself throws under a sandboxed or partitioned origin, so
 * the failure belongs here rather than at every call site.
 */
function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** The current viewport, with a non-zero floor so a clamp can never invert. */
function viewportNow(): Viewport {
  const width = typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 0
  const height = typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 0
  return { width: Math.max(1, width), height: Math.max(1, height) }
}

/** Everything the composer binds to its resize grip. */
export interface SheetResizeGrip {
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void
  onPointerUp(event: ReactPointerEvent<HTMLElement>): void
  onPointerCancel(event: ReactPointerEvent<HTMLElement>): void
  onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void
  onDoubleClick(): void
}

export interface SheetSizeState {
  /** The size to render: the preference, clamped into the current viewport. */
  size: SheetSize
  /**
   * The range the grasp can currently reach.
   *
   * Exposed rather than assumed because a focusable separator needs honest
   * `aria-valuemin`/`aria-valuemax`, and the maximum is a function of the window:
   * hard-coding it would tell a screen reader a number the grip cannot reach.
   */
  bounds: { min: SheetSize; max: SheetSize }
  /** The handlers the grip binds. */
  grip: SheetResizeGrip
}

export function useSheetSize(): SheetSizeState {
  // Read storage once, lazily: the first paint already shows the remembered size,
  // so the sheet never appears at the default and then jumps.
  const [preferred, setPreferred] = useState<SheetSize>(() => readSheetSize(browserStorage()) ?? { ...SHEET_DEFAULT })
  const [viewport, setViewport] = useState<Viewport>(viewportNow)

  /**
   * The newest values, readable from a pointer handler.
   *
   * React state captured inside a handler belongs to the render that created it,
   * and a pointer loop runs for many frames inside one render.
   */
  const latest = useRef({ preferred, viewport })
  latest.current = { preferred, viewport }

  const storage = useRef<StorageLike | null>(null)
  storage.current ??= browserStorage()

  const persist = useCallback((size: SheetSize): void => {
    writeSheetSize(storage.current, size)
  }, [])

  /** Store a preference and apply it. */
  const commit = useCallback(
    (size: SheetSize): void => {
      latest.current = { ...latest.current, preferred: size }
      setPreferred(size)
      persist(size)
    },
    [persist],
  )

  const reset = useCallback((): void => {
    commit({ ...SHEET_DEFAULT })
  }, [commit])

  // Track the viewport: the applied size is derived at render, so shrinking the
  // window shrinks the sheet without touching the stored preference, and growing
  // it back restores the size the user picked.
  useLayoutEffect(() => {
    const sync = (): void => {
      const next = viewportNow()
      const current = latest.current.viewport
      // Bail on an identical measurement: `resize` fires for many reasons that do
      // not change the window's extent (a devtools panel, a scrollbar appearing),
      // and each one would otherwise re-render the whole composer for nothing.
      if (next.width === current.width && next.height === current.height) return
      latest.current = { ...latest.current, viewport: next }
      setViewport(next)
    }
    globalThis.addEventListener?.('resize', sync)
    // No initial `sync()` call: the `useState` initializer already measured the
    // viewport, so calling it here only allocated an identical object and forced
    // a second render on every composer open.
    return () => {
      globalThis.removeEventListener?.('resize', sync)
    }
  }, [])

  /** The drag in flight: the ON-SCREEN size and pointer position it started from. */
  const drag = useRef<{
    pointerId: number
    /** The ON-SCREEN size at pointerdown; every move is measured from it. */
    start: SheetSize
    /** The PREFERENCE at pointerdown; used to reconcile which axis really moved. */
    startPreference: SheetSize
    x: number
    y: number
    moved: boolean
  } | null>(null)

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    // Without this, dragging across the page starts selecting the footer text.
    // It also suppresses the browser's focus-on-mousedown, so focus is restored
    // explicitly: a user who clicks the grip and then wants the arrow keys should
    // not have to Tab back to it.
    event.preventDefault()
    try {
      event.currentTarget.focus()
    } catch {
      // A detached node cannot take focus; the drag is unaffected.
    }
    drag.current = {
      pointerId: event.pointerId,
      start: clampSheetSize(latest.current.preferred, latest.current.viewport),
      startPreference: latest.current.preferred,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    }
    // Capture, so the loop keeps receiving moves once the pointer leaves the small
    // grip — which happens on the first pixel of movement.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // A synthetic pointer id (tests, some automation) cannot be captured; the
      // drag still works because the handlers stay mounted.
    }
  }, [])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const current = drag.current
    if (current === null || current.pointerId !== event.pointerId) return
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    if (dx === 0 && dy === 0) return
    current.moved = true
    // Always measured from the START size: accumulating one delta per move drifts,
    // and a drag that overshoots the clamp could then never come back.
    const next = resizeSheet(current.start, { dx, dy }, latest.current.viewport)
    latest.current = { ...latest.current, preferred: next }
    setPreferred(next)
  }, [])

  const finish = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const current = drag.current
      // Match the pointer that STARTED the drag. On a touch screen a second
      // finger's pointerup would otherwise end — and persist — the first
      // finger's resize.
      if (current === null || current.pointerId !== event.pointerId) return
      drag.current = null
      try {
        event.currentTarget.releasePointerCapture?.(current.pointerId)
      } catch {
        // Already released, or never captured.
      }
      // A click on the grip must not rewrite the preference, and the pointer loop
      // must never touch storage per frame.
      if (!current.moved) return
      // Same reconciliation as the keyboard: a drag in a squeezed window resizes
      // what the user can see, and must not overwrite the axis that could not
      // move with its clamped value.
      const applied = clampSheetSize(current.startPreference, latest.current.viewport)
      commit(mergePreference(current.startPreference, applied, latest.current.preferred))
    },
    [commit],
  )

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      // ⌘/Ctrl+arrow and ⌘/Ctrl+0 belong to the browser and the OS (page zoom,
      // window snapping). Repurposing them silently is worse than ignoring the
      // grip while a modifier is down — and this guard must come BEFORE the reset
      // key, or ⌘+0 would resize the sheet instead of resetting the page zoom.
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // Holding a key fires ~30 repeats a second, and every commit is a
      // synchronous localStorage write plus a full re-render of the sheet. One
      // keypress is one step.
      if (event.repeat) return
      // Zero resets, and it is the shortcut a user is most likely to try.
      if (event.key === '0') {
        event.preventDefault()
        event.stopPropagation()
        reset()
        return
      }
      const delta = arrowDelta(event.key, event.shiftKey)
      if (delta === null) return
      // Otherwise the arrow scrolls the sheet body or moves focus behind the grip.
      event.preventDefault()
      event.stopPropagation()
      // Measured from what is on screen, then reconciled against the preference:
      // an axis this key did not move keeps the value the user actually chose.
      const applied = clampSheetSize(latest.current.preferred, latest.current.viewport)
      const next = resizeSheet(applied, delta, latest.current.viewport)
      commit(mergePreference(latest.current.preferred, applied, next))
    },
    [commit, reset],
  )

  return {
    size: clampSheetSize(preferred, viewport),
    bounds: {
      min: clampSheetSize({ width: 0, height: 0 }, viewport),
      max: clampSheetSize({ width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY }, viewport),
    },
    grip: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      onKeyDown,
      onDoubleClick: reset,
    },
  }
}
