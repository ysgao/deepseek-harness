/**
 * The File view: an ordinary `conversation.view` tab (alongside Chat and
 * Trajectory) rendering the shared {@link FilePreview} body for the session's
 * latest opened path (a `viewRequest` with `view: 'file'` — see
 * `ConvViewOwnerProps`). Populated only through the `conversationFileOpener`
 * service (`ui-conversation`'s `file-opener.ts` + this package's `apply.ts`);
 * the tab itself renders a resting notice while no path has ever been opened,
 * mirroring the empty-state posture of a fresh Chat view rather than hiding
 * itself. Mounted only when this package is installed, like every other
 * `conversation.view` entry.
 *
 * A text-kind file with a pending git change (per `getGitStatus`) offers a
 * View/Diff toggle; Diff mode fetches `getFileDiff` lazily and renders
 * {@link SideBySideDiff} in place of the plain preview. Binary and image
 * files stay out of scope for the toggle — a text-only diff, same as
 * `FilePreview`'s own PDF-preview posture, is a deferred follow-up, not a gap.
 *
 * Text and Markdown files also offer an Edit mode ({@link FileEditor}):
 * unsaved edits live in an in-memory per-path draft cache (`draftsRef`), not
 * React state, so switching to another file (or to View/Diff) and back never
 * silently loses a draft — no native `beforeunload`/`confirm` dialog needed.
 * Saving goes through `writeFile`'s version guard; a concurrent on-disk
 * change surfaces as an inline conflict notice rather than overwriting it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, FileEditor, FilePreview, SideBySideDiff } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  FileEditorResizeLabels, FilePreviewLabels, FilePreviewState, SideBySideDiffLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceFileBrowseError, WorkspaceFileContent, WorkspaceFileDiff, WorkspaceFileVersion, WorkspaceGitStatus,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceError, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { langFromPath, viewerKindFor } from './classify.ts'
import css from './FileView.module.css'

/**
 * Injected share of the File view entry. Every method takes the opened
 * path's own `workspaceId` (from the opener's request, when it had one —
 * see {@link OpenFileFocus}) rather than resolving it from the session, so
 * a request from a requester that already knows its exact workspace (the
 * Workspace Files tree) can never be misrouted to the wrong one.
 */
export interface FileViewInjected {
  /** Read one file's content under the given Workspace (fails when neither `workspaceId` nor a session-derived fallback resolves one). */
  readFile: (workspaceId: WorkspaceId | undefined, path: string, signal?: AbortSignal) => Promise<WorkspaceFileContent>
  /** Open the file with the Host OS default application (the external-kind and error fallback). */
  openPath: (path: string) => Promise<void>
  /** The given Workspace's git branch and pending file changes (decides whether the Diff toggle shows). */
  getGitStatus: (workspaceId: WorkspaceId | undefined, signal?: AbortSignal) => Promise<WorkspaceGitStatus>
  /** One file's `HEAD` and working-tree text, fetched lazily when the user switches to Diff mode. */
  getFileDiff: (workspaceId: WorkspaceId | undefined, path: string, signal?: AbortSignal) => Promise<WorkspaceFileDiff>
  /** Overwrite one file's content under the given Workspace, guarded by `expectedVersion`. */
  writeFile: (
    workspaceId: WorkspaceId | undefined, path: string, content: string, expectedVersion: WorkspaceFileVersion, signal?: AbortSignal,
  ) => Promise<WorkspaceFileVersion>
}

/**
 * The File view's own opaque `viewRequest.focus` payload (see
 * `ConvViewOwnerProps`'s JSDoc): JSON-encoded by `ui-conversation`'s
 * `openFile` so a requester's own `workspaceId`, when it has one, survives
 * the hand-off through the generic view-request channel.
 */
interface OpenFileFocus {
  readonly path: string
  readonly workspaceId?: WorkspaceId
}

/** Which body the tab shows for the opened path: the plain preview, the in-app editor, or the git diff. */
type FileViewMode = 'view' | 'edit' | 'diff'

/** Fetch state for the currently diffed path. */
type DiffFetchState =
  | { phase: 'loading' }
  | { phase: 'ready'; diff: WorkspaceFileDiff }
  | { phase: 'error' }

/** An in-progress edit for one path, forked from the version it was last read/saved at. */
interface FileDraft {
  text: string
  version: WorkspaceFileVersion
}

/** Save-button/status state for the currently open path's Edit mode. */
type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'conflict' }
  | { phase: 'error' }

/** Full File-view component props: runtime & injected & locale seat. */
export type FileViewProps = ConvViewProps & InjectFace<FileViewInjected> & PropsLocale<'conversation'>

