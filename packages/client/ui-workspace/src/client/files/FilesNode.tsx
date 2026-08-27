/**
 * The Files tree: a sibling row to a Workspace's Session rows (the browser's
 * per-group section — see `SessionTree` in `../WorkspaceBrowser.tsx`), one
 * per real Workspace group. Its own header row toggles a lazily fetched,
 * one-level-at-a-time directory listing that includes files as well as
 * subdirectories (unlike the workspace-root picker's directory-only browse);
 * a directory row expands in place (indented, nested `FilesLevel`
 * recursion), and a file row opens the current session's File tab via the
 * `conversationFileOpener` optional service, falling back to the `FileViewer`
 * in-app preview modal when there is no current session or the service isn't
 * composed in. Purely local component state — no store, no persistence
 * across remounts, mirroring `ui-directory-picker-browse`'s "no search, no
 * persistence" posture.
 */
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  IconFilePlaceholder16, IconFolderClose16, IconFolderOpen16, IconTriangleRightFill14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, WorkspaceEntry, WorkspaceEntryListing, WorkspaceFileContent, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceKey } from '../locales.ts'
import { FileViewer } from './FileViewer.tsx'
import css from './FilesNode.module.css'

/** The standard locale seat this tree consumes (a slice of the browser's full namespace). */
type FilesTranslate = (key: WorkspaceKey, vars?: Record<string, string | number>) => string

export interface FilesNodeProps {
  workspaceId: WorkspaceId
  /** The Workspace's own canonical root path (the tree's initial level). */
  rootPath: string
  /** List one directory level (directories AND files). */
  listWorkspaceEntries: (workspaceId: WorkspaceId, path: string, signal?: AbortSignal) => Promise<WorkspaceEntryListing>
  /** Read one file's content for in-app preview. */
  readWorkspaceFile: (workspaceId: WorkspaceId, path: string, signal?: AbortSignal) => Promise<WorkspaceFileContent>
  /** Open a file with the Host OS default application (the preview's external fallback). */
  openPath: (path: string) => Promise<void>
  /** The currently selected session, if any (the file-tab open route's target). */
  currentSessionId: SessionId | undefined
  /**
   * Try opening a file in the current session's in-app File tab. False (no
   * current session, no live binding, or the service isn't composed in)
   * falls back to the in-app preview modal.
   */
  openFileInSession: (sessionId: SessionId, path: string) => boolean
  t: FilesTranslate
}

/** One level's fetch state, keyed by directory path so a collapse-then-reopen refetches. */
type LevelState =
  | { phase: 'loading' }
  | { phase: 'ready'; entries: readonly WorkspaceEntry[]; truncated: boolean }
  | { phase: 'error' }

/**
 * Fetch one directory level and report its settled state, aborting on
 * unmount or path change. The caller mounts `FilesLevel` (and therefore this
 * hook) only while its own row is expanded — there is no `open` flag here
 * because there is no live instance to hold one while closed.
 */
function useLevel(
  path: string,
  list: (path: string, signal?: AbortSignal) => Promise<WorkspaceEntryListing>,
): LevelState {
  const [state, setState] = useState<LevelState>({ phase: 'loading' })
  useEffect(() => {
    setState({ phase: 'loading' })
    const controller = new AbortController()
    list(path, controller.signal).then((listing) => {
      if (controller.signal.aborted) return
      setState({ phase: 'ready', entries: listing.entries, truncated: listing.truncated })
    }).catch(() => {
      if (controller.signal.aborted) return
      setState({ phase: 'error' })
    })
    return () => { controller.abort() }
  }, [path, list])
  return state
}

