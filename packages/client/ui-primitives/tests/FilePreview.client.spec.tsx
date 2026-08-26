// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { FilePreview } from '../src/FilePreview.tsx'
import type { FilePreviewState } from '../src/FilePreview.tsx'

afterEach(cleanup)

const labels = {
  loadingLabel: 'loading…',
  loadErrorLabel: 'load error',
  externalLabel: 'open externally',
  tooLargeLabel: (maxMB: number) => `too large (${maxMB}MB)`,
}

describe('FilePreview', () => {
  it('defaults the image alt text to the path when imageAlt is omitted', () => {
    const state: FilePreviewState = { phase: 'ready', content: { kind: 'binary', blobUrl: 'blob:fake-1' } }
    render(<FilePreview path="/ws/pixel.png" kind="image" state={state} {...labels} />)
    expect(screen.getByRole('img', { name: '/ws/pixel.png' })).not.toBeNull()
  })

  it('defaults the wrapper class to the component-owned style when className is omitted', () => {
    const state: FilePreviewState = { phase: 'ready', content: { kind: 'text', text: 'hi' } }
    const { container } = render(<FilePreview path="/ws/notes.txt" kind="text" state={state} {...labels} />)
    // The default wrapper carries the module's own scroll-cap class (a
    // caller-supplied className, exercised by FileViewer/FileView's own
    // suites, replaces it instead) — any non-empty class name is the signal.
    expect(container.firstElementChild?.className).not.toBe('')
  })

  it('shows the loading placeholder for an image kind whose ready content disagrees (text, not binary)', () => {
    // Both current callers only ever pair kind: 'image' with a binary read,
    // but the component itself does not enforce that — this exercises the
    // defensive branch a caller with a classification/content mismatch would hit.
    const state: FilePreviewState = { phase: 'ready', content: { kind: 'text', text: 'unexpected' } }
    render(<FilePreview path="/ws/pixel.png" kind="image" state={state} {...labels} />)
    expect(screen.getByText(labels.loadingLabel)).not.toBeNull()
  })
})
