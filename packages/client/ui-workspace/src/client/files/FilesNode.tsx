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
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconArrowDownOutline14, IconArrowUpOutline14, IconCheckOutline14, IconChevronDuoUpOutline14, IconCloseFill14,
  IconFilePlaceholder16, IconFolderClose16, IconFolderOpen16, IconNewFile16, IconNewFolder16, IconRefreshOutline14,
  IconTriangleRightFill14, IconUndoOutline14, Modal, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceEntry, WorkspaceEntryListing, WorkspaceFileContent, WorkspaceGitStatus, WorkspaceId,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceKey } from '../locales.ts'
import { FileViewer } from './FileViewer.tsx'
import css from './FilesNode.module.css'

/** The standard locale seat this tree consumes — the full `workspace` namespace, matching `FileViewer`'s own. */
type FilesTranslate = TranslateNS<'workspace'>

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
  /** Create one new, empty regular file as a child of an existing directory; returns the created file's absolute path. */
  createWorkspaceFile: (workspaceId: WorkspaceId, parentPath: string, name: string, signal?: AbortSignal) => Promise<string>
  /** Create one new, empty directory as a child of an existing directory; returns the created directory's absolute path. */
  createWorkspaceFolder: (workspaceId: WorkspaceId, parentPath: string, name: string, signal?: AbortSignal) => Promise<string>
  /** Stage every pending change (tracked and untracked) and commit them with `message`. */
  commitAllChanges: (workspaceId: WorkspaceId, message: string, signal?: AbortSignal) => Promise<void>
  /** Revert every tracked file's pending change to its `HEAD` content; an untracked file is left untouched. */
  discardAllChanges: (workspaceId: WorkspaceId, signal?: AbortSignal) => Promise<void>
  /**
   * Download new commits and update the workspace's remote-tracking refs,
   * without touching the current branch or working tree. The header's
   * Refresh control calls this before re-reading git status, so the
   * ahead/behind counts driving Pull/Push's own visibility reflect the real
   * remote instead of lagging behind it indefinitely.
   */
  fetchRemote: (workspaceId: WorkspaceId, signal?: AbortSignal) => Promise<void>
  /**
   * Rebase local commits onto the current branch's already-known upstream,
   * without fetching first — pairs with `fetchRemote`, which the Refresh
   * control already calls, so what Pull applies always matches the
   * already-displayed `behind` count rather than a second, later fetch's
   * possibly-different result landing mid-rebase.
   */
  pullRebase: (workspaceId: WorkspaceId, signal?: AbortSignal) => Promise<void>
  /** Push the current branch to its configured remote. */
  push: (workspaceId: WorkspaceId, signal?: AbortSignal) => Promise<void>
  /** Open a file with the Host OS default application (the preview's external fallback). */
  openPath: (path: string) => Promise<void>
  /** The currently selected session, if any (the file-tab open route's target). */
  currentSessionId: SessionId | undefined
  /**
   * Try opening a file in the current session's in-app File tab. False (no
   * current session, no live binding, or the service isn't composed in)
   * falls back to the in-app preview modal.
   */
  openFileInSession: (sessionId: SessionId, workspaceId: WorkspaceId, path: string) => boolean
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
  X: 'files.git.status.X',
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
 * The Files header's branch name and dirty indicator always render for a
 * repository (independent of upstream reachability), while the write
 * actions gate on there being something to act on: Commit-all/Discard-all
 * need a pending change, and Pull/Push each need their own upstream-relative
 * commit count ({@link WorkspaceGitStatus.behind}/{@link
 * WorkspaceGitStatus.ahead}) to be positive — a branch with no configured
 * upstream, or one that is already in sync, shows neither, since a click
 * would either fail immediately or do nothing. Refresh always renders: it
 * fetches from the remote (making a stale `behind`/`ahead` count accurate),
 * then re-reads local git status.
 *
 * `busy` disables every trigger except Refresh while another write action
 * (commit, discard, pull, push) is in flight or the discard confirmation is
 * open — these all mutate the same working tree, so only one may run at a
 * time. Refresh's own fetch is deliberately exempt from `busy` in both
 * directions: it never touches the working tree or index (unlike every
 * other trigger here), so it may run alongside them; it disables only
 * itself (`fetchPending`) to guard against a double-click starting two
 * concurrent fetches. While its own action is pending, Pull/Push each also
 * grow an adjacent Cancel button: both are network operations with no
 * deadline (see `pullRebase`/`push`'s `'caller-signal-only'` timeout
 * policy), so a stuck credential prompt or unreachable remote needs an
 * escape hatch, not just a disabled icon.
 */
