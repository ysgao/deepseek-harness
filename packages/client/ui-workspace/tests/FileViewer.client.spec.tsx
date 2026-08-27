// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { WorkspaceFileBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcError, WorkspaceFileContent, WorkspaceFileVersion } from '@deepseek-ai/dsh-client-runtime/client'
import { FileViewer } from '../src/client/files/FileViewer.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh)

/** Deterministic blob URL doubles: jsdom has no real Blob decode/object-URL pipeline. */
function stubBlobUrl(): () => void {
  const created = URL.createObjectURL.bind(URL)
  const revoked = URL.revokeObjectURL.bind(URL)
  let counter = 0
  URL.createObjectURL = vi.fn(() => `blob:fake-${String(counter++)}`)
  URL.revokeObjectURL = vi.fn()
  return () => {
    URL.createObjectURL = created
    URL.revokeObjectURL = revoked
  }
}

function readFileOnce(content: WorkspaceFileContent): (path: string, signal?: AbortSignal) => Promise<WorkspaceFileContent> {
  return () => Promise.resolve(content)
}

/** The footer's own action button, distinguished from ReadBlock's unrelated internal copy button by container scope. */
function footerButton(name: string): HTMLElement {
  const dialog = screen.getByRole('dialog')
  const footer = dialog.querySelector('[class*="footer"]')
  if (footer === null) throw new Error('dialog has no footer element')
  const button = Array.from(footer.querySelectorAll('button')).find(el => el.textContent === name)
  if (button === undefined) throw new Error(`no footer button named "${name}"`)
  return button
}

