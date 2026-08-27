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
  Button, IconArrowUpOutline14, IconCheckOutline14, IconCloseFill14, IconFilePlaceholder16, IconFolderClose16,
  IconFolderOpen16, IconRefreshOutline14, IconTriangleRightFill14, IconUndoOutline14, Modal, StateDot,
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
  /** Stage every pending change (tracked and untracked) and commit them with `message`. */
  commitAllChanges: (workspaceId: WorkspaceId, message: string, signal?: AbortSignal) => Promise<void>
  /** Revert every tracked file's pending change to its `HEAD` content; an untracked file is left untouched. */
  discardAllChanges: (workspaceId: WorkspaceId, signal?: AbortSignal) => Promise<void>
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

/**
 * The Files header's branch name, dirty indicator, refresh control, and (when
 * there are pending changes) Commit-all/Discard-all triggers; renders nothing
 * outside a git working tree.
 */
function GitStatusSummary({ status, onRefresh, onCommit, onDiscard, t }: {
  status: WorkspaceGitStatus | undefined
  onRefresh: () => void
  onCommit: () => void
  onDiscard: () => void
  t: FilesTranslate
}) {
  if (status === undefined || !status.isRepo || status.branch === null) return null
  const changedCount = Object.keys(status.files).length
  return (
    <span className={css.gitSummary}>
      <span className={css.gitBranch} title={t('files.git.branch', { branch: status.branch })}>{status.branch}</span>
      {changedCount > 0 && (
        <>
          <span className={css.gitChangedCount} title={t('files.git.changedCount', { n: changedCount })}>
            {changedCount}
          </span>
          <button type="button" className={css.gitRefreshButton} title={t('files.git.commit')} onClick={onCommit}>
            <IconArrowUpOutline14 />
          </button>
          <button
            type="button"
            className={clsx(css.gitRefreshButton, css.gitDiscardButton)}
            title={t('files.git.discard')}
            onClick={onDiscard}
          >
            <IconUndoOutline14 />
          </button>
        </>
      )}
      <button
        type="button"
        className={css.gitRefreshButton}
        title={t('files.git.refresh')}
        onClick={onRefresh}
      >
        <IconRefreshOutline14 />
      </button>
    </span>
  )
}

/** The Files header's inline commit-message entry, replacing the branch/count/refresh row while active. */
function GitCommitInput({ message, onMessageChange, onSubmit, onCancel, pending, t }: {
  message: string
  onMessageChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  pending: boolean
  t: FilesTranslate
}) {
  return (
    <span className={css.gitCommitInput}>
      <input
        type="text"
        className={css.gitCommitField}
        value={message}
        placeholder={t('files.git.commitPlaceholder')}
        disabled={pending}
        autoFocus
        onChange={(e) => { onMessageChange(e.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && message.trim() !== '' && !pending) onSubmit()
          if (e.key === 'Escape' && !pending) onCancel()
        }}
      />
      <button
        type="button"
        className={css.gitRefreshButton}
        title={t('files.git.commitSubmit')}
        disabled={pending || message.trim() === ''}
        onClick={onSubmit}
      >
        <IconCheckOutline14 />
      </button>
      <button
        type="button"
        className={css.gitRefreshButton}
        title={t('files.git.cancel')}
        disabled={pending}
        onClick={onCancel}
      >
        <IconCloseFill14 />
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
  commitAllChanges, discardAllChanges, openPath, currentSessionId, openFileInSession, t,
}: FilesNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [gitStatus, refreshGitStatus] = useGitStatus(workspaceId, listWorkspaceGitStatus)
  // Bumped after a successful commit or discard to force the currently
  // rendered directory level (and every level nested under it) to remount
  // and refetch — a commit hook or a discard can both change file content on
  // disk, which the level's own fetch has no other way to learn about.
  const [levelRefreshKey, setLevelRefreshKey] = useState(0)
  const [commitMode, setCommitMode] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [commitPending, setCommitPending] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [discardConfirming, setDiscardConfirming] = useState(false)
  const [discardPending, setDiscardPending] = useState(false)
  const [discardError, setDiscardError] = useState<string | null>(null)
  const startCommit = useCallback(() => {
    setCommitMessage('')
    setCommitError(null)
    setCommitMode(true)
  }, [])
  const cancelCommit = useCallback(() => {
    setCommitMode(false)
    setCommitError(null)
  }, [])
  const submitCommit = useCallback(() => {
    // Both callers (the submit button's disabled state, GitCommitInput's own
    // Enter-key guard) already require a non-blank message before invoking
    // this — there is no route to reach it with one.
    const message = commitMessage.trim()
    setCommitPending(true)
    setCommitError(null)
    commitAllChanges(workspaceId, message).then(() => {
      setCommitPending(false)
      setCommitMode(false)
      setCommitMessage('')
      refreshGitStatus()
      setLevelRefreshKey(key => key + 1)
    }).catch((reason: unknown) => {
      setCommitPending(false)
      setCommitError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [commitAllChanges, workspaceId, commitMessage, refreshGitStatus])
  const openDiscardConfirm = useCallback(() => {
    setDiscardError(null)
    setDiscardConfirming(true)
  }, [])
  const closeDiscardConfirm = useCallback(() => {
    if (discardPending) return
    setDiscardConfirming(false)
    setDiscardError(null)
  }, [discardPending])
  const confirmDiscard = useCallback(() => {
    setDiscardPending(true)
    setDiscardError(null)
    discardAllChanges(workspaceId).then(() => {
      setDiscardPending(false)
      setDiscardConfirming(false)
      refreshGitStatus()
      setLevelRefreshKey(key => key + 1)
    }).catch((reason: unknown) => {
      setDiscardPending(false)
      setDiscardError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [discardAllChanges, workspaceId, refreshGitStatus])
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
        {commitMode
          ? (
            <GitCommitInput
              message={commitMessage}
              onMessageChange={setCommitMessage}
              onSubmit={submitCommit}
              onCancel={cancelCommit}
              pending={commitPending}
              t={t}
            />
          )
          : (
            <GitStatusSummary
              status={gitStatus}
              onRefresh={refreshGitStatus}
              onCommit={startCommit}
              onDiscard={openDiscardConfirm}
              t={t}
            />
          )}
      </div>
      {commitError !== null && <div className={css.notice} role="alert">{commitError}</div>}
      {expanded && (
        <FilesLevel
          key={levelRefreshKey}
          path={rootPath}
          depth={1}
          onOpenFile={handleOpenFile}
          listWorkspaceEntries={list}
          gitStatusFiles={gitStatus?.files}
          t={t}
        />
      )}
      <FileViewer path={previewPath} readFile={readFile} openPath={openPath} onClose={() => { setPreviewPath(null) }} t={t} />
      <Modal
        open={discardConfirming}
        onClose={closeDiscardConfirm}
        closeLabel={t('files.git.cancel')}
        title={t('files.git.discardConfirmTitle')}
        description={t('files.git.discardConfirmDesc')}
        footer={(
          <>
            <Button variant="outline" disabled={discardPending} onClick={closeDiscardConfirm}>
              {t('files.git.cancel')}
            </Button>
            <Button variant="outline" className={css.discardConfirmButton} disabled={discardPending} onClick={confirmDiscard}>
              {t('files.git.discardConfirm')}
            </Button>
          </>
        )}
      >
        {discardPending && <div className={css.notice} role="status">{t('files.git.discardPending')}</div>}
        {discardError !== null && <div className={css.notice} role="alert">{discardError}</div>}
      </Modal>
    </>
  )
}
