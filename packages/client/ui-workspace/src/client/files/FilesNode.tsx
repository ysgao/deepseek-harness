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
  IconFilePlaceholder16, IconFolderClose16, IconFolderOpen16, IconRefreshOutline14, IconTriangleRightFill14, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SessionId, WorkspaceEntry, WorkspaceEntryListing, WorkspaceFileContent, WorkspaceGitStatus, WorkspaceId,
} from '@deepseek-ai/dsh-client-runtime/client'
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
  /** Report the Workspace's current git branch and pending file changes, if its directory is inside a git working tree. */
  listWorkspaceGitStatus: (workspaceId: WorkspaceId, signal?: AbortSignal) => Promise<WorkspaceGitStatus>
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

/** Locale key naming one git porcelain status code's full-word label. */
const GIT_STATUS_LABEL_KEYS: Readonly<Record<string, WorkspaceKey>> = {
  M: 'files.git.status.M',
  A: 'files.git.status.A',
  D: 'files.git.status.D',
  R: 'files.git.status.R',
  C: 'files.git.status.C',
  U: 'files.git.status.U',
}

/**
 * Fetch a Workspace's git status on mount (and per `workspaceId` change),
 * aborting on unmount/change; a request superseded before it settles is
 * dropped rather than committed. The returned `refresh` re-triggers the
 * fetch on demand (an explicit refresh control, or the caller's own
 * collapse-then-reopen gesture) without clearing the current status first —
 * the display holds its last known value during a refresh rather than
 * flickering empty. Returns `undefined` until the first fetch settles and
 * stays `undefined` on failure — the header simply omits the branch/status
 * display rather than showing an error notice, since "no git status
 * available" is not a failure state a user needs to act on.
 */
function useGitStatus(
  workspaceId: WorkspaceId,
  listWorkspaceGitStatus: (workspaceId: WorkspaceId, signal?: AbortSignal) => Promise<WorkspaceGitStatus>,
): readonly [WorkspaceGitStatus | undefined, () => void] {
  const [status, setStatus] = useState<WorkspaceGitStatus | undefined>(undefined)
  const [refreshToken, setRefreshToken] = useState(0)
  // A workspace-identity change drops the previous workspace's status
  // immediately, distinct from a same-workspace refresh (refreshToken),
  // which keeps showing the last known status until the new fetch settles.
  useEffect(() => { setStatus(undefined) }, [workspaceId])
  useEffect(() => {
    const controller = new AbortController()
    listWorkspaceGitStatus(workspaceId, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setStatus(result)
    }).catch(() => {
      // Superseded (aborted) or failed: leave the header showing whatever it last had.
    })
    return () => { controller.abort() }
  }, [workspaceId, listWorkspaceGitStatus, refreshToken])
  const refresh = useCallback(() => { setRefreshToken(token => token + 1) }, [])
  return [status, refresh] as const
}

/** The Files header's branch name, dirty indicator, and refresh control; renders nothing outside a git working tree. */
function GitStatusSummary({ status, onRefresh, t }: {
  status: WorkspaceGitStatus | undefined
  onRefresh: () => void
  t: FilesTranslate
}) {
  if (status === undefined || !status.isRepo || status.branch === null) return null
  const dirty = Object.keys(status.files).length > 0
  return (
    <span className={css.gitSummary}>
      <span className={css.gitBranch} title={t('files.git.branch', { branch: status.branch })}>{status.branch}</span>
      {dirty && (
        <span className={css.gitDirtyDot} title={t('files.git.dirty')}>
          <StateDot state="warning" size={6} />
        </span>
      )}
      <button
        type="button"
        className={css.gitRefreshButton}
        title={t('files.git.refresh')}
        onClick={(e) => { e.stopPropagation(); onRefresh() }}
      >
        <IconRefreshOutline14 />
      </button>
    </span>
  )
}

/** One file row's git status badge (a single letter, color-coded by change kind); renders nothing for an unchanged file. */
function GitStatusBadge({ code, t }: { code: string | undefined; t: FilesTranslate }) {
  if (code === undefined) return null
  const labelKey = GIT_STATUS_LABEL_KEYS[code]
  return (
    <span className={clsx(css.gitStatusBadge, css[`gitStatus${code}`])} title={labelKey === undefined ? undefined : t(labelKey)}>
      {code}
    </span>
  )
}

/**
 * True when `path` is a filesystem descendant of `dirPath` — a host-native
 * path prefix match (either `/` or `\` separator) requiring a full
 * path-segment boundary, not a bare string prefix (`/ws/foo` must not
 * match `/ws/foobar/x`).
 */
function isUnderDirectory(path: string, dirPath: string): boolean {
  if (!path.startsWith(dirPath)) return false
  const boundary = path.charAt(dirPath.length)
  return boundary === '/' || boundary === '\\'
}