/**
 * Parse the File view's own opaque `focus` payload — a JSON-encoded
 * {@link OpenFileFocus} written by `ui-conversation`'s `openFile`. Never
 * expected to fail within one coordinated deploy of both packages; guarded
 * rather than left to throw across a serialization boundary.
 * @param focus - the raw `viewRequest.focus` string.
 * @returns the decoded path/workspaceId pair, or null if it doesn't parse.
 */
function parseOpenFileFocus(focus: string): OpenFileFocus | null {
  try {
    const parsed: unknown = JSON.parse(focus)
    if (typeof parsed !== 'object' || parsed === null || !('path' in parsed) || typeof parsed.path !== 'string') return null
    return parsed as OpenFileFocus
  } catch {
    return null
  }
}

/** Decode base64 wire bytes to a revocable blob URL. */
function decodeBlobUrl(base64: string, mediaType: string): string {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return URL.createObjectURL(new Blob([bytes], { type: mediaType }))
}

/** Resolve one readFile rejection into the state its cause distinguishes. */
function stateFromError(error: unknown): FilePreviewState {
  if (error instanceof Error && error.name === 'WorkspaceFileBrowseError') {
    const failure = (error as WorkspaceFileBrowseError).rpcError as WorkspaceError
    if (failure.code === 'file-too-large') return { phase: 'too-large', maxBytes: failure.details.maxBytes }
  }
  return { phase: 'error' }
}

/**
 * Render the File view tab.
 * @param props - see {@link FileViewProps}.
 * @returns the tab's body element.
 */
