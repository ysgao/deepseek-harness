// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { WorkspaceFileBrowseError } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceFileContent, WorkspaceFileVersion } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { ConversationViewRequest } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { FileView } from '../src/client/files/FileView.tsx'
import type { FileViewProps } from '../src/client/files/FileView.tsx'

afterEach(cleanup)

// FileEditor mounts a real CodeMirror 6 EditorView; jsdom lacks these two
// measurement constructors entirely (see file-editor.client.spec.tsx in
// ui-primitives for the same stub and its rationale).
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
afterEach(() => { vi.unstubAllGlobals() })

const t = makeTranslate(zh)

/**
 * A one-shot 'file' viewRequest addressed at `path`, as `conversationFileOpener`
 * would produce (JSON-encoded `focus` — see `OpenFileFocus` in FileView.tsx).
 * `workspaceId` defaults absent, matching a requester with no workspace of
 * its own (e.g. a chat-message file mention).
 */
function fileRequest(path: string, workspaceId?: WorkspaceId): ConversationViewRequest {
  return { view: 'file', focus: JSON.stringify({ path, workspaceId }) }
}

function readFileOnce(
  content: WorkspaceFileContent,
): (workspaceId: WorkspaceId | undefined, path: string, signal?: AbortSignal) => Promise<WorkspaceFileContent> {
  return () => Promise.resolve(content)
}

/** Default double: no owning workspace has any pending git change, so the Diff toggle never shows. */
function noGitStatus() {
  return vi.fn(async () => ({ isRepo: false, branch: null, files: {} }))
}

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

function baseProps(overrides: Partial<FileViewProps> = {}): FileViewProps {
  return {
    viewRequest: null,
    openView: vi.fn(),
    completeViewRequest: vi.fn(),
    readFile: vi.fn(),
    openPath: vi.fn(async () => {}),
    getGitStatus: noGitStatus(),
    getFileDiff: vi.fn(async () => ({ oldText: null, newText: null })),
    writeFile: vi.fn(async () => 'test-version' as WorkspaceFileVersion),
    t,
    ...overrides,
  } as unknown as FileViewProps
}

