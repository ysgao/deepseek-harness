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
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, FilePreview } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilePreviewState } from '@deepseek-ai/dsh-client-ui-primitives'
import { WorkspaceFileBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceFileContent } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '../contract/slots.ts'
import { langFromPath, viewerKindFor } from './classify.ts'
import css from './FileView.module.css'

/** Injected share of the File view entry. */
export interface FileViewInjected {
  /** Read one file's content under the session's owning Workspace (fails when the session has none). */
  readFile: (path: string, signal?: AbortSignal) => Promise<WorkspaceFileContent>
  /** Open the file with the Host OS default application (the external-kind and error fallback). */
  openPath: (path: string) => Promise<void>
}

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
export function FileView({ openFilePath, onFileOpened, readFile, openPath, t }: FileViewProps) {
  const [openedPath, setOpenedPath] = useState<string | null>(null)
  const [state, setState] = useState<FilePreviewState>({ phase: 'loading' })

  // A one-shot handoff (openFilePath/onFileOpened): acknowledge immediately
  // so a second open of the same path (a re-click while already showing it)
  // still notifies through file-opener.ts's seq-keyed request.
  useEffect(() => {
    if (openFilePath === null || openFilePath === undefined) return
    setOpenedPath(openFilePath)
    onFileOpened?.()
  }, [openFilePath, onFileOpened])

  const kind = openedPath === null ? 'external' : viewerKindFor(openedPath)

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

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.path}>{openedPath}</span>
      </div>
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
      {showsExternalOnly && (
        <div className={css.footer}>
          <Button variant="outline" onClick={() => { void openPath(openedPath) }}>
            {t('files.viewer.openExternally')}
          </Button>
        </div>
      )}
    </div>
  )
}
