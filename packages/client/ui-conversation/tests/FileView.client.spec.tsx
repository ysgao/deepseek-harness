// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  createSnapshotStore, EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS, WorkspaceFileBrowseError,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSnapshot, RpcError, SessionId, SessionListState, WorkspaceFileContent, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { FileView } from '../src/client/files/FileView.tsx'
import type { FileViewProps } from '../src/client/files/FileView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh)
const SID = 's1' as SessionId

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }))
}
function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  }))
}
function fakeSession() {
  const store = createSnapshotStore<ConversationSnapshot>({
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false,
    promptError: null, blank: false, subagent: null, lastAgentError: null,
  })
  return bindSnapshotSelector(store)
}

function readFileOnce(content: WorkspaceFileContent): (path: string, signal?: AbortSignal) => Promise<WorkspaceFileContent> {
  return () => Promise.resolve(content)
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
    sessionId: SID,
    useSession: fakeSession(),
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useProjection: (() => undefined) as never,
    openFilePath: null,
    onFileOpened: vi.fn(),
    readFile: vi.fn(),
    openPath: vi.fn(async () => {}),
    t,
    ...overrides,
  } as unknown as FileViewProps
}

describe('FileView', () => {
  it('shows the resting empty-state notice while no path has ever been opened', () => {
    render(<FileView {...baseProps()} />)
    expect(screen.getByText(t('files.empty'))).not.toBeNull()
  })

  it('acknowledges the one-shot openFilePath handoff and fetches the file', async () => {
    const onFileOpened = vi.fn()
    const readFile = vi.fn(readFileOnce({ kind: 'text', content: 'hello' }))
    render(<FileView {...baseProps({ openFilePath: '/ws/notes.txt', onFileOpened, readFile })} />)
    expect(onFileOpened).toHaveBeenCalled()
    await screen.findByText('hello')
    expect(readFile).toHaveBeenCalledWith('/ws/notes.txt', expect.anything())
    // The header path span and ReadBlock's own banner label both show the
    // path — assert at least one instance renders rather than picking one.
    expect(screen.getAllByText('/ws/notes.txt').length).toBeGreaterThan(0)
  })

  it('renders rendered Markdown for a .md path', async () => {
    render(
      <FileView
        {...baseProps({
          openFilePath: '/ws/README.md',
          readFile: readFileOnce({ kind: 'text', content: '# Title\n\nBody.' }),
        })}
      />,
    )
    await screen.findByRole('heading', { name: 'Title' })
  })

  it('offers only the external-open action for an unrecognized extension (no fetch)', () => {
    const readFile = vi.fn()
    render(<FileView {...baseProps({ openFilePath: '/ws/doc.pdf', readFile })} />)
    expect(readFile).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: t('files.viewer.openExternally') })).not.toBeNull()
  })

  it('calls openPath with the opened path from the external action', async () => {
    const openPath = vi.fn(async () => {})
    render(<FileView {...baseProps({ openFilePath: '/ws/doc.pdf', openPath })} />)
    await act(async () => {
      screen.getByRole('button', { name: t('files.viewer.openExternally') }).click()
    })
    expect(openPath).toHaveBeenCalledWith('/ws/doc.pdf')
  })

  it('falls back to the external action when the read fails with file-too-large', async () => {
    const rpcError: RpcError = { code: 'file-too-large', message: 'too big', details: { path: '/ws/big.txt', maxBytes: 20 * 1024 * 1024 } }
    render(
      <FileView
        {...baseProps({
          openFilePath: '/ws/big.txt',
          readFile: () => Promise.reject(new WorkspaceFileBrowseError(rpcError)),
        })}
      />,
    )
    await screen.findByText(t('files.viewer.tooLarge', { maxMB: 20 }))
    expect(screen.getByRole('button', { name: t('files.viewer.openExternally') })).not.toBeNull()
  })

  it('falls back to the external action on a generic read failure', async () => {
    render(
      <FileView {...baseProps({ openFilePath: '/ws/notes.txt', readFile: () => Promise.reject(new Error('boom')) })} />,
    )
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: t('files.viewer.openExternally') })).not.toBeNull()
  })

  it('falls back to the external action when a classified text file actually decodes as binary', async () => {
    render(
      <FileView
        {...baseProps({
          openFilePath: '/ws/mislabeled.txt',
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
            openFilePath: '/ws/pixel.png',
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

  it('re-fetches on a new openFilePath after the first file is showing', async () => {
    const readFile = vi.fn((path: string) => Promise.resolve({ kind: 'text' as const, content: `content of ${path}` }))
    const { rerender } = render(<FileView {...baseProps({ openFilePath: '/ws/one.txt', readFile })} />)
    await screen.findByText('content of /ws/one.txt')
    rerender(<FileView {...baseProps({ openFilePath: '/ws/two.txt', readFile })} />)
    await waitFor(() => { expect(screen.getByText('content of /ws/two.txt')).not.toBeNull() })
  })
})
