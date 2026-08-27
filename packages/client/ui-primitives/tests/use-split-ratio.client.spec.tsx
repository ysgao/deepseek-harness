// @vitest-environment jsdom
// useSplitRatio: the divider's ratio state through pointer drag (with
// capture), arrow-key nudging, double-click reset to default, and the guard
// branches (non-primary button, a move/up for a pointer never captured).
// jsdom has no layout engine, so the container width and pointer-capture
// state are stubbed the same way packages/client/ui-layout's AppFrame spec
// stubs them for its own drag handle.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSplitRatio } from '../src/useSplitRatio.ts'
import type { SplitRatioOptions } from '../src/useSplitRatio.ts'

function Harness({ options }: { options?: SplitRatioOptions }) {
  const { ratio, dividerProps } = useSplitRatio(options)
  return (
    <div style={{ width: 400 }}>
      <div data-testid="divider" tabIndex={0} {...dividerProps} />
      <span data-testid="ratio">{ratio}</span>
    </div>
  )
}

function drag(handle: Element, fromX: number, toX: number): void {
  act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: fromX, bubbles: true, button: 0 })) })
  act(() => { handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: toX, bubbles: true })) })
  act(() => { handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: toX, bubbles: true })) })
}

beforeEach(() => {
  Element.prototype.getBoundingClientRect = function () {
    return { width: 400, height: 100, top: 0, left: 0, right: 400, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }
  }
  const captured = new WeakSet<Element>()
  Element.prototype.setPointerCapture = function () { captured.add(this) }
  Element.prototype.releasePointerCapture = function () { captured.delete(this) }
  Element.prototype.hasPointerCapture = function () { return captured.has(this) }
})

afterEach(cleanup)

describe('useSplitRatio', () => {
  it('starts at the default ratio (0.5 unless overridden)', () => {
    const { getByTestId } = render(<Harness />)
    expect(getByTestId('ratio').textContent).toBe('0.5')
  })

  it('moves the ratio by the drag distance over the container width', () => {
    const { getByTestId } = render(<Harness />)
    drag(getByTestId('divider'), 200, 240)
    // container width 400, dx 40 -> +0.1
    expect(Number(getByTestId('ratio').textContent)).toBeCloseTo(0.6, 5)
  })

  it('clamps the ratio to the configured min/max', () => {
    const { getByTestId } = render(<Harness options={{ min: 0.3, max: 0.7 }} />)
    drag(getByTestId('divider'), 200, 1000)
    expect(Number(getByTestId('ratio').textContent)).toBeCloseTo(0.7, 5)
    drag(getByTestId('divider'), 200, -1000)
    expect(Number(getByTestId('ratio').textContent)).toBeCloseTo(0.3, 5)
  })

  it('ignores a non-primary-button pointerdown', () => {
    const { getByTestId } = render(<Harness />)
    const divider = getByTestId('divider')
    act(() => { divider.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 200, bubbles: true, button: 2 })) })
    act(() => { divider.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 300, bubbles: true })) })
    expect(getByTestId('ratio').textContent).toBe('0.5')
  })

  it('ignores a pointermove/pointerup for a pointer that was never captured', () => {
    const { getByTestId } = render(<Harness />)
    const divider = getByTestId('divider')
    act(() => { divider.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: 300, bubbles: true })) })
    act(() => { divider.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, clientX: 300, bubbles: true })) })
    expect(getByTestId('ratio').textContent).toBe('0.5')
  })

  it('stops tracking a drag on pointercancel', () => {
    const { getByTestId } = render(<Harness />)
    const divider = getByTestId('divider')
    act(() => { divider.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 200, bubbles: true, button: 0 })) })
    act(() => { divider.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })) })
    act(() => { divider.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 300, bubbles: true })) })
    expect(getByTestId('ratio').textContent).toBe('0.5')
  })

  it('nudges the ratio with arrow keys', () => {
    const { getByTestId } = render(<Harness />)
    const divider = getByTestId('divider')
    act(() => { divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
    expect(Number(getByTestId('ratio').textContent)).toBeCloseTo(0.52, 5)
    act(() => { divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })) })
    act(() => { divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })) })
    expect(Number(getByTestId('ratio').textContent)).toBeCloseTo(0.48, 5)
  })

  it('ignores an unrelated key', () => {
    const { getByTestId } = render(<Harness />)
    const divider = getByTestId('divider')
    act(() => { divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(getByTestId('ratio').textContent).toBe('0.5')
  })

  it('resets to the default ratio on double-click after dragging away from it', () => {
    const { getByTestId } = render(<Harness options={{ defaultRatio: 0.4 }} />)
    const divider = getByTestId('divider')
    drag(divider, 200, 260)
    expect(getByTestId('ratio').textContent).not.toBe('0.4')
    act(() => { divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(getByTestId('ratio').textContent).toBe('0.4')
  })

  it('does nothing on pointerdown when the container width is zero', () => {
    Element.prototype.getBoundingClientRect = function () {
      return { width: 0, height: 100, top: 0, left: 0, right: 0, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }
    }
    const { getByTestId } = render(<Harness />)
    drag(getByTestId('divider'), 200, 260)
    expect(getByTestId('ratio').textContent).toBe('0.5')
  })
})
