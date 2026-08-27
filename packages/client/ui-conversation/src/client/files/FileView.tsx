/**
 * The File view: an ordinary `conversation.view` tab (alongside Chat and
 * Trajectory) rendering the shared {@link FilePreview} body for the session's
 * latest opened path (`openFilePath`/`onFileOpened` owner props — see
 * `ConvViewOwnerProps`). Populated only through the `conversationFileOpener`
 * service (`file-opener.ts` + `apply.ts`); the tab itself renders a resting
 * notice while no path has ever been opened, mirroring the empty-state
 * posture of a fresh Chat view rather than hiding itself (a static tab-ring
 * list — see the conversation-view contract's own doc comment — so it is
 * always registered, not conditionally shown).
 *
 * A text-kind file with a pending git change (per `getGitStatus`) offers a
 * View/Diff toggle; Diff mode fetches `getFileDiff` lazily and renders
 * {@link SideBySideDiff} in place of the plain preview. Binary, markdown, and
 * image files stay out of scope for the toggle — a text-only diff, same as
 * `FilePreview`'s own PDF-preview posture, is a deferred follow-up, not a gap.
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, FilePreview, SideBySideDiff } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilePreviewState } from '@deepseek-ai/dsh-client-ui-primitives'
import { WorkspaceFileBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceFileContent, WorkspaceFileDiff, WorkspaceGitStatus } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '../contract/slots.ts'
import { langFromPath, viewerKindFor } from './classify.ts'
import css from './FileView.module.css'

/** Injected share of the File view entry. */
export interface FileViewInjected {
  /** Read one file's content under the session's owning Workspace (fails when the session has none). */
  readFile: (path: string, signal?: AbortSignal) => Promise<WorkspaceFileContent>
  /** Open the file with the Host OS default application (the external-kind and error fallback). */
  openPath: (path: string) => Promise<void>
  /** The session's owning Workspace's git branch and pending file changes (decides whether the Diff toggle shows). */
  getGitStatus: (signal?: AbortSignal) => Promise<WorkspaceGitStatus>
  /** One file's `HEAD` and working-tree text, fetched lazily when the user switches to Diff mode. */
  getFileDiff: (path: string, signal?: AbortSignal) => Promise<WorkspaceFileDiff>
}

/** Which body the tab shows for the opened path: the plain preview, or the git diff. */
type FileViewMode = 'view' | 'diff'

/** Fetch state for the currently diffed path. */
type DiffFetchState =
  | { phase: 'loading' }
  | { phase: 'ready'; diff: WorkspaceFileDiff }
  | { phase: 'error' }

/** Full File-view component props: runtime & injected & locale seat. */
export type FileViewProps = ConvViewProps & InjectFace<FileViewInjected> & PropsLocale<'conversation'>

/** Decode base64 wire bytes to a revocable blob URL. */
function decodeBlobUrl(base64: string, mediaType: string): string {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return URL.createObjectURL(new Blob([bytes], { type: mediaType }))
}

/** Resolve one readFile rejection into the state its cause distinguishes. */
function stateFromError(error: unknown): FilePreviewState {
  if (error instanceof WorkspaceFileBrowseError && error.rpcError.code === 'file-too-large') {
    return { phase: 'too-large', maxBytes: error.rpcError.details.maxBytes }
  }
  return { phase: 'error' }
}

/**
 * Render the File view tab.
 * @param props - see {@link FileViewProps}.
 * @returns the tab's body element.
 */