function GitStatusSummary({
  status, onRefresh, onCommit, onDiscard, onPull, onPush, onCancelPull, onCancelPush,
  busy, fetchPending, pullPending, pushPending, t,
}: {
  status: WorkspaceGitStatus | undefined
  onRefresh: () => void
  onCommit: () => void
  onDiscard: () => void
  onPull: () => void
  onPush: () => void
  onCancelPull: () => void
  onCancelPush: () => void
  busy: boolean
  fetchPending: boolean
  pullPending: boolean
  pushPending: boolean
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
          <button type="button" className={css.gitRefreshButton} title={t('files.git.commit')} disabled={busy} onClick={onCommit}>
            <IconArrowUpOutline14 />
          </button>
          <button
            type="button"
            className={clsx(css.gitRefreshButton, css.gitDiscardButton)}
            title={t('files.git.discard')}
            disabled={busy}
            onClick={onDiscard}
          >
            <IconUndoOutline14 />
          </button>
        </>
      )}
      {(status.behind > 0 || pullPending) && (
        <>
          {pullPending && (
            <button type="button" className={css.gitRefreshButton} title={t('files.git.cancel')} onClick={onCancelPull}>
              <IconCloseFill14 />
            </button>
          )}
          <span className={css.gitAheadBehindGroup}>
            <button type="button" className={css.gitRefreshButton} title={t('files.git.pull', { n: status.behind })} disabled={busy} onClick={onPull}>
              <IconArrowDownOutline14 />
            </button>
            {status.behind > 0 && <span className={css.gitAheadBehindCount}>{status.behind}</span>}
          </span>
        </>
      )}
      {(status.ahead > 0 || pushPending) && (
        <>
          {pushPending && (
            <button type="button" className={css.gitRefreshButton} title={t('files.git.cancel')} onClick={onCancelPush}>
              <IconCloseFill14 />
            </button>
          )}
          <span className={css.gitAheadBehindGroup}>
            <button type="button" className={css.gitRefreshButton} title={t('files.git.push', { n: status.ahead })} disabled={busy} onClick={onPush}>
              <IconChevronDuoUpOutline14 />
            </button>
            {status.ahead > 0 && <span className={css.gitAheadBehindCount}>{status.ahead}</span>}
          </span>
        </>
      )}
      <button
        type="button"
        className={css.gitRefreshButton}
        title={t('files.git.refresh')}
        disabled={fetchPending}
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

/**
 * The Files header's always-visible Add-file/Add-folder triggers — shown
 * regardless of git-repo status (unlike the git action group), before the
 * branch/status display. `busy` mirrors the git action group's own
 * single-write-at-a-time posture: creating a file/folder also touches the
 * working tree.
 */
function AddEntryButtons({ onAddFile, onAddFolder, busy, t }: {
  onAddFile: () => void
  onAddFolder: () => void
  busy: boolean
  t: FilesTranslate
}) {
  return (
    <span className={css.addEntryButtons}>
      <button type="button" className={css.gitRefreshButton} title={t('files.add.file')} disabled={busy} onClick={onAddFile}>
        <IconNewFile16 />
      </button>
      <button
        type="button"
        className={css.gitRefreshButton}
        title={t('files.add.folder')}
        disabled={busy}
        onClick={onAddFolder}
      >
        <IconNewFolder16 />
      </button>
    </span>
  )
}

