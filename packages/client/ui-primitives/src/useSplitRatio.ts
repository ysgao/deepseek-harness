/**
 * A draggable vertical divider's position, as the left pane's share `[0, 1]`
 * of its container's width: pointer-drag (with capture), arrow-key nudging,
 * and double-click reset to `defaultRatio`. The divider element's *parent* is
 * read as the container at drag start (`getBoundingClientRect().width`), so
 * callers place the divider as a direct child of the element whose width
 * the ratio divides.
 */
import { useCallback, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'

/** Configures {@link useSplitRatio}'s initial position and drag bounds. */
export interface SplitRatioOptions {
  /** Left pane's initial share of the container width. Defaults to `0.5`. */
  defaultRatio?: number
  /** Minimum ratio the divider can be dragged to. Defaults to `0.2`. */
  min?: number
  /** Maximum ratio the divider can be dragged to. Defaults to `0.8`. */
  max?: number
}

/** Props to spread onto the divider element; drives the drag/keyboard/reset behavior described above. */
export interface SplitDividerProps {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerUp: (event: PointerEvent<HTMLElement>) => void
  onPointerCancel: () => void
  onDoubleClick: () => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

/** {@link useSplitRatio}'s return value: the current ratio and the divider's event handlers. */
export interface SplitRatioResult {
  /** The left pane's current share of the container width, in `[min, max]`. */
  ratio: number
  /** Spread onto the divider element. */
  dividerProps: SplitDividerProps
}

interface SplitDrag {
  pointerId: number
  startX: number
  startRatio: number
  containerWidth: number
}

const DEFAULT_RATIO = 0.5
const DEFAULT_MIN = 0.2
const DEFAULT_MAX = 0.8
const KEYBOARD_STEP = 0.02

/**
 * Track a draggable divider's ratio for a two-pane split.
 * @param options - see {@link SplitRatioOptions}.
 * @returns the current ratio and the divider's event handlers; see {@link SplitRatioResult}.
 */
export function useSplitRatio(options?: SplitRatioOptions): SplitRatioResult {
  const defaultRatio = options?.defaultRatio ?? DEFAULT_RATIO
  const min = options?.min ?? DEFAULT_MIN
  const max = options?.max ?? DEFAULT_MAX
  const [ratio, setRatio] = useState(defaultRatio)
  const drag = useRef<SplitDrag | null>(null)

  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, value)), [min, max])

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const container = event.currentTarget.parentElement
    // Every caller renders the divider as a direct child of the split
    // container it divides (see the module doc comment); nothing in a
    // portable test can leave a mounted divider parentless.
    /* v8 ignore next */
    if (container === null) return
    const containerWidth = container.getBoundingClientRect().width
    if (containerWidth === 0) return
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startRatio: ratio, containerWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }, [ratio])

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const active = drag.current
    if (active === null || active.pointerId !== event.pointerId) return
    setRatio(clamp(active.startRatio + (event.clientX - active.startX) / active.containerWidth))
  }, [clamp])

  const onPointerUp = useCallback((event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])

  const onPointerCancel = useCallback(() => { drag.current = null }, [])

  const onDoubleClick = useCallback(() => { setRatio(defaultRatio) }, [defaultRatio])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    setRatio(current => clamp(current + (event.key === 'ArrowLeft' ? -KEYBOARD_STEP : KEYBOARD_STEP)))
    event.preventDefault()
  }, [clamp])

  return {
    ratio,
    dividerProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onDoubleClick, onKeyDown },
  }
}