export function FileView({ openFilePath, onFileOpened, readFile, openPath, getGitStatus, getFileDiff, t }: FileViewProps) {
  const [openedPath, setOpenedPath] = useState<string | null>(null)
  const [state, setState] = useState<FilePreviewState>({ phase: 'loading' })
  const [mode, setMode] = useState<FileViewMode>('view')
  const [changed, setChanged] = useState(false)
  const [diffState, setDiffState] = useState<DiffFetchState>({ phase: 'loading' })

  // A one-shot handoff (openFilePath/onFileOpened): acknowledge immediately
  // so a second open of the same path (a re-click while already showing it)
  // still notifies through file-opener.ts's seq-keyed request.
  useEffect(() => {
    if (openFilePath === null || openFilePath === undefined) return
    setOpenedPath(openFilePath)
    onFileOpened?.()
  }, [openFilePath, onFileOpened])

  const kind = openedPath === null ? 'external' : viewerKindFor(openedPath)

  // A newly opened path always starts in plain-view mode; whether the Diff
  // toggle even shows depends on this fetch, one shot per open (not a live
  // subscription — the tree's own explicit-refresh control is the precedent
  // for keeping this in step with a background repo change).
  useEffect(() => {
    setMode('view')
    setChanged(false)
    if (openedPath === null) return
    const controller = new AbortController()
    getGitStatus(controller.signal).then((status) => {
      if (controller.signal.aborted) return
      setChanged(Object.hasOwn(status.files, openedPath))
    }).catch(() => {
      // Git status here is an affordance signal, not required content: a
      // failure (e.g. the session has no owning workspace) just keeps the
      // Diff toggle hidden rather than surfacing an error.
    })
    return () => { controller.abort() }
  }, [openedPath, getGitStatus])

  // The diff itself is fetched lazily, only once the user switches into
  // Diff mode — not on every plain-view open.
  useEffect(() => {
    if (mode !== 'diff' || openedPath === null) return
    setDiffState({ phase: 'loading' })
    const controller = new AbortController()
    getFileDiff(openedPath, controller.signal).then((diff) => {
      if (controller.signal.aborted) return
      setDiffState({ phase: 'ready', diff })
    }).catch(() => {
      if (controller.signal.aborted) return
      setDiffState({ phase: 'error' })
    })
    return () => { controller.abort() }
  }, [mode, openedPath, getFileDiff])

  useEffect(() => {
    if (openedPath === null) return
    setState({ phase: 'loading' })
    // External-viewer files (PDF, unrecognized extensions) never fetch
    // content at all: the tab's only action is the OS handoff.
    if (viewerKindFor(openedPath) === 'external') return
    const controller = new AbortController()
    let createdUrl: string | null = null
    readFile(openedPath, controller.signal).then((content) => {
      if (controller.signal.aborted) return
      if (content.kind === 'text') {
        setState({ phase: 'ready', content: { kind: 'text', text: content.content } })
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
  }, [openedPath, readFile])

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
  const sameText = diffState.phase === 'ready' && diffState.diff.oldText === diffState.diff.newText

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.path}>{openedPath}</span>
        {showsDiffToggle && (
          <div className={css.modeToggle}>
            <Button variant={mode === 'view' ? 'primary' : 'ghost'} onClick={() => { setMode('view') }}>
              {t('files.diff.view')}
            </Button>
            <Button variant={mode === 'diff' ? 'primary' : 'ghost'} onClick={() => { setMode('diff') }}>
              {t('files.diff.diff')}
            </Button>
          </div>
        )}
      </div>
      {mode === 'diff'
        ? (
          <div className={css.body}>
            {diffState.phase === 'loading' && <p className={css.diffNotice}>{t('files.viewer.loading')}</p>}
            {diffState.phase === 'error' && <p className={css.diffNotice} role="alert">{t('files.viewer.loadError')}</p>}
            {diffState.phase === 'ready' && (
              sameText
                ? <p className={css.diffNotice}>{t('files.diff.empty')}</p>
                : <SideBySideDiff path={openedPath} oldText={diffState.diff.oldText} newText={diffState.diff.newText} />
            )}
          </div>
        )
        : (
          <FilePreview
            className={css.body}
            path={openedPath}
            kind={kind}
            state={state}
            lang={langFromPath(openedPath)}
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