describe('FileViewer', () => {
  it('renders nothing while path is null', () => {
    const { container } = render(
      <FileViewer path={null} readFile={vi.fn()} openPath={vi.fn()} onClose={vi.fn()} t={t} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders rendered Markdown for a .md file', async () => {
    render(
      <FileViewer
        path="/ws/README.md"
        readFile={readFileOnce({ kind: 'text', content: '# Title\n\nBody text.', version: 'test-version' as WorkspaceFileVersion })}
        openPath={vi.fn()}
        onClose={vi.fn()}
        t={t}
      />,
    )
    await screen.findByRole('heading', { name: 'Title' })
    expect(screen.getByText('Body text.')).not.toBeNull()
  })

  it('renders a line-numbered code view for a text/code file', async () => {
    render(
      <FileViewer
        path="/ws/index.ts"
        readFile={readFileOnce({ kind: 'text', content: 'const a = 1\nconst b = 2', version: 'test-version' as WorkspaceFileVersion })}
        openPath={vi.fn()}
        onClose={vi.fn()}
        t={t}
      />,
    )
    // Shiki highlighting splits each line into per-token spans, so the two
    // gutter-numbered lines (not one contiguous text node) are the reliable signal.
    await waitFor(() => { expect(screen.getAllByText('1', { selector: '[class*="gutter"]' })).toHaveLength(1) })
    expect(screen.getAllByText('2', { selector: '[class*="gutter"]' })).toHaveLength(1)
    expect(screen.getByRole('dialog').textContent).toContain('const')
  })

  it('renders an inline image from binary content', async () => {
    const restoreBlob = stubBlobUrl()
    try {
      render(
        <FileViewer
          path="/ws/pixel.png"
          readFile={readFileOnce({ kind: 'binary', mediaType: 'image/png', data: 'AAAA' })}
          openPath={vi.fn()}
          onClose={vi.fn()}
          t={t}
        />,
      )
      const img = await screen.findByRole('img', { name: 'pixel.png' })
      expect(img.getAttribute('src')).toMatch(/^blob:/)
    } finally {
      restoreBlob()
    }
  })

  it('offers only the external-open action for a PDF (no content fetch)', () => {
    const readFile = vi.fn()
    render(
      <FileViewer path="/ws/doc.pdf" readFile={readFile} openPath={vi.fn()} onClose={vi.fn()} t={t} />,
    )
    expect(readFile).not.toHaveBeenCalled()
    expect(footerButton(t('files.viewer.openExternally'))).not.toBeNull()
  })

  it('falls back to the external action when the read fails with file-too-large, showing the bound', async () => {
    const rpcError: RpcError = { code: 'file-too-large', message: 'too big', details: { path: '/ws/big.txt', maxBytes: 20 * 1024 * 1024 } }
    render(
      <FileViewer
        path="/ws/big.txt"
        readFile={() => Promise.reject(new WorkspaceFileBrowseError(rpcError))}
        openPath={vi.fn()}
        onClose={vi.fn()}
        t={t}
      />,
    )
    await screen.findByText(t('files.viewer.tooLarge', { maxMB: 20 }))
    expect(footerButton(t('files.viewer.openExternally'))).not.toBeNull()
  })

  it('falls back to the external action on a generic read failure', async () => {
    render(
      <FileViewer
        path="/ws/notes.txt"
        readFile={() => Promise.reject(new Error('boom'))}
        openPath={vi.fn()}
        onClose={vi.fn()}
        t={t}
      />,
    )
    await screen.findByRole('alert')
    expect(footerButton(t('files.viewer.openExternally'))).not.toBeNull()
  })

  it('falls back to the external action when a classified text file actually decodes as binary', async () => {
    render(
      <FileViewer
        path="/ws/mislabeled.txt"
        readFile={readFileOnce({ kind: 'binary', mediaType: 'application/octet-stream', data: 'AAAA' })}
        openPath={vi.fn()}
        onClose={vi.fn()}
        t={t}
      />,
    )
    await screen.findByRole('alert')
    expect(footerButton(t('files.viewer.openExternally'))).not.toBeNull()
  })

  it('opens the file externally and closes the dialog when the external action is used', async () => {
    const openPath = vi.fn(async () => {})
    const onClose = vi.fn()
    render(
      <FileViewer path="/ws/doc.pdf" readFile={vi.fn()} openPath={openPath} onClose={onClose} t={t} />,
    )
    await act(async () => {
      footerButton(t('files.viewer.openExternally')).click()
    })
    expect(openPath).toHaveBeenCalledWith('/ws/doc.pdf')
    expect(onClose).toHaveBeenCalled()
  })

  it('copies text content to the clipboard from the footer action', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(
      <FileViewer
        path="/ws/notes.txt"
        readFile={readFileOnce({ kind: 'text', content: 'hello world', version: 'test-version' as WorkspaceFileVersion })}
        openPath={vi.fn()}
        onClose={vi.fn()}
        t={t}
      />,
    )
    await screen.findByText('hello world')
    await act(async () => { footerButton(t('files.viewer.copy')).click() })
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith('hello world') })
  })

  it('shows the whole path as the title when the path has no separator', async () => {
    render(
      <FileViewer
        path="justaname.txt"
        readFile={readFileOnce({ kind: 'text', content: 'x', version: 'test-version' as WorkspaceFileVersion })}
        openPath={vi.fn()}
        onClose={vi.fn()}
        t={t}
      />,
    )
    await screen.findByRole('heading', { name: 'justaname.txt' })
  })

  it('falls back to the whole path as the title when it ends with a separator (empty basename)', () => {
    render(
      <FileViewer path="/ws/trailing/" readFile={vi.fn()} openPath={vi.fn()} onClose={vi.fn()} t={t} />,
    )
    expect(screen.getByRole('heading', { name: '/ws/trailing/' })).not.toBeNull()
  })

  it('renders an empty text file (no lines) without error', async () => {
    render(
      <FileViewer
        path="/ws/empty.txt"
        readFile={readFileOnce({ kind: 'text', content: '', version: 'test-version' as WorkspaceFileVersion })}
        openPath={vi.fn()}
        onClose={vi.fn()}
        t={t}
      />,
    )
    await waitFor(() => { expect(screen.queryByText(t('files.viewer.loading'))).toBeNull() })
  })

  it('trims exactly one trailing newline without a phantom empty final line', async () => {
    render(
      <FileViewer
        path="/ws/single.txt"
        readFile={readFileOnce({ kind: 'text', content: 'only line\n', version: 'test-version' as WorkspaceFileVersion })}
        openPath={vi.fn()}
        onClose={vi.fn()}
        t={t}
      />,
    )
    await waitFor(() => { expect(screen.getAllByText('1', { selector: '[class*="gutter"]' })).toHaveLength(1) })
    expect(screen.queryByText('2', { selector: '[class*="gutter"]' })).toBeNull()
  })

  it('ignores a settled read after the path changed away (superseded fetch)', async () => {
    let resolveFirst: ((content: WorkspaceFileContent) => void) | undefined
    const readFile = vi.fn((path: string) => {
      if (path === '/ws/first.txt') return new Promise<WorkspaceFileContent>((resolve) => { resolveFirst = resolve })
      return Promise.resolve({ kind: 'text' as const, content: 'second', version: 'test-version' as WorkspaceFileVersion })
    })
    const { rerender } = render(
      <FileViewer path="/ws/first.txt" readFile={readFile} openPath={vi.fn()} onClose={vi.fn()} t={t} />,
    )
    rerender(
      <FileViewer path="/ws/second.txt" readFile={readFile} openPath={vi.fn()} onClose={vi.fn()} t={t} />,
    )
    await screen.findByText('second')
    // The first (now-superseded) fetch settling afterward must not clobber
    // the second file's already-rendered content.
    await act(async () => { resolveFirst?.({ kind: 'text', content: 'stale first', version: 'test-version' as WorkspaceFileVersion }) })
    expect(screen.getByText('second')).not.toBeNull()
    expect(screen.queryByText('stale first')).toBeNull()
  })

  it('ignores a rejection from a superseded fetch the same way', async () => {
    let rejectFirst: ((error: Error) => void) | undefined
    const readFile = vi.fn((path: string) => {
      if (path === '/ws/first.txt') return new Promise<WorkspaceFileContent>((_resolve, reject) => { rejectFirst = reject })
      return Promise.resolve({ kind: 'text' as const, content: 'second', version: 'test-version' as WorkspaceFileVersion })
    })
    const { rerender } = render(
      <FileViewer path="/ws/first.txt" readFile={readFile} openPath={vi.fn()} onClose={vi.fn()} t={t} />,
    )
    rerender(
      <FileViewer path="/ws/second.txt" readFile={readFile} openPath={vi.fn()} onClose={vi.fn()} t={t} />,
    )
    await screen.findByText('second')
    await act(async () => { rejectFirst?.(new Error('stale failure')) })
    expect(screen.getByText('second')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not flip to the copied state when the clipboard write is denied', async () => {
    const writeText = vi.fn(async () => { throw new Error('denied') })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(
      <FileViewer
        path="/ws/notes.txt"
        readFile={readFileOnce({ kind: 'text', content: 'hello', version: 'test-version' as WorkspaceFileVersion })}
        openPath={vi.fn()}
        onClose={vi.fn()}
        t={t}
      />,
    )
    await screen.findByText('hello')
    await act(async () => { footerButton(t('files.viewer.copy')).click() })
    await waitFor(() => { expect(writeText).toHaveBeenCalled() })
    expect(footerButton(t('files.viewer.copy'))).not.toBeNull()
  })

  it('resets the copied state back to the copy label after the display window elapses', async () => {
    vi.useFakeTimers()
    try {
      const writeText = vi.fn(async () => {})
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      render(
        <FileViewer
          path="/ws/notes.txt"
          readFile={readFileOnce({ kind: 'text', content: 'hello', version: 'test-version' as WorkspaceFileVersion })}
          openPath={vi.fn()}
          onClose={vi.fn()}
          t={t}
        />,
      )
      await vi.waitFor(() => { screen.getByText('hello') })
      await act(async () => { footerButton(t('files.viewer.copy')).click() })
      await vi.waitFor(() => { expect(footerButton(t('files.viewer.copied'))).not.toBeNull() })
      await act(async () => { vi.advanceTimersByTime(1000) })
      expect(footerButton(t('files.viewer.copy'))).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a second click of the copy action while the copied state is still shown', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(
      <FileViewer
        path="/ws/notes.txt"
        readFile={readFileOnce({ kind: 'text', content: 'hello', version: 'test-version' as WorkspaceFileVersion })}
        openPath={vi.fn()}
        onClose={vi.fn()}
        t={t}
      />,
    )
    await screen.findByText('hello')
    await act(async () => { footerButton(t('files.viewer.copy')).click() })
    await waitFor(() => { expect(writeText).toHaveBeenCalledTimes(1) })
    // The button now shows the copied label; a second click while `copied`
    // is still true hits onCopy's early return, so no second write happens.
    await act(async () => { footerButton(t('files.viewer.copied')).click() })
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('shows a loading placeholder for an image while its blob URL is not yet ready', () => {
    const restoreBlob = stubBlobUrl()
    try {
      // A pending readFile promise keeps the viewer in its loading phase, so
      // the image branch's own `imageUrl === null` loading arm renders.
      render(
        <FileViewer path="/ws/pixel.png" readFile={() => new Promise(() => {})} openPath={vi.fn()} onClose={vi.fn()} t={t} />,
      )
      expect(screen.getByText(t('files.viewer.loading'))).not.toBeNull()
    } finally {
      restoreBlob()
    }
  })

  it('calls onClose when the dialog close control is used', async () => {
    const onClose = vi.fn()
    render(
      <FileViewer
        path="/ws/notes.txt"
        readFile={readFileOnce({ kind: 'text', content: 'x', version: 'test-version' as WorkspaceFileVersion })}
        openPath={vi.fn()}
        onClose={onClose}
        t={t}
      />,
    )
    await screen.findByText('x')
    screen.getByRole('button', { name: t('files.viewer.close') }).click()
    expect(onClose).toHaveBeenCalled()
  })
})