export function FileView({
  viewRequest, completeViewRequest, readFile, openPath, getGitStatus, getFileDiff, writeFile, t,
}: FileViewProps) {
  const filePreviewLabels: FilePreviewLabels = useMemo(() => ({
    markdown: { code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('markdown.footnotes') },
    read: {
      window: (shown, total) => t('read.window', { shown, total }),
      copy: t('copy'),
      copied: t('copied'),
      collapseAria: t('read.collapseAria'),
      expandAria: count => t('read.expandAria', { count }),
      collapse: t('collapse'),
      expand: count => t('read.expandRest', { count }),
    },
  }), [t])

  const editorResizeLabels: FileEditorResizeLabels = useMemo(() => ({
    ariaLabel: t('files.edit.resizeAria'),
    title: t('files.edit.resizeTitle'),
  }), [t])

  const diffLabels: SideBySideDiffLabels = useMemo(() => ({
    copy: t('copy'),
    copied: t('copied'),
    resizeAria: t('files.diff.resizeAria'),
    resizeTitle: t('files.diff.resizeTitle'),
  }), [t])

  const openFileFocus = viewRequest?.view === 'file' ? parseOpenFileFocus(viewRequest.focus) : null
  const [openedPath, setOpenedPath] = useState<string | null>(null)
  const [openedWorkspaceId, setOpenedWorkspaceId] = useState<WorkspaceId | undefined>(undefined)
  const [state, setState] = useState<FilePreviewState>({ phase: 'loading' })
  const [version, setVersion] = useState<WorkspaceFileVersion | null>(null)
  const [mode, setMode] = useState<FileViewMode>('view')
  const [changed, setChanged] = useState(false)
  const [diffState, setDiffState] = useState<DiffFetchState>({ phase: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [refreshToken, setRefreshToken] = useState(0)

  // Unsaved edits, keyed by path, so switching to another file (or to
  // View/Diff) and back never silently loses a draft. Plain mutable state
  // (not React state): every keystroke would otherwise re-render the whole
  // tab. `hasDraft` is the reactive slice callers actually need to render
  // from (the unsaved-changes indicator, whether Save is enabled).
  const draftsRef = useRef(new Map<string, FileDraft>())
  const [hasDraft, setHasDraft] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>({ phase: 'idle' })

  // A one-shot handoff (viewRequest/completeViewRequest): acknowledge
  // immediately so a second open of the same path (a re-click while already
  // showing it) still notifies through file-opener.ts's seq-keyed request.
  useEffect(() => {
    if (openFileFocus === null) return
    setOpenedPath(openFileFocus.path)
    setOpenedWorkspaceId(openFileFocus.workspaceId)
    completeViewRequest()
  }, [openFileFocus, completeViewRequest])

  const kind = openedPath === null ? 'external' : viewerKindFor(openedPath)

  // A newly opened path always starts in plain-view mode with a clean save
  // state — deliberately keyed on `openedPath` alone, not `refreshToken`: a
  // post-save refresh (below) must re-fetch git status without kicking the
  // tab back to View or clobbering the just-cleared save/draft state.
  useEffect(() => {
    setMode('view')
    setSaveState({ phase: 'idle' })
    setHasDraft(openedPath !== null && draftsRef.current.has(openedPath))
  }, [openedPath])

  // Whether the Diff toggle even shows depends on this fetch, one shot per
  // open (not a live subscription — the tree's own explicit-refresh control
  // is the precedent for keeping this in step with a background repo
  // change). `refreshToken` re-runs the same fetch once after a successful
  // save, so the toggle reflects the just-written content.
  useEffect(() => {
    setChanged(false)
    if (openedPath === null) return
    const controller = new AbortController()
    getGitStatus(openedWorkspaceId, controller.signal).then((status) => {
      if (controller.signal.aborted) return
      setChanged(Object.hasOwn(status.files, openedPath))
    }).catch(() => {
      // Git status here is an affordance signal, not required content: a
      // failure (e.g. the session has no owning workspace) just keeps the
      // Diff toggle hidden rather than surfacing an error.
    })
    return () => { controller.abort() }
  }, [openedPath, openedWorkspaceId, getGitStatus, refreshToken])

  // The diff itself is fetched lazily, only once the user switches into
  // Diff mode — not on every plain-view open. `refreshToken` re-runs it once
  // after a save while already in Diff mode.
  useEffect(() => {
    if (mode !== 'diff' || openedPath === null) return
    setDiffState({ phase: 'loading' })
    const controller = new AbortController()
    getFileDiff(openedWorkspaceId, openedPath, controller.signal).then((diff) => {
      if (controller.signal.aborted) return
      setDiffState({ phase: 'ready', diff })
    }).catch(() => {
      if (controller.signal.aborted) return
      setDiffState({ phase: 'error' })
    })
    return () => { controller.abort() }
  }, [mode, openedPath, openedWorkspaceId, getFileDiff, refreshToken])

  useEffect(() => {
    if (openedPath === null) return
    setState({ phase: 'loading' })
    setVersion(null)
    // External-viewer files (PDF, unrecognized extensions) never fetch
    // content at all: the tab's only action is the OS handoff.
    if (viewerKindFor(openedPath) === 'external') return
    const controller = new AbortController()
    let createdUrl: string | null = null
    readFile(openedWorkspaceId, openedPath, controller.signal).then((content) => {
      if (controller.signal.aborted) return
      if (content.kind === 'text') {
        setState({ phase: 'ready', content: { kind: 'text', text: content.content } })
        setVersion(content.version)
        return
      }
      if (viewerKindFor(openedPath) === 'image') {
        createdUrl = decodeBlobUrl(content.data, content.mediaType)
        setState({ phase: 'ready', content: { kind: 'binary', blobUrl: createdUrl } })
      } else {
        setState({ phase: 'ready', content: { kind: 'binary', blobUrl: null } })
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setState(stateFromError(error))
    })
    return () => {
      controller.abort()
      if (createdUrl !== null) URL.revokeObjectURL(createdUrl)
    }
  }, [openedPath, openedWorkspaceId, readFile, reloadToken])

  // Records every keystroke into the current path's draft, forked from the
  // version the buffer was seeded at (the read's version, or the prior
  // draft's — never re-derived per keystroke, only at fork time).
  const handleEditChange = useCallback((text: string) => {
    if (openedPath === null) return
    const baseVersion = draftsRef.current.get(openedPath)?.version ?? version
    if (baseVersion === null) return
    draftsRef.current.set(openedPath, { text, version: baseVersion })
    setHasDraft(true)
  }, [openedPath, version])

  const handleSave = useCallback(() => {
    if (openedPath === null) return
    const draft = draftsRef.current.get(openedPath)
    if (draft === undefined) return
    setSaveState({ phase: 'saving' })
    writeFile(openedWorkspaceId, openedPath, draft.text, draft.version).then((nextVersion) => {
      draftsRef.current.delete(openedPath)
      setHasDraft(false)
      setSaveState({ phase: 'idle' })
      setVersion(nextVersion)
      setState({ phase: 'ready', content: { kind: 'text', text: draft.text } })
      setRefreshToken(token => token + 1)
    }).catch((error: unknown) => {
      const conflict = error instanceof Error && error.name === 'WorkspaceFileBrowseError'
        && (error as WorkspaceFileBrowseError).rpcError.code === 'file-changed'
      setSaveState({ phase: conflict ? 'conflict' : 'error' })
    })
  }, [openedPath, openedWorkspaceId, writeFile])

  // Discards the current draft and re-fetches the path fresh — the
  // conflict notice's recovery action, since a version mismatch means the
  // draft's base is no longer valid to save over.
  const handleDiscardAndReload = useCallback(() => {
    if (openedPath === null) return
    draftsRef.current.delete(openedPath)
    setHasDraft(false)
    setSaveState({ phase: 'idle' })
    setMode('view')
    setReloadToken(token => token + 1)
  }, [openedPath])

  if (openedPath === null) {
    return <div className={css.empty}>{t('files.empty')}</div>
  }

  // A binary read where the classified kind expected text (a mismatched
  // extension on real binary content) offers the same external-open
  // fallback as too-large/error/genuinely-external — mirrors FileViewer's
  // showsExternalOnly (ui-workspace's own Modal-based viewer).
  const binaryMismatch = state.phase === 'ready' && state.content.kind === 'binary' && kind !== 'image'
  const showsExternalOnly = kind === 'external' || state.phase === 'error' || state.phase === 'too-large' || binaryMismatch

  const showsDiffToggle = kind === 'text' && changed
  const readyText = state.phase === 'ready' && state.content.kind === 'text' ? state.content.text : null
  const showsEditToggle = (kind === 'text' || kind === 'markdown') && readyText !== null
  const sameText = diffState.phase === 'ready' && diffState.diff.oldText === diffState.diff.newText
  const draft = draftsRef.current.get(openedPath)
  const editorText = draft?.text ?? readyText ?? ''

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.path}>
          {openedPath}
          {hasDraft && <span className={css.unsaved} aria-hidden> •</span>}
        </span>
        <div className={css.headerActions}>
          {mode === 'edit' && (
            <>
              {saveState.phase === 'conflict' && (
                <span className={css.conflict} role="alert">
                  {t('files.edit.conflict')}
                  {' '}
                  <button type="button" className={css.conflictReload} onClick={handleDiscardAndReload}>
                    {t('files.edit.reload')}
                  </button>
                </span>
              )}
              {saveState.phase === 'error' && <span className={css.conflict} role="alert">{t('files.edit.saveError')}</span>}
              <Button variant="primary" size="sm" disabled={!hasDraft || saveState.phase === 'saving'} onClick={handleSave}>
                {saveState.phase === 'saving' ? t('files.edit.saving') : t('files.edit.save')}
              </Button>
            </>
          )}
          {(showsDiffToggle || showsEditToggle) && (
            <div className={css.modeToggle}>
              <Button variant={mode === 'view' ? 'primary' : 'ghost'} size="sm" onClick={() => { setMode('view') }}>
                {t('files.diff.view')}
              </Button>
              {showsEditToggle && (
                <Button variant={mode === 'edit' ? 'primary' : 'ghost'} size="sm" onClick={() => { setMode('edit') }}>
                  {t('files.edit.edit')}
                </Button>
              )}
              {showsDiffToggle && (
                <Button variant={mode === 'diff' ? 'primary' : 'ghost'} size="sm" onClick={() => { setMode('diff') }}>
                  {t('files.diff.diff')}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      {mode === 'diff' && (
        <div className={css.body}>
          {diffState.phase === 'loading' && <p className={css.diffNotice}>{t('files.viewer.loading')}</p>}
          {diffState.phase === 'error' && <p className={css.diffNotice} role="alert">{t('files.viewer.loadError')}</p>}
          {diffState.phase === 'ready' && (
            sameText
              ? <p className={css.diffNotice}>{t('files.diff.empty')}</p>
              : (
                <SideBySideDiff
                  path={openedPath}
                  oldText={diffState.diff.oldText}
                  newText={diffState.diff.newText}
                  labels={diffLabels}
                />
              )
          )}
        </div>
      )}
      {mode === 'edit' && showsEditToggle && (
        <FileEditor
          key={openedPath}
          path={openedPath}
          text={editorText}
          kind={kind === 'markdown' ? 'markdown' : 'text'}
          labels={filePreviewLabels.markdown}
          resizeLabels={editorResizeLabels}
          onChange={handleEditChange}
          onSaveRequested={handleSave}
          className={css.body}
        />
      )}
      {mode === 'view' && (
        <FilePreview
          className={css.body}
          path={openedPath}
          kind={kind}
          state={state}
          lang={langFromPath(openedPath)}
          labels={filePreviewLabels}
          loadingLabel={t('files.viewer.loading')}
          loadErrorLabel={t('files.viewer.loadError')}
          externalLabel={t('files.viewer.openExternally')}
          tooLargeLabel={maxMB => t('files.viewer.tooLarge', { maxMB })}
        />
      )}
      {mode === 'view' && showsExternalOnly && (
        <div className={css.footer}>
          <Button variant="outline" onClick={() => { void openPath(openedPath) }}>
            {t('files.viewer.openExternally')}
          </Button>
        </div>
      )}
    </div>
  )
}
