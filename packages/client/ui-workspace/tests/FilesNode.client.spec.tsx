// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  SessionId, WorkspaceEntryListing, WorkspaceFileContent, WorkspaceFileVersion, WorkspaceGitStatus, WorkspaceId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { FilesNode } from '../src/client/files/FilesNode.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh)
const wsId = 'ws-1' as WorkspaceId

/** No-repo default for tests that don't exercise the git status display. */
const noGitStatus = (): Promise<WorkspaceGitStatus> => Promise.resolve({ isRepo: false, branch: null, files: {} })

/** A tiny fixed two-level tree keyed by directory path, mirroring the fixture's own shape. */
function treeListWorkspaceEntries(tree: Record<string, WorkspaceEntryListing['entries']>) {
  return vi.fn((_workspaceId: WorkspaceId, path: string): Promise<WorkspaceEntryListing> => {
    const entries = tree[path]
    if (entries === undefined) return Promise.reject(new Error(`no fixture level for ${path}`))
    return Promise.resolve({ path, entries, truncated: false })
  })
}

describe('FilesNode', () => {
  it('renders the header row collapsed and lists nothing until expanded', () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    expect(screen.getByText(t('files.label'))).not.toBeNull()
    expect(listWorkspaceEntries).not.toHaveBeenCalled()
  })

  it('fetches and shows the root level on expand, directories before files', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({
      '/ws': [
        { name: 'src', path: '/ws/src', type: 'directory', hidden: false },
        { name: 'README.md', path: '/ws/README.md', type: 'file', hidden: false },
      ],
    })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    await screen.findByText('src')
    expect(screen.getByText('README.md')).not.toBeNull()
    expect(listWorkspaceEntries).toHaveBeenCalledWith(wsId, '/ws', expect.anything())
  })

  it('shows the empty-folder notice for a level with no entries', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    await screen.findByText(t('files.empty'))
  })

  it('shows the truncated notice when the level reports truncated: true', async () => {
    const listWorkspaceEntries = vi.fn(() => Promise.resolve({
      path: '/ws', entries: [{ name: 'a.txt', path: '/ws/a.txt', type: 'file' as const, hidden: false }], truncated: true,
    }))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    await screen.findByText(t('files.truncated'))
  })

  it('shows the error notice when a level fails to load', async () => {
    const listWorkspaceEntries = vi.fn(() => Promise.reject(new Error('denied')))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    await screen.findByText(t('files.loadError'))
  })

  it('expands a directory row in place, fetching its own level lazily', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({
      '/ws': [{ name: 'src', path: '/ws/src', type: 'directory', hidden: false }],
      '/ws/src': [{ name: 'index.ts', path: '/ws/src/index.ts', type: 'file', hidden: false }],
    })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    const dirRow = await screen.findByText('src')
    expect(listWorkspaceEntries).not.toHaveBeenCalledWith(wsId, '/ws/src', expect.anything())
    await act(async () => { dirRow.click() })
    await screen.findByText('index.ts')
    expect(listWorkspaceEntries).toHaveBeenCalledWith(wsId, '/ws/src', expect.anything())
  })

  it('opens the in-app preview for a clicked file row', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({
      '/ws': [{ name: 'notes.txt', path: '/ws/notes.txt', type: 'file', hidden: false }],
    })
    const readWorkspaceFile = vi.fn((_workspaceId: WorkspaceId, path: string): Promise<WorkspaceFileContent> =>
      Promise.resolve({ kind: 'text', content: `content of ${path}`, version: 'test-version' as WorkspaceFileVersion }))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={readWorkspaceFile}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    const fileRow = await screen.findByText('notes.txt')
    await act(async () => { fileRow.click() })
    await waitFor(() => { expect(readWorkspaceFile).toHaveBeenCalledWith(wsId, '/ws/notes.txt', expect.anything()) })
    await screen.findByText('content of /ws/notes.txt')
  })

  it('opens a clicked file in the current session\'s File tab instead of the in-app preview, when the opener accepts it', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({
      '/ws': [{ name: 'notes.txt', path: '/ws/notes.txt', type: 'file', hidden: false }],
    })
    const readWorkspaceFile = vi.fn((): Promise<WorkspaceFileContent> => Promise.resolve({ kind: 'text', content: 'body', version: 'test-version' as WorkspaceFileVersion }))
    const sessionId = 'sess-1' as SessionId
    const openFileInSession = vi.fn(() => true)
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={readWorkspaceFile}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={sessionId}
        openFileInSession={openFileInSession}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    const fileRow = await screen.findByText('notes.txt')
    await act(async () => { fileRow.click() })
    expect(openFileInSession).toHaveBeenCalledWith(sessionId, '/ws/notes.txt')
    expect(readWorkspaceFile).not.toHaveBeenCalled()
    expect(screen.queryByText('body')).toBeNull()
  })

  it('falls back to the in-app preview when the current session rejects the File-tab open', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({
      '/ws': [{ name: 'notes.txt', path: '/ws/notes.txt', type: 'file', hidden: false }],
    })
    const readWorkspaceFile = vi.fn((): Promise<WorkspaceFileContent> => Promise.resolve({ kind: 'text', content: 'body', version: 'test-version' as WorkspaceFileVersion }))
    const sessionId = 'sess-1' as SessionId
    const openFileInSession = vi.fn(() => false)
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={readWorkspaceFile}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={sessionId}
        openFileInSession={openFileInSession}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    const fileRow = await screen.findByText('notes.txt')
    await act(async () => { fileRow.click() })
    expect(openFileInSession).toHaveBeenCalledWith(sessionId, '/ws/notes.txt')
    await screen.findByText('body')
  })

  it('ignores a level settling after the header collapsed again (superseded fetch)', async () => {
    let resolveLevel: ((listing: WorkspaceEntryListing) => void) | undefined
    const listWorkspaceEntries = vi.fn(() => new Promise<WorkspaceEntryListing>((resolve) => { resolveLevel = resolve }))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    const header = screen.getByText(t('files.label'))
    await act(async () => { header.click() })
    // Collapse before the in-flight fetch settles.
    await act(async () => { header.click() })
    await act(async () => { resolveLevel?.({ path: '/ws', entries: [{ name: 'late.txt', path: '/ws/late.txt', type: 'file', hidden: false }], truncated: false }) })
    // The collapsed tree renders no level at all, so the stale settlement's
    // row must not appear.
    expect(screen.queryByText('late.txt')).toBeNull()
  })

  it('ignores a level failing after the header collapsed again (superseded fetch)', async () => {
    let rejectLevel: ((error: Error) => void) | undefined
    const listWorkspaceEntries = vi.fn(() => new Promise<WorkspaceEntryListing>((_resolve, reject) => { rejectLevel = reject }))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    const header = screen.getByText(t('files.label'))
    await act(async () => { header.click() })
    await act(async () => { header.click() })
    await act(async () => { rejectLevel?.(new Error('stale failure')) })
    expect(screen.queryByText(t('files.loadError'))).toBeNull()
  })

  it('closes the in-app preview through FileViewer\'s own close control', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({
      '/ws': [{ name: 'notes.txt', path: '/ws/notes.txt', type: 'file', hidden: false }],
    })
    const readWorkspaceFile = vi.fn((): Promise<WorkspaceFileContent> => Promise.resolve({ kind: 'text', content: 'body', version: 'test-version' as WorkspaceFileVersion }))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={readWorkspaceFile}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    const fileRow = await screen.findByText('notes.txt')
    await act(async () => { fileRow.click() })
    await screen.findByText('body')
    await act(async () => { screen.getByRole('button', { name: t('files.viewer.close') }).click() })
    expect(screen.queryByText('body')).toBeNull()
  })

  it('collapses the header row back and hides the level', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({
      '/ws': [{ name: 'a.txt', path: '/ws/a.txt', type: 'file', hidden: false }],
    })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    const header = screen.getByText(t('files.label'))
    await act(async () => { header.click() })
    await screen.findByText('a.txt')
    await act(async () => { header.click() })
    expect(screen.queryByText('a.txt')).toBeNull()
  })

  it('shows the current branch in the header for a workspace inside a git repository', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: {} }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await screen.findByText('main')
  })

  it('shows no branch display for a workspace outside any git working tree', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await waitFor(() => { expect(screen.queryByText('main')).toBeNull() })
    expect(screen.queryByTitle(t('files.git.refresh'))).toBeNull()
  })

  it('marks a changed file with its git status letter after the file name', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({
      '/ws': [
        { name: 'changed.txt', path: '/ws/changed.txt', type: 'file', hidden: false },
        { name: 'clean.txt', path: '/ws/clean.txt', type: 'file', hidden: false },
      ],
    })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({
          isRepo: true, branch: 'main', files: { '/ws/changed.txt': 'M' },
        }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    const changedRow = (await screen.findByText('changed.txt')).closest('button')
    const cleanRow = (await screen.findByText('clean.txt')).closest('button')
    expect(changedRow?.textContent).toContain('M')
    expect(cleanRow?.textContent).not.toContain('M')
  })

  it('omits the git status display when listWorkspaceGitStatus rejects', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.reject(new Error('denied')))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => {})
    expect(screen.queryByText('main')).toBeNull()
    expect(screen.queryByTitle(t('files.git.refresh'))).toBeNull()
  })

  it('ignores a git status settling after the node unmounts (superseded fetch)', async () => {
    let resolveStatus: ((status: WorkspaceGitStatus) => void) | undefined
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    const { unmount } = render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => new Promise<WorkspaceGitStatus>((resolve) => { resolveStatus = resolve }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    unmount()
    // Must not throw (a setState-after-unmount would surface as a React warning/error).
    await act(async () => { resolveStatus?.({ isRepo: true, branch: 'main', files: {} }) })
  })

  it('shows no title tooltip for an unrecognized git status code', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({
      '/ws': [{ name: 'changed.txt', path: '/ws/changed.txt', type: 'file', hidden: false }],
    })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({
          isRepo: true, branch: 'main', files: { '/ws/changed.txt': 'T' },
        }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    const badge = await screen.findByText('T')
    expect(badge.getAttribute('title')).toBeNull()
  })

  it('marks a directory row dirty when a descendant file has changed, even at an unexpanded deeper level', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({
      '/ws': [
        { name: 'src', path: '/ws/src', type: 'directory', hidden: false },
        { name: 'docs', path: '/ws/docs', type: 'directory', hidden: false },
      ],
      // '/ws/src' is never fetched in this test — the dot must reflect the
      // repo-wide status map alone, not a fetched listing.
    })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({
          isRepo: true, branch: 'main', files: { '/ws/src/deep/nested.ts': 'M' },
        }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    const srcRow = (await screen.findByText('src')).closest('button')
    const docsRow = (await screen.findByText('docs')).closest('button')
    expect(srcRow?.querySelector(`[title="${t('files.git.folderDirty')}"]`)).not.toBeNull()
    expect(docsRow?.querySelector(`[title="${t('files.git.folderDirty')}"]`)).toBeNull()
  })

  it('does not mark a directory dirty from a same-prefix sibling (foo vs foobar)', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({
      '/ws': [{ name: 'foo', path: '/ws/foo', type: 'directory', hidden: false }],
    })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({
          isRepo: true, branch: 'main', files: { '/ws/foobar/x.txt': 'M' },
        }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() })
    const fooRow = (await screen.findByText('foo')).closest('button')
    expect(fooRow?.querySelector(`[title="${t('files.git.folderDirty')}"]`)).toBeNull()
  })

  it('refetches git status when the explicit refresh control is clicked', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    const listWorkspaceGitStatus = vi.fn()
      .mockResolvedValueOnce({ isRepo: true, branch: 'main', files: {} })
      .mockResolvedValueOnce({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={listWorkspaceGitStatus}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await screen.findByText('main')
    expect(screen.queryByTitle(t('files.git.changedCount', { n: 1 }))).toBeNull()
    await act(async () => { screen.getByTitle(t('files.git.refresh')).click() })
    expect(listWorkspaceGitStatus).toHaveBeenCalledTimes(2)
    await waitFor(() => { expect(screen.queryByTitle(t('files.git.changedCount', { n: 1 }))).not.toBeNull() })
  })

  it('does not toggle the Files tree when the refresh control inside the header is clicked', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({
      '/ws': [{ name: 'a.txt', path: '/ws/a.txt', type: 'file', hidden: false }],
    })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: {} }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await screen.findByText('main')
    await act(async () => { screen.getByTitle(t('files.git.refresh')).click() })
    expect(screen.queryByText('a.txt')).toBeNull()
    expect(listWorkspaceEntries).not.toHaveBeenCalled()
  })

  it('refetches git status when the Files tree is collapsed and reopened', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    const listWorkspaceGitStatus = vi.fn()
      .mockResolvedValueOnce({ isRepo: true, branch: 'main', files: {} })
      .mockResolvedValueOnce({ isRepo: true, branch: 'feature-branch', files: {} })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={listWorkspaceGitStatus}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await screen.findByText('main')
    expect(listWorkspaceGitStatus).toHaveBeenCalledTimes(1)
    const header = screen.getByText(t('files.label'))
    await act(async () => { header.click() }) // expand: collapsed -> expanded, refetches
    expect(listWorkspaceGitStatus).toHaveBeenCalledTimes(2)
    await act(async () => { header.click() }) // collapse: no refetch
    expect(listWorkspaceGitStatus).toHaveBeenCalledTimes(2)
    await screen.findByText('feature-branch')
  })

  it('shows Commit and Discard controls only when there are pending changes', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    const { rerender } = render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: {} }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await screen.findByText('main')
    expect(screen.queryByTitle(t('files.git.commit'))).toBeNull()
    expect(screen.queryByTitle(t('files.git.discard'))).toBeNull()
    rerender(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByTitle(t('files.git.refresh')).click() })
    await screen.findByTitle(t('files.git.commit'))
    expect(screen.getByTitle(t('files.git.discard'))).not.toBeNull()
  })

  it('opens the inline commit input on Commit, and Cancel returns to the summary view', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    const commitButton = await screen.findByTitle(t('files.git.commit'))
    await act(async () => { commitButton.click() })
    const field = screen.getByPlaceholderText(t('files.git.commitPlaceholder'))
    expect(field).not.toBeNull()
    expect(screen.queryByTitle(t('files.git.commit'))).toBeNull()
    await act(async () => { screen.getByTitle(t('files.git.cancel')).click() })
    expect(screen.queryByPlaceholderText(t('files.git.commitPlaceholder'))).toBeNull()
    await screen.findByTitle(t('files.git.commit'))
  })

  it('disables the commit submit control until a message is entered', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    const commitButton = await screen.findByTitle(t('files.git.commit'))
    await act(async () => { commitButton.click() })
    const submit = screen.getByTitle(t('files.git.commitSubmit'))
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    const field = screen.getByPlaceholderText(t('files.git.commitPlaceholder'))
    act(() => { fireEvent.change(field, { target: { value: 'fix things' } }) })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
  })

  it('submits the commit message, refreshing git status and the directory listing on success', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    const listWorkspaceGitStatus = vi.fn()
      .mockResolvedValueOnce({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }) // initial mount
      .mockResolvedValueOnce({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }) // expand-triggered refresh
      .mockResolvedValueOnce({ isRepo: true, branch: 'main', files: {} }) // post-commit refresh
    const commitAllChanges = vi.fn(async () => {})
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={commitAllChanges}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={listWorkspaceGitStatus}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() }) // expand: fetches listing once
    const commitButton = await screen.findByTitle(t('files.git.commit'))
    await act(async () => { commitButton.click() })
    const field = screen.getByPlaceholderText(t('files.git.commitPlaceholder'))
    act(() => { fireEvent.change(field, { target: { value: 'fix things' } }) })
    await act(async () => { screen.getByTitle(t('files.git.commitSubmit')).click() })
    expect(commitAllChanges).toHaveBeenCalledWith(wsId, 'fix things')
    await waitFor(() => { expect(screen.queryByPlaceholderText(t('files.git.commitPlaceholder'))).toBeNull() })
    await waitFor(() => { expect(listWorkspaceGitStatus).toHaveBeenCalledTimes(3) })
    // The level remounted (new key), so its own fetch fired again.
    await waitFor(() => { expect(listWorkspaceEntries).toHaveBeenCalledTimes(2) })
  })

  it('shows an error and stays in commit mode when the commit fails', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    const commitAllChanges = vi.fn(() => Promise.reject(new Error('hook failed')))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={commitAllChanges}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    const commitButton = await screen.findByTitle(t('files.git.commit'))
    await act(async () => { commitButton.click() })
    const field = screen.getByPlaceholderText(t('files.git.commitPlaceholder'))
    act(() => { fireEvent.change(field, { target: { value: 'fix things' } }) })
    await act(async () => { screen.getByTitle(t('files.git.commitSubmit')).click() })
    await screen.findByText('hook failed')
    expect(screen.queryByPlaceholderText(t('files.git.commitPlaceholder'))).not.toBeNull()
  })

  it('stringifies a non-Error commit rejection', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercising the non-Error rejection branch on purpose.
    const commitAllChanges = vi.fn(() => Promise.reject('denied'))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={commitAllChanges}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    const commitButton = await screen.findByTitle(t('files.git.commit'))
    await act(async () => { commitButton.click() })
    const field = screen.getByPlaceholderText(t('files.git.commitPlaceholder'))
    act(() => { fireEvent.change(field, { target: { value: 'fix things' } }) })
    await act(async () => { screen.getByTitle(t('files.git.commitSubmit')).click() })
    await screen.findByText('denied')
  })

  it('submits on Enter and cancels on Escape', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    const commitAllChanges = vi.fn(async () => {})
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={commitAllChanges}
        discardAllChanges={vi.fn(async () => {})}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    const commitButton = await screen.findByTitle(t('files.git.commit'))
    await act(async () => { commitButton.click() })
    const field = screen.getByPlaceholderText(t('files.git.commitPlaceholder'))
    act(() => { fireEvent.keyDown(field, { key: 'Escape' }) })
    await screen.findByTitle(t('files.git.commit'))
    expect(commitAllChanges).not.toHaveBeenCalled()
    await act(async () => { screen.getByTitle(t('files.git.commit')).click() })
    const reopenedField = screen.getByPlaceholderText(t('files.git.commitPlaceholder'))
    act(() => { fireEvent.change(reopenedField, { target: { value: 'fix things' } }) })
    await act(async () => { fireEvent.keyDown(reopenedField, { key: 'Enter' }) })
    expect(commitAllChanges).toHaveBeenCalledWith(wsId, 'fix things')
  })

  it('opens a confirmation dialog on Discard, and Cancel closes it without discarding', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    const discardAllChanges = vi.fn(async () => {})
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={discardAllChanges}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    const discardButton = await screen.findByTitle(t('files.git.discard'))
    await act(async () => { discardButton.click() })
    await screen.findByText(t('files.git.discardConfirmTitle'))
    await act(async () => { screen.getAllByText(t('files.git.cancel'))[0]?.click() })
    expect(discardAllChanges).not.toHaveBeenCalled()
    await waitFor(() => { expect(screen.queryByText(t('files.git.discardConfirmTitle'))).toBeNull() })
  })

  it('discards on confirm, refreshing git status and the directory listing on success', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    const listWorkspaceGitStatus = vi.fn()
      .mockResolvedValueOnce({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }) // initial mount
      .mockResolvedValueOnce({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }) // expand-triggered refresh
      .mockResolvedValueOnce({ isRepo: true, branch: 'main', files: {} }) // post-discard refresh
    const discardAllChanges = vi.fn(async () => {})
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={discardAllChanges}
        openPath={vi.fn()}
        listWorkspaceGitStatus={listWorkspaceGitStatus}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => { screen.getByText(t('files.label')).click() }) // expand: fetches listing once
    const discardButton = await screen.findByTitle(t('files.git.discard'))
    await act(async () => { discardButton.click() })
    await screen.findByText(t('files.git.discardConfirmTitle'))
    await act(async () => { screen.getByText(t('files.git.discardConfirm')).click() })
    expect(discardAllChanges).toHaveBeenCalledWith(wsId)
    await waitFor(() => { expect(screen.queryByText(t('files.git.discardConfirmTitle'))).toBeNull() })
    await waitFor(() => { expect(listWorkspaceGitStatus).toHaveBeenCalledTimes(3) })
    await waitFor(() => { expect(listWorkspaceEntries).toHaveBeenCalledTimes(2) })
  })

  it('shows an error and keeps the dialog open when discard fails', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    const discardAllChanges = vi.fn(() => Promise.reject(new Error('permission denied')))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={discardAllChanges}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    const discardButton = await screen.findByTitle(t('files.git.discard'))
    await act(async () => { discardButton.click() })
    await screen.findByText(t('files.git.discardConfirmTitle'))
    await act(async () => { screen.getByText(t('files.git.discardConfirm')).click() })
    await screen.findByText('permission denied')
    expect(screen.queryByText(t('files.git.discardConfirmTitle'))).not.toBeNull()
  })

  it('stringifies a non-Error discard rejection', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercising the non-Error rejection branch on purpose.
    const discardAllChanges = vi.fn(() => Promise.reject('denied'))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={discardAllChanges}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    const discardButton = await screen.findByTitle(t('files.git.discard'))
    await act(async () => { discardButton.click() })
    await screen.findByText(t('files.git.discardConfirmTitle'))
    await act(async () => { screen.getByText(t('files.git.discardConfirm')).click() })
    await screen.findByText('denied')
  })

  it('keeps the discard dialog open against a close attempt while the discard is still in flight', async () => {
    const listWorkspaceEntries = treeListWorkspaceEntries({ '/ws': [] })
    let resolveDiscard: (() => void) | undefined
    const discardAllChanges = vi.fn(() => new Promise<void>((resolve) => { resolveDiscard = resolve }))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={vi.fn()}
        commitAllChanges={vi.fn(async () => {})}
        discardAllChanges={discardAllChanges}
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.resolve({ isRepo: true, branch: 'main', files: { '/ws/a.txt': 'M' } }))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    const discardButton = await screen.findByTitle(t('files.git.discard'))
    await act(async () => { discardButton.click() })
    await screen.findByText(t('files.git.discardConfirmTitle'))
    await act(async () => { screen.getByText(t('files.git.discardConfirm')).click() })
    // The footer Cancel button is disabled while pending, but Modal's own
    // Escape handler is not gated on it — the guard inside closeDiscardConfirm
    // is what must reject this close attempt.
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByText(t('files.git.discardConfirmTitle'))).not.toBeNull()
    await act(async () => { resolveDiscard?.() })
    await waitFor(() => { expect(screen.queryByText(t('files.git.discardConfirmTitle'))).toBeNull() })
  })
})
