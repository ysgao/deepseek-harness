// @vitest-environment jsdom
// SideBySideDiff: row alignment (pure add, pure delete, equal- and
// unequal-length replacement pairing, unchanged lines staying in step on both
// sides), the empty-both-sides null render, the optional path banner, and the
// copy control's prefixed unified text on both the accepted and refused
// clipboard paths (writeClipboard's own return contract is pinned in
// terminal-block.spec.tsx; only its DOM consequence is asserted here).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SideBySideDiff } from '../src/index.ts'
import type { SideBySideDiffLabels } from '../src/index.ts'

afterEach(cleanup)

const LABELS: SideBySideDiffLabels = {
  copy: '复制',
  copied: '复制成功',
  resizeAria: 'Resize columns',
  resizeTitle: 'Drag to resize, double-click to reset',
}

beforeEach(() => {
  vi.useRealTimers()
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 200, top: 0, left: 0, right: 800, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }
  }
  const captured = new WeakSet<Element>()
  Element.prototype.setPointerCapture = function () { captured.add(this) }
  Element.prototype.releasePointerCapture = function () { captured.delete(this) }
  Element.prototype.hasPointerCapture = function () { return captured.has(this) }
})

interface Row {
  oldNum: string
  oldText: string
  newNum: string
  newText: string
}

/** The rendered rows, each side's gutter number and content text, in file order. */
function rows(container: HTMLElement): Row[] {
  const cells = [...container.querySelectorAll('[class*="_gutter_"], [class*="_content_"]')]
  const out: Row[] = []
  for (let i = 0; i < cells.length; i += 4) {
    out.push({
      oldNum: cells[i]?.textContent ?? '',
      oldText: cells[i + 1]?.textContent ?? '',
      newNum: cells[i + 2]?.textContent ?? '',
      newText: cells[i + 3]?.textContent ?? '',
    })
  }
  return out
}

describe('SideBySideDiff alignment', () => {
  it('renders a pure addition as new-only rows with blank old cells', () => {
    const { container } = render(<SideBySideDiff oldText={null} newText={'a\nb'} labels={LABELS} />)
    expect(rows(container)).toEqual([
      { oldNum: '', oldText: '', newNum: '1', newText: 'a' },
      { oldNum: '', oldText: '', newNum: '2', newText: 'b' },
    ])
    expect(container.querySelectorAll('[class*="_del_"]').length).toBe(0)
    expect(container.querySelectorAll('[class*="_add_"]').length).toBe(2)
  })

  it('renders a pure deletion as old-only rows with blank new cells', () => {
    const { container } = render(<SideBySideDiff oldText={'a\nb'} newText={null} labels={LABELS} />)
    expect(rows(container)).toEqual([
      { oldNum: '1', oldText: 'a', newNum: '', newText: '' },
      { oldNum: '2', oldText: 'b', newNum: '', newText: '' },
    ])
    expect(container.querySelectorAll('[class*="_add_"]').length).toBe(0)
    expect(container.querySelectorAll('[class*="_del_"]').length).toBe(2)
  })

  it('pairs an equal-length replacement row for row', () => {
    const { container } = render(<SideBySideDiff oldText={'x\ny'} newText={'p\nq'} labels={LABELS} />)
    expect(rows(container)).toEqual([
      { oldNum: '1', oldText: 'x', newNum: '1', newText: 'p' },
      { oldNum: '2', oldText: 'y', newNum: '2', newText: 'q' },
    ])
  })

  it('leaves the old side\'s excess lines unpaired when it is longer', () => {
    const { container } = render(<SideBySideDiff oldText={'x\ny\nz'} newText={'p'} labels={LABELS} />)
    expect(rows(container)).toEqual([
      { oldNum: '1', oldText: 'x', newNum: '1', newText: 'p' },
      { oldNum: '2', oldText: 'y', newNum: '', newText: '' },
      { oldNum: '3', oldText: 'z', newNum: '', newText: '' },
    ])
  })

  it('leaves the new side\'s excess lines unpaired when it is longer', () => {
    const { container } = render(<SideBySideDiff oldText={'x'} newText={'p\nq\nr'} labels={LABELS} />)
    expect(rows(container)).toEqual([
      { oldNum: '1', oldText: 'x', newNum: '1', newText: 'p' },
      { oldNum: '', oldText: '', newNum: '2', newText: 'q' },
      { oldNum: '', oldText: '', newNum: '3', newText: 'r' },
    ])
  })

  it('keeps unchanged context lines in step on both sides around a change', () => {
    const { container } = render(<SideBySideDiff oldText={'a\nb\nc'} newText={'a\nZ\nc'} labels={LABELS} />)
    expect(rows(container)).toEqual([
      { oldNum: '1', oldText: 'a', newNum: '1', newText: 'a' },
      { oldNum: '2', oldText: 'b', newNum: '2', newText: 'Z' },
      { oldNum: '3', oldText: 'c', newNum: '3', newText: 'c' },
    ])
    expect(container.querySelectorAll('[class*="_del_"]').length).toBe(1)
    expect(container.querySelectorAll('[class*="_add_"]').length).toBe(1)
  })

  it('renders identical non-empty content as plain rows on both sides', () => {
    const { container } = render(<SideBySideDiff oldText={'same\ntext'} newText={'same\ntext'} labels={LABELS} />)
    expect(rows(container)).toEqual([
      { oldNum: '1', oldText: 'same', newNum: '1', newText: 'same' },
      { oldNum: '2', oldText: 'text', newNum: '2', newText: 'text' },
    ])
    expect(container.querySelectorAll('[class*="_del_"]').length).toBe(0)
    expect(container.querySelectorAll('[class*="_add_"]').length).toBe(0)
  })

  it('renders nothing when both sides are empty', () => {
    const { container } = render(<SideBySideDiff oldText={null} newText={null} labels={LABELS} />)
    expect(container.firstChild).toBeNull()
  })

  it('treats a trailing newline as a terminator, not an extra blank line', () => {
    const { container } = render(<SideBySideDiff oldText={null} newText={'hello\n'} labels={LABELS} />)
    expect(rows(container)).toEqual([{ oldNum: '', oldText: '', newNum: '1', newText: 'hello' }])
  })
})