/** One directory row: chevron + folder glyph + name; expands its own nested level in place. */
function DirectoryRow({ entry, depth, onOpenFile, listWorkspaceEntries, t }: {
  entry: WorkspaceEntry
  depth: number
  onOpenFile: (path: string) => void
  listWorkspaceEntries: (path: string, signal?: AbortSignal) => Promise<WorkspaceEntryListing>
  t: FilesTranslate
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <button
        type="button"
        className={css.row}
        style={{ paddingLeft: 8 + depth * 22 }}
        aria-expanded={expanded}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={clsx(css.slot, css.chevron)}>
          <IconTriangleRightFill14 className={clsx(css.arrow, expanded && css.arrowOpen)} />
        </span>
        <span className={css.slot}>
          {expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
        </span>
        <span className={css.name}>{entry.name}</span>
      </button>
      {expanded && (
        <FilesLevel
          path={entry.path}
          depth={depth + 1}
          onOpenFile={onOpenFile}
          listWorkspaceEntries={listWorkspaceEntries}
          t={t}
        />
      )}
    </>
  )
}

/** One file row: file glyph + name; opens the current session's File tab, or the in-app preview modal as fallback. */
function FileRow({ entry, depth, onOpen }: { entry: WorkspaceEntry; depth: number; onOpen: (path: string) => void }) {
  return (
    <button
      type="button"
      className={css.row}
      style={{ paddingLeft: 8 + depth * 22 }}
      onClick={() => { onOpen(entry.path) }}
    >
      <span className={css.slot} />
      <span className={css.slot}>
        <IconFilePlaceholder16 />
      </span>
      <span className={css.name}>{entry.name}</span>
    </button>
  )
}

/** One fetched level's rows: loading/error/empty states, else directory rows before file rows. */
function FilesLevel({ path, depth, onOpenFile, listWorkspaceEntries, t }: {
  path: string
  depth: number
  onOpenFile: (path: string) => void
  listWorkspaceEntries: (path: string, signal?: AbortSignal) => Promise<WorkspaceEntryListing>
  t: FilesTranslate
}) {
  const state = useLevel(path, listWorkspaceEntries)
  const indent = 8 + depth * 22
  if (state.phase === 'loading') {
    return <div className={css.notice} style={{ paddingLeft: indent }}>{t('files.viewer.loading')}</div>
  }
  if (state.phase === 'error') {
    return <div className={css.notice} role="alert" style={{ paddingLeft: indent }}>{t('files.loadError')}</div>
  }
  if (state.entries.length === 0) {
    return <div className={css.notice} style={{ paddingLeft: indent }}>{t('files.empty')}</div>
  }
  return (
    <>
      {state.entries.map(entry => (
        entry.type === 'directory'
          ? (
            <DirectoryRow
              key={entry.path}
              entry={entry}
              depth={depth}
              onOpenFile={onOpenFile}
              listWorkspaceEntries={listWorkspaceEntries}
              t={t}
            />
          )
          : <FileRow key={entry.path} entry={entry} depth={depth} onOpen={onOpenFile} />
      ))}
      {state.truncated && <div className={css.notice} style={{ paddingLeft: indent }}>{t('files.truncated')}</div>}
    </>
  )
}

/**
 * Render the Files sibling node for one real Workspace group: a header row
 * matching a session row's visual weight, expanding into the workspace
 * root's one-level listing.
 * @param props - see {@link FilesNodeProps}.
 * @returns the node's rows (header plus, while expanded, its fetched level).
 */
export function FilesNode({
  workspaceId, rootPath, listWorkspaceEntries, readWorkspaceFile, openPath, currentSessionId, openFileInSession, t,
}: FilesNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  // Stable across the viewer-open/close re-renders that would otherwise
  // recreate these closures and re-arm useLevel's effect (its dependency
  // array includes `list`, so an unstable closure would refetch the level on
  // every unrelated state change).
  const list = useCallback(
    (path: string, signal?: AbortSignal): Promise<WorkspaceEntryListing> => listWorkspaceEntries(workspaceId, path, signal),
    [listWorkspaceEntries, workspaceId],
  )
  const readFile = useCallback(
    (path: string, signal?: AbortSignal): Promise<WorkspaceFileContent> => readWorkspaceFile(workspaceId, path, signal),
    [readWorkspaceFile, workspaceId],
  )
  // Tab-dock first: only fall back to the in-app preview modal when there is
  // no current session or the conversationFileOpener service isn't composed in.
  const handleOpenFile = useCallback((path: string) => {
    if (currentSessionId !== undefined && openFileInSession(currentSessionId, path)) return
    setPreviewPath(path)
  }, [currentSessionId, openFileInSession])
  return (
    <>
      <button
        type="button"
        className={css.row}
        style={{ paddingLeft: 8 }}
        aria-expanded={expanded}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={clsx(css.slot, css.chevron)}>
          <IconTriangleRightFill14 className={clsx(css.arrow, expanded && css.arrowOpen)} />
        </span>
        <span className={css.slot}>
          {expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
        </span>
        <span className={css.name}>{t('files.label')}</span>
      </button>
      {expanded && (
        <FilesLevel
          path={rootPath}
          depth={1}
          onOpenFile={handleOpenFile}
          listWorkspaceEntries={list}
          t={t}
        />
      )}
      <FileViewer path={previewPath} readFile={readFile} openPath={openPath} onClose={() => { setPreviewPath(null) }} t={t} />
    </>
  )
}