/** The Files header's inline new-file/new-folder name entry, replacing the branch/count/refresh row while active. */
function CreateEntryInput({ kind, name, onNameChange, onSubmit, onCancel, pending, t }: {
  kind: 'file' | 'folder'
  name: string
  onNameChange: (value: string) => void
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
        value={name}
        placeholder={kind === 'file' ? t('files.add.filePlaceholder') : t('files.add.folderPlaceholder')}
        disabled={pending}
        autoFocus
        onChange={(e) => { onNameChange(e.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim() !== '' && !pending) onSubmit()
          if (e.key === 'Escape' && !pending) onCancel()
        }}
      />
      <button
        type="button"
        className={css.gitRefreshButton}
        title={t('files.add.submit')}
        disabled={pending || name.trim() === ''}
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

/**
 * One directory row: chevron + folder glyph + name; expands its own nested
 * level in place. A click both toggles expansion and marks this directory
 * the create-target for the header's Add-file/Add-folder actions — the two
 * gestures share one click rather than earning a separate selection
 * affordance, so a folder does not need to stay expanded to remain the
 * target of a later Add action.
 */
function DirectoryRow({ entry, depth, onOpenFile, listWorkspaceEntries, gitStatusFiles, selectedDirPath, onSelectDir, t }: {
  entry: WorkspaceEntry
  depth: number
  onOpenFile: (path: string) => void
  listWorkspaceEntries: (path: string, signal?: AbortSignal) => Promise<WorkspaceEntryListing>
  gitStatusFiles: Readonly<Record<string, string>> | undefined
  selectedDirPath: string | null
  onSelectDir: (path: string) => void
  t: FilesTranslate
}) {
  const [expanded, setExpanded] = useState(false)
  const selected = selectedDirPath === entry.path
  return (
    <>
      <button
        type="button"
        className={clsx(css.row, selected && css.rowSelected)}
        style={{ paddingLeft: 8 + depth * 22 }}
        aria-expanded={expanded}
        aria-selected={selected}
        onClick={() => {
          setExpanded(value => !value)
          onSelectDir(entry.path)
        }}
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
          selectedDirPath={selectedDirPath}
          onSelectDir={onSelectDir}
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
function FilesLevel({ path, depth, onOpenFile, listWorkspaceEntries, gitStatusFiles, selectedDirPath, onSelectDir, t }: {
  path: string
  depth: number
  onOpenFile: (path: string) => void
  listWorkspaceEntries: (path: string, signal?: AbortSignal) => Promise<WorkspaceEntryListing>
  gitStatusFiles: Readonly<Record<string, string>> | undefined
  selectedDirPath: string | null
  onSelectDir: (path: string) => void
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
              selectedDirPath={selectedDirPath}
              onSelectDir={onSelectDir}
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
  createWorkspaceFile, createWorkspaceFolder,
  commitAllChanges, discardAllChanges, fetchRemote, pullRebase, push, openPath, currentSessionId, openFileInSession, t,
}: FilesNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [gitStatus, refreshGitStatus] = useGitStatus(workspaceId, listWorkspaceGitStatus)
  // Bumped after a successful commit, discard, or create to force the
  // currently rendered directory level (and every level nested under it) to
  // remount and refetch — a commit hook, a discard, or a new file/folder can
  // all change directory content on disk, which the level's own fetch has no
  // other way to learn about.
  const [levelRefreshKey, setLevelRefreshKey] = useState(0)
  // The most recently clicked directory (its own click both expands/collapses
  // it and marks it the Add-file/Add-folder target); null targets the
  // workspace root. Not persisted across a collapse-then-reopen of the Files
  // node itself — a fresh expand always targets the root again.
  const [selectedDirPath, setSelectedDirPath] = useState<string | null>(null)
  const [commitMode, setCommitMode] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [commitPending, setCommitPending] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [createMode, setCreateMode] = useState<'file' | 'folder' | null>(null)
  const [createName, setCreateName] = useState('')
  const [createPending, setCreatePending] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [discardConfirming, setDiscardConfirming] = useState(false)
  const [discardPending, setDiscardPending] = useState(false)
  const [discardError, setDiscardError] = useState<string | null>(null)
  const [fetchPending, setFetchPending] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [pullPending, setPullPending] = useState(false)
  const [pullError, setPullError] = useState<string | null>(null)
  const [pushPending, setPushPending] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)
  // Only one write action (commit, discard, pull, push, create) may run
  // against the working tree at a time — concurrent operations race on the
  // same index/working tree otherwise. The discard confirmation counts too:
  // once it's open, starting another action first would need to reason
  // about a discard the user is mid-way through confirming. Refresh's own
  // fetch is deliberately absent here (see GitStatusSummary's own doc): it
  // never touches the working tree or index, so it may run alongside any of
  // these, and is guarded only by its own `fetchPending` self-disable.
  const busy = discardPending || discardConfirming || pullPending || pushPending || createPending
  // Pull/Push each hold the AbortController for their own in-flight call, so
  // the Cancel button (GitStatusSummary) can abort a hung network request —
  // both use the RPC's 'caller-signal-only' timeout policy, which never
  // times out on its own.
  const pullControllerRef = useRef<AbortController | null>(null)
  const pushControllerRef = useRef<AbortController | null>(null)
  const clearGitErrors = useCallback(() => {
    setCommitError(null)
    setDiscardError(null)
    setFetchError(null)
    setPullError(null)
    setPushError(null)
    setCreateError(null)
  }, [])
  const handleRefresh = useCallback(() => {
    clearGitErrors()
    setFetchPending(true)
    fetchRemote(workspaceId).then(() => {
      setFetchPending(false)
      refreshGitStatus()
    }).catch((reason: unknown) => {
      setFetchPending(false)
      setFetchError(reason instanceof Error ? reason.message : String(reason))
      // The fetch failed, but whatever git status is already locally known
      // (branch, pending changes) may still be worth re-displaying — e.g. a
      // commit made from a terminal since the last read — so still refresh
      // from local state rather than leaving the display untouched.
      refreshGitStatus()
    })
  }, [clearGitErrors, fetchRemote, workspaceId, refreshGitStatus])
  const startCommit = useCallback(() => {
    setCommitMessage('')
    clearGitErrors()
    setCommitMode(true)
  }, [clearGitErrors])
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
  const startCreate = useCallback((kind: 'file' | 'folder') => {
    setCreateName('')
    clearGitErrors()
    setCreateMode(kind)
  }, [clearGitErrors])
  const cancelCreate = useCallback(() => {
    setCreateMode(null)
    setCreateError(null)
  }, [])
  const submitCreate = useCallback(() => {
    // Both callers (the submit button's disabled state, CreateEntryInput's
    // own Enter-key guard) already require a non-blank name and a set mode
    // before invoking this — there is no route to reach it with either unset.
    if (createMode === null) return
    const name = createName.trim()
    const parentPath = selectedDirPath ?? rootPath
    const create = createMode === 'file' ? createWorkspaceFile : createWorkspaceFolder
    setCreatePending(true)
    setCreateError(null)
    create(workspaceId, parentPath, name).then(() => {
      setCreatePending(false)
      setCreateMode(null)
      setCreateName('')
      setLevelRefreshKey(key => key + 1)
    }).catch((reason: unknown) => {
      setCreatePending(false)
      setCreateError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [createMode, createName, selectedDirPath, rootPath, createWorkspaceFile, createWorkspaceFolder, workspaceId])
  const openDiscardConfirm = useCallback(() => {
    clearGitErrors()
    setDiscardConfirming(true)
  }, [clearGitErrors])
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
  const runPull = useCallback(() => {
    const controller = new AbortController()
    pullControllerRef.current = controller
    setPullPending(true)
    clearGitErrors()
    pullRebase(workspaceId, controller.signal).then(() => {
      pullControllerRef.current = null
      setPullPending(false)
      // A rebase can change working-tree content, the same as commit/discard.
      refreshGitStatus()
      setLevelRefreshKey(key => key + 1)
    }).catch((reason: unknown) => {
      pullControllerRef.current = null
      setPullPending(false)
      // A user-initiated cancel is not a failure to surface.
      if (controller.signal.aborted) return
      setPullError(reason instanceof Error ? reason.message : String(reason))
      // A rebase conflict leaves the repository mid-rebase with unmerged
      // files on disk — the same as a successful pull, the working tree
      // changed, so the header and level must refresh to show it (and to
      // surface Discard-all as the recovery action).
      refreshGitStatus()
      setLevelRefreshKey(key => key + 1)
    })
  }, [pullRebase, workspaceId, refreshGitStatus, clearGitErrors])
  const cancelPull = useCallback(() => {
    pullControllerRef.current?.abort()
  }, [])
  const runPush = useCallback(() => {
    const controller = new AbortController()
    pushControllerRef.current = controller
    setPushPending(true)
    clearGitErrors()
    push(workspaceId, controller.signal).then(() => {
      pushControllerRef.current = null
      setPushPending(false)
      // A push never changes local file content, but it does change how far
      // ahead of its upstream the branch is (typically back to zero) — refresh
      // so a satisfied Push button/count disappears on its own instead of
      // staying visible (stale) until the user clicks Refresh themselves.
      refreshGitStatus()
    }).catch((reason: unknown) => {
      pushControllerRef.current = null
      setPushPending(false)
      if (controller.signal.aborted) return
      setPushError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [push, workspaceId, clearGitErrors, refreshGitStatus])
  const cancelPush = useCallback(() => {
    pushControllerRef.current?.abort()
  }, [])
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
    if (currentSessionId !== undefined && openFileInSession(currentSessionId, workspaceId, path)) return
    setPreviewPath(path)
  }, [currentSessionId, workspaceId, openFileInSession])
  // A collapse-then-reopen also re-reads git status locally (mirroring the
  // level fetch's own "collapse-then-reopen refetches" posture) — a second,
  // no-UI route to fresh status alongside the explicit Refresh control.
  // Unlike Refresh, this does NOT fetch from the remote first: it is a
  // low-cost, no-network gesture, not a deliberate "check for updates" click.
  const toggleExpanded = useCallback(() => {
    setExpanded((value) => {
      const next = !value
      if (next) refreshGitStatus()
      return next
    })
    // Collapsing (or reopening) the Files node itself always retargets
    // Add-file/Add-folder to the workspace root — a stale selected
    // subdirectory from a prior expansion would otherwise silently outlive
    // the tree that showed it.
    setSelectedDirPath(null)
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
        {createMode !== null
          ? (
            <CreateEntryInput
              kind={createMode}
              name={createName}
              onNameChange={setCreateName}
              onSubmit={submitCreate}
              onCancel={cancelCreate}
              pending={createPending}
              t={t}
            />
          )
          : commitMode
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
              <>
                <AddEntryButtons
                  onAddFile={() => { startCreate('file') }}
                  onAddFolder={() => { startCreate('folder') }}
                  busy={busy}
                  t={t}
                />
                <GitStatusSummary
                  status={gitStatus}
                  onRefresh={handleRefresh}
                  onCommit={startCommit}
                  onDiscard={openDiscardConfirm}
                  onPull={runPull}
                  onPush={runPush}
                  onCancelPull={cancelPull}
                  onCancelPush={cancelPush}
                  busy={busy}
                  fetchPending={fetchPending}
                  pullPending={pullPending}
                  pushPending={pushPending}
                  t={t}
                />
              </>
            )}
      </div>
      {createError !== null && <div className={css.notice} role="alert">{createError}</div>}
      {commitError !== null && <div className={css.notice} role="alert">{commitError}</div>}
      {fetchError !== null && <div className={css.notice} role="alert">{fetchError}</div>}
      {pullError !== null && <div className={css.notice} role="alert">{pullError}</div>}
      {pushError !== null && <div className={css.notice} role="alert">{pushError}</div>}
      {expanded && (
        <FilesLevel
          key={levelRefreshKey}
          path={rootPath}
          depth={1}
          onOpenFile={handleOpenFile}
          listWorkspaceEntries={list}
          gitStatusFiles={gitStatus?.files}
          selectedDirPath={selectedDirPath}
          onSelectDir={setSelectedDirPath}
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