/**
 * Whether any path in the git status map falls under `dirPath`, at any
 * depth — the status map covers the whole repository from one fetch, so
 * this answers correctly even for a directory level the tree has not
 * fetched (or expanded) yet.
 */
function hasChangesUnder(dirPath: string, files: Readonly<Record<string, string>>): boolean {
  return Object.keys(files).some(path => isUnderDirectory(path, dirPath))
}

/** A directory row's aggregate dirty marker: shown when any file under it, at any depth, has a pending git change. */
function GitStatusFolderDot({ dirPath, gitStatusFiles, t }: {
  dirPath: string
  gitStatusFiles: Readonly<Record<string, string>> | undefined
  t: FilesTranslate
}) {
  if (gitStatusFiles === undefined || !hasChangesUnder(dirPath, gitStatusFiles)) return null
  return (
    <span className={css.gitDirtyDot} title={t('files.git.folderDirty')}>
      <StateDot state="warning" size={6} />
    </span>
  )
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
function DirectoryRow({ entry, depth, onOpenFile, listWorkspaceEntries, gitStatusFiles, t }: {
  entry: WorkspaceEntry
  depth: number
  onOpenFile: (path: string) => void
  listWorkspaceEntries: (path: string, signal?: AbortSignal) => Promise<WorkspaceEntryListing>
  gitStatusFiles: Readonly<Record<string, string>> | undefined
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
        <GitStatusFolderDot dirPath={entry.path} gitStatusFiles={gitStatusFiles} t={t} />
      </button>
      {expanded && (
        <FilesLevel
          path={entry.path}
          depth={depth + 1}
          onOpenFile={onOpenFile}
          listWorkspaceEntries={listWorkspaceEntries}
          gitStatusFiles={gitStatusFiles}
          t={t}
        />
      )}
    </>
  )
}

/**
 * One file row: file glyph + name + a git status badge for a pending
 * change; opens the current session's File tab, or the in-app preview
 * modal as fallback.
 */
function FileRow({ entry, depth, onOpen, gitStatusFiles, t }: {
  entry: WorkspaceEntry
  depth: number
  onOpen: (path: string) => void
  gitStatusFiles: Readonly<Record<string, string>> | undefined
  t: FilesTranslate
}) {
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
      <GitStatusBadge code={gitStatusFiles?.[entry.path]} t={t} />
    </button>
  )
}

/** One fetched level's rows: loading/error/empty states, else directory rows before file rows. */
function FilesLevel({ path, depth, onOpenFile, listWorkspaceEntries, gitStatusFiles, t }: {
  path: string
  depth: number
  onOpenFile: (path: string) => void
  listWorkspaceEntries: (path: string, signal?: AbortSignal) => Promise<WorkspaceEntryListing>
  gitStatusFiles: Readonly<Record<string, string>> | undefined
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
              gitStatusFiles={gitStatusFiles}
              t={t}
            />
          )
          : <FileRow key={entry.path} entry={entry} depth={depth} onOpen={onOpenFile} gitStatusFiles={gitStatusFiles} t={t} />
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
  workspaceId, rootPath, listWorkspaceEntries, readWorkspaceFile, listWorkspaceGitStatus,
  openPath, currentSessionId, openFileInSession, t,
}: FilesNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [gitStatus, refreshGitStatus] = useGitStatus(workspaceId, listWorkspaceGitStatus)
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
  // A collapse-then-reopen also refreshes git status (mirroring the level
  // fetch's own "collapse-then-reopen refetches" posture) — a second, no-UI
  // route to fresh status alongside the explicit refresh control.
  const toggleExpanded = useCallback(() => {
    setExpanded((value) => {
      const next = !value
      if (next) refreshGitStatus()
      return next
    })
  }, [refreshGitStatus])
  return (
    <>
      <div className={css.headerRow}>
        <button
          type="button"
          className={clsx(css.row, css.headerToggle)}
          style={{ paddingLeft: 8 }}
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <span className={clsx(css.slot, css.chevron)}>
            <IconTriangleRightFill14 className={clsx(css.arrow, expanded && css.arrowOpen)} />
          </span>
          <span className={css.slot}>
            {expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
          </span>
          <span className={css.name}>{t('files.label')}</span>
        </button>
        <GitStatusSummary status={gitStatus} onRefresh={refreshGitStatus} t={t} />
      </div>
      {expanded && (
        <FilesLevel
          path={rootPath}
          depth={1}
          onOpenFile={handleOpenFile}
          listWorkspaceEntries={list}
          gitStatusFiles={gitStatus?.files}
          t={t}
        />
      )}
      <FileViewer path={previewPath} readFile={readFile} openPath={openPath} onClose={() => { setPreviewPath(null) }} t={t} />
    </>
  )
}