describe('FileView', () => {
  it('shows the resting empty-state notice while no path has ever been opened', () => {
    render(<FileView {...baseProps()} />)
    expect(screen.getByText(t('files.empty'))).not.toBeNull()
  })

  it('acknowledges the one-shot viewRequest handoff and fetches the file', async () => {
    const completeViewRequest = vi.fn()
    const readFile = vi.fn(readFileOnce({ kind: 'text', content: 'hello', version: 'test-version' as WorkspaceFileVersion }))
    render(<FileView {...baseProps({ viewRequest: fileRequest('/ws/notes.txt'), completeViewRequest, readFile })} />)
    expect(completeViewRequest).toHaveBeenCalled()
    await screen.findByText('hello')
    expect(readFile).toHaveBeenCalledWith(undefined, '/ws/notes.txt', expect.anything())
  })

  it('passes the focus payload\'s own workspaceId through to every call, not a session-derived one', async () => {
    const workspaceId = 'ws-explicit' as WorkspaceId
    const readFile = vi.fn(readFileOnce({ kind: 'text', content: 'hello', version: 'test-version' as WorkspaceFileVersion }))
    render(<FileView {...baseProps({ viewRequest: fileRequest('/ws/notes.txt', workspaceId), readFile })} />)
    await screen.findByText('hello')
    expect(readFile).toHaveBeenCalledWith(workspaceId, '/ws/notes.txt', expect.anything())
    // The header path span and ReadBlock's own banner label both show the
    // path — assert at least one instance renders rather than picking one.
    expect(screen.getAllByText('/ws/notes.txt').length).toBeGreaterThan(0)
  })

  it('renders rendered Markdown for a .md path', async () => {
    render(
      <FileView
        {...baseProps({
          viewRequest: fileRequest('/ws/README.md'),
          readFile: readFileOnce({ kind: 'text', content: '# Title\n\nBody.', version: 'test-version' as WorkspaceFileVersion }),
        })}
      />,
    )
    await screen.findByRole('heading', { name: 'Title' })
  })

  it('offers only the external-open action for an unrecognized extension (no fetch)', () => {
    const readFile = vi.fn()
    render(<FileView {...baseProps({ viewRequest: fileRequest('/ws/doc.pdf'), readFile })} />)
    expect(readFile).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: t('files.viewer.openExternally') })).not.toBeNull()
  })

  it('calls openPath with the opened path from the external action', async () => {
    const openPath = vi.fn(async () => {})
    render(<FileView {...baseProps({ viewRequest: fileRequest('/ws/doc.pdf'), openPath })} />)
    await act(async () => {
      screen.getByRole('button', { name: t('files.viewer.openExternally') }).click()
    })
    expect(openPath).toHaveBeenCalledWith('/ws/doc.pdf')
  })

  it('falls back to the external action when the read fails with file-too-large', async () => {
    const rpcError: RemoteFailure = { code: 'file-too-large', message: 'too big', details: { path: '/ws/big.txt', maxBytes: 20 * 1024 * 1024 } }
    render(
      <FileView
        {...baseProps({
          viewRequest: fileRequest('/ws/big.txt'),
          readFile: () => Promise.reject(new WorkspaceFileBrowseError('read file', rpcError)),
        })}
      />,
    )
    await screen.findByText(t('files.viewer.tooLarge', { maxMB: 20 }))
    expect(screen.getByRole('button', { name: t('files.viewer.openExternally') })).not.toBeNull()
  })

  it('falls back to the external action on a generic read failure', async () => {
    render(
      <FileView {...baseProps({ viewRequest: fileRequest('/ws/notes.txt'), readFile: () => Promise.reject(new Error('boom')) })} />,
    )
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: t('files.viewer.openExternally') })).not.toBeNull()
  })

  it('falls back to the external action when a classified text file actually decodes as binary', async () => {
    render(
      <FileView
        {...baseProps({
          viewRequest: fileRequest('/ws/mislabeled.txt'),
          readFile: readFileOnce({ kind: 'binary', mediaType: 'application/octet-stream', data: 'AAAA' }),
        })}
      />,
    )
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: t('files.viewer.openExternally') })).not.toBeNull()
  })

  it('renders an inline image from binary content, alt defaulting to the path', async () => {
    const restoreBlob = stubBlobUrl()
    try {
      render(
        <FileView
          {...baseProps({
            viewRequest: fileRequest('/ws/pixel.png'),
            readFile: readFileOnce({ kind: 'binary', mediaType: 'image/png', data: 'AAAA' }),
          })}
        />,
      )
      const img = await screen.findByRole('img', { name: '/ws/pixel.png' })
      expect(img.getAttribute('src')).toMatch(/^blob:/)
    } finally {
      restoreBlob()
    }
  })

  it('re-fetches on a new viewRequest after the first file is showing', async () => {
    const readFile = vi.fn((_workspaceId: WorkspaceId | undefined, path: string) => Promise.resolve({
      kind: 'text' as const, content: `content of ${path}`, version: 'test-version' as WorkspaceFileVersion,
    }))
    const { rerender } = render(<FileView {...baseProps({ viewRequest: fileRequest('/ws/one.txt'), readFile })} />)
    await screen.findByText('content of /ws/one.txt')
    rerender(<FileView {...baseProps({ viewRequest: fileRequest('/ws/two.txt'), readFile })} />)
    await waitFor(() => { expect(screen.getByText('content of /ws/two.txt')).not.toBeNull() })
  })

  it('offers no Diff toggle for a clean tracked file', async () => {
    render(
      <FileView
        {...baseProps({
          viewRequest: fileRequest('/ws/clean.txt'),
          readFile: readFileOnce({ kind: 'text', content: 'clean', version: 'test-version' as WorkspaceFileVersion }),
        })}
      />,
    )
    await screen.findByText('clean')
    expect(screen.queryByRole('button', { name: t('files.diff.diff') })).toBeNull()
  })

  it('shows a Diff toggle for a changed text file and renders the side-by-side diff on switch', async () => {
    const getGitStatus = vi.fn(async () => ({ isRepo: true, branch: 'main', files: { '/ws/changed.txt': 'M' } }))
    const getFileDiff = vi.fn(async () => ({ oldText: 'old line', newText: 'new line' }))
    render(
      <FileView
        {...baseProps({
          viewRequest: fileRequest('/ws/changed.txt'),
          readFile: readFileOnce({ kind: 'text', content: 'new line', version: 'test-version' as WorkspaceFileVersion }),
          getGitStatus,
          getFileDiff,
        })}
      />,
    )
    const diffToggle = await screen.findByRole('button', { name: t('files.diff.diff') })
    await act(async () => { diffToggle.click() })
    expect(getFileDiff).toHaveBeenCalledWith(undefined, '/ws/changed.txt', expect.anything())
    await screen.findByText('old line')
    await screen.findByText('new line')
  })

  it('shows the empty-diff notice when the fetched diff sides are identical', async () => {
    const getGitStatus = vi.fn(async () => ({ isRepo: true, branch: 'main', files: { '/ws/same.txt': 'M' } }))
    const getFileDiff = vi.fn(async () => ({ oldText: 'same', newText: 'same' }))
    render(
      <FileView
        {...baseProps({
          viewRequest: fileRequest('/ws/same.txt'),
          readFile: readFileOnce({ kind: 'text', content: 'same', version: 'test-version' as WorkspaceFileVersion }),
          getGitStatus,
          getFileDiff,
        })}
      />,
    )
    const diffToggle = await screen.findByRole('button', { name: t('files.diff.diff') })
    await act(async () => { diffToggle.click() })
    await screen.findByText(t('files.diff.empty'))
  })
})