describe('SideBySideDiff divider', () => {
  it('drags the column divider to resize the ratio between the two sides', () => {
    const { container } = render(<SideBySideDiff oldText={'a\nb'} newText={'p\nq'} labels={LABELS} />)
    const divider = container.querySelector('[role="separator"]')
    const body = divider?.parentElement
    if (divider === null || divider === undefined || body === null || body === undefined) throw new Error('unreachable')
    expect(body.style.getPropertyValue('--dsl-sbs-diff-ratio')).toBe('0.5')
    act(() => { divider.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 400, bubbles: true, button: 0 })) })
    act(() => { divider.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 480, bubbles: true })) })
    act(() => { divider.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 480, bubbles: true })) })
    expect(Number(body.style.getPropertyValue('--dsl-sbs-diff-ratio'))).toBeCloseTo(0.6, 5)
  })
})

describe('SideBySideDiff banner', () => {
  it('shows the path label when provided', () => {
    render(<SideBySideDiff path="src/a.ts" oldText="x" newText="y" labels={LABELS} />)
    expect(screen.getByText('src/a.ts')).toBeTruthy()
  })

  it('renders an empty label, still with a copy control, when no path is given', () => {
    render(<SideBySideDiff oldText="x" newText="y" labels={LABELS} />)
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })
})

describe('SideBySideDiff copy', () => {
  it('copies the unified prefixed text and flips the label on success', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<SideBySideDiff path="a.ts" oldText={'a\nb\nc'} newText={'a\nZ\nc'} labels={LABELS} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    expect(writeText).toHaveBeenCalledWith('  a\n- b\n+ Z\n  c')
    expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('omits the added prefix for a deletion-only row', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<SideBySideDiff path="a.ts" oldText={'only\nhere'} newText={null} labels={LABELS} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    expect(writeText).toHaveBeenCalledWith('- only\n- here')
  })

  it('keeps the label on a refused clipboard write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<SideBySideDiff path="a.ts" oldText={null} newText="x" labels={LABELS} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('ignores a second click while the copied label is showing', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<SideBySideDiff path="a.ts" oldText={null} newText="x" labels={LABELS} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制成功' })) })
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})
