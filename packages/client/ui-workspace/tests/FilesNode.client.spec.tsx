// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  SessionId, WorkspaceEntryListing, WorkspaceFileContent, WorkspaceGitStatus, WorkspaceId,
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
      Promise.resolve({ kind: 'text', content: `content of ${path}` }))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={readWorkspaceFile}
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
    const readWorkspaceFile = vi.fn((): Promise<WorkspaceFileContent> => Promise.resolve({ kind: 'text', content: 'body' }))
    const sessionId = 'sess-1' as SessionId
    const openFileInSession = vi.fn(() => true)
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={readWorkspaceFile}
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
    const readWorkspaceFile = vi.fn((): Promise<WorkspaceFileContent> => Promise.resolve({ kind: 'text', content: 'body' }))
    const sessionId = 'sess-1' as SessionId
    const openFileInSession = vi.fn(() => false)
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={readWorkspaceFile}
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
    const readWorkspaceFile = vi.fn((): Promise<WorkspaceFileContent> => Promise.resolve({ kind: 'text', content: 'body' }))
    render(
      <FilesNode
        workspaceId={wsId}
        rootPath="/ws"
        listWorkspaceEntries={listWorkspaceEntries}
        readWorkspaceFile={readWorkspaceFile}
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
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(noGitStatus)}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await waitFor(() => { expect(screen.queryByText('main')).toBeNull() })
    expect(screen.queryByTitle(t('files.git.dirty'))).toBeNull()
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
        openPath={vi.fn()}
        listWorkspaceGitStatus={vi.fn(() => Promise.reject(new Error('denied')))}
        currentSessionId={undefined}
        openFileInSession={vi.fn(() => false)}
        t={t}
      />,
    )
    await act(async () => {})
    expect(screen.queryByText('main')).toBeNull()
    expect(screen.queryByTitle(t('files.git.dirty'))).toBeNull()
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
})