/** Simulate typed input the way CodeMirror's own paste handler reads it — jsdom fires no native text-insertion events. */
function pasteInto(content: Element, text: string): void {
  fireEvent.paste(content, { clipboardData: { getData: () => text } })
}

describe('FileView editing', () => {
  it('offers an Edit toggle for a text file and shows its content in the editor', async () => {
    render(
      <FileView
        {...baseProps({
          viewRequest: fileRequest('/ws/notes.txt'),
          readFile: readFileOnce({ kind: 'text', content: 'hello', version: 'v1' as WorkspaceFileVersion }),
        })}
      />,
    )
    await screen.findByText('hello')
    const editToggle = await screen.findByRole('button', { name: t('files.edit.edit') })
    await act(async () => { editToggle.click() })
    expect(document.querySelector('.cm-content')?.textContent).toBe('hello')
  })

  it('enables Save and shows the unsaved indicator once the buffer is edited', async () => {
    render(
      <FileView
        {...baseProps({
          viewRequest: fileRequest('/ws/notes.txt'),
          readFile: readFileOnce({ kind: 'text', content: 'hello', version: 'v1' as WorkspaceFileVersion }),
        })}
      />,
    )
    await screen.findByText('hello')
    await act(async () => { (await screen.findByRole('button', { name: t('files.edit.edit') })).click() })
    const saveButton = await screen.findByRole('button', { name: t('files.edit.save') })
    expect(saveButton.hasAttribute('disabled')).toBe(true)

    const content = document.querySelector('.cm-content')
    if (content === null) throw new Error('unreachable')
    await act(async () => { pasteInto(content, '!') })
    expect(saveButton.hasAttribute('disabled')).toBe(false)
  })

  it('saves the edited buffer through writeFile with the read version, then clears the unsaved state', async () => {
    const writeFile = vi.fn(async () => 'v2' as WorkspaceFileVersion)
    render(
      <FileView
        {...baseProps({
          viewRequest: fileRequest('/ws/notes.txt'),
          readFile: readFileOnce({ kind: 'text', content: 'hello', version: 'v1' as WorkspaceFileVersion }),
          writeFile,
        })}
      />,
    )
    await screen.findByText('hello')
    await act(async () => { (await screen.findByRole('button', { name: t('files.edit.edit') })).click() })
    const content = document.querySelector('.cm-content')
    if (content === null) throw new Error('unreachable')
    await act(async () => { pasteInto(content, '!') })
    const saveButton = await screen.findByRole('button', { name: t('files.edit.save') })
    await act(async () => { saveButton.click() })

    expect(writeFile).toHaveBeenCalledWith(undefined, '/ws/notes.txt', expect.stringContaining('hello'), 'v1')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: t('files.edit.save') }).hasAttribute('disabled')).toBe(true)
    })
  })

  it('shows a conflict notice with a reload action when the save is rejected as file-changed', async () => {
    const rpcError: RemoteFailure = { code: 'file-changed', message: 'changed', details: { path: '/ws/notes.txt' } }
    const writeFile = vi.fn(async () => { throw new WorkspaceFileBrowseError('write file', rpcError) })
    const readFile = vi.fn(readFileOnce({ kind: 'text', content: 'hello', version: 'v1' as WorkspaceFileVersion }))
    render(
      <FileView
        {...baseProps({ viewRequest: fileRequest('/ws/notes.txt'), readFile, writeFile })}
      />,
    )
    await screen.findByText('hello')
    await act(async () => { (await screen.findByRole('button', { name: t('files.edit.edit') })).click() })
    const content = document.querySelector('.cm-content')
    if (content === null) throw new Error('unreachable')
    await act(async () => { pasteInto(content, '!') })
    await act(async () => { (await screen.findByRole('button', { name: t('files.edit.save') })).click() })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('files.edit.conflict'))

    const reload = screen.getByRole('button', { name: t('files.edit.reload') })
    await act(async () => { reload.click() })
    // Reload discards the draft, re-fetches, and returns to View mode.
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: t('files.edit.save') })).toBeNull()
  })

  it('keeps an unsaved draft when switching to View and back to Edit', async () => {
    render(
      <FileView
        {...baseProps({
          viewRequest: fileRequest('/ws/notes.txt'),
          readFile: readFileOnce({ kind: 'text', content: 'hello', version: 'v1' as WorkspaceFileVersion }),
        })}
      />,
    )
    await screen.findByText('hello')
    await act(async () => { (await screen.findByRole('button', { name: t('files.edit.edit') })).click() })
    const content = document.querySelector('.cm-content')
    if (content === null) throw new Error('unreachable')
    await act(async () => { pasteInto(content, '!') })

    await act(async () => { (await screen.findByRole('button', { name: t('files.diff.view') })).click() })
    await act(async () => { (await screen.findByRole('button', { name: t('files.edit.edit') })).click() })
    expect(document.querySelector('.cm-content')?.textContent).toContain('!')
  })
})
