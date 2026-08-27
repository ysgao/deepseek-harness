// @vitest-environment jsdom
// FileEditor: mounts a real CodeMirror 6 EditorView (no mock) and asserts
// its user-visible behavior — initial content, the Markdown split preview
// (and its absence for plain text), edits reaching onChange, the debounced
// preview refresh, and the Mod-s save shortcut. CodeMirror has no
// ResizeObserver dependency it cannot tolerate missing, but jsdom lacks the
// constructor entirely (see useAnchoredPosition's own spec for the same
// stub), so it's stubbed defensively the same way.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { FileEditor } from '../src/index.ts'

afterEach(cleanup)

// jsdom implements neither constructor: CodeMirror's block-measurement path
// (Range/Element.getClientRects) and its resize-driven remeasure both no-op
// safely once these exist, the same tolerance this repo's own
// useAnchoredPosition hook already relies on in jsdom (see its own spec).
const emptyRectList = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
if (typeof Range.prototype.getClientRects !== 'function') Range.prototype.getClientRects = emptyRectList
if (typeof Element.prototype.getClientRects !== 'function') Element.prototype.getClientRects = emptyRectList

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Simulate typed input the way CodeMirror's own paste handler reads it — jsdom fires no native text-insertion events. */
function pasteInto(content: Element, text: string): void {
  fireEvent.paste(content, {
    clipboardData: { getData: () => text },
  })
}

describe('FileEditor', () => {
  it('renders the initial buffer for a plain text file, with no preview pane', () => {
    const { container } = render(
      <FileEditor path="/ws/notes.txt" text="hello world" kind="text" onChange={vi.fn()} />,
    )
    expect(container.querySelector('.cm-content')?.textContent).toBe('hello world')
    expect(container.querySelector('[class*="_previewPane_"]')).toBeNull()
  })

  it('renders a live-rendered preview pane alongside the editor for Markdown', () => {
    const { container, getByRole } = render(
      <FileEditor path="/ws/README.md" text="# Title" kind="markdown" onChange={vi.fn()} />,
    )
    expect(container.querySelector('.cm-content')?.textContent).toBe('# Title')
    expect(getByRole('heading', { name: 'Title' })).not.toBeNull()
  })

  it('reports edits through onChange', async () => {
    const onChange = vi.fn()
    const { container } = render(
      <FileEditor path="/ws/notes.txt" text="hello" kind="text" onChange={onChange} />,
    )
    const content = container.querySelector('.cm-content')
    if (content === null) throw new Error('unreachable')
    await act(async () => { pasteInto(content, ' world') })
    // The paste lands at the default (start-of-document) cursor position in
    // this headless simulation — the assertion cares that the edit reached
    // onChange with both fragments present, not the exact insertion point.
    const [reported] = onChange.mock.calls[0] as [string]
    expect(reported).toContain('hello')
    expect(reported).toContain('world')
    expect(reported.length).toBe('hello world'.length)
  })

  it('debounces the Markdown preview refresh behind an edit', async () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <FileEditor path="/ws/README.md" text="# One" kind="markdown" onChange={vi.fn()} />,
      )
      const content = container.querySelector('.cm-content')
      const preview = container.querySelector('[class*="_previewPane_"]')
      if (content === null || preview === null) throw new Error('unreachable')
      pasteInto(content, 'Two ')
      // Not yet refreshed: the debounce window hasn't elapsed.
      expect(preview.textContent).not.toContain('Two')
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(preview.textContent).toContain('Two')
    } finally {
      vi.useRealTimers()
    }
  })

  it('calls onSaveRequested and suppresses the browser default on Mod-s', () => {
    const onSaveRequested = vi.fn()
    const { container } = render(
      <FileEditor path="/ws/notes.txt" text="hello" kind="text" onChange={vi.fn()} onSaveRequested={onSaveRequested} />,
    )
    const content = container.querySelector('.cm-content')
    if (content === null) throw new Error('unreachable')
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    content.dispatchEvent(event)
    expect(onSaveRequested).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('tears the editor view down cleanly on unmount', () => {
    const { unmount } = render(
      <FileEditor path="/ws/notes.txt" text="hello" kind="text" onChange={vi.fn()} />,
    )
    expect(() => { unmount() }).not.toThrow()
  })
})
