/**
 * In-app preview modal for one Workspace file: text/code (line-numbered,
 * syntax-highlighted through `ReadBlock`), Markdown (rendered through the
 * shared `MarkdownText`), or an image (decoded to a blob URL and shown
 * inline). Every other extension — PDF included, a deferred follow-up — a
 * file whose classified kind disagrees with the Host's own UTF-8 decode (a
 * mismatched extension on real binary content), and a file whose read fails
 * with `file-too-large` all fall back to a single "Open with default app"
 * action wired to `openPath` (the Host OS-default handoff, the same
 * primitive the Files tree used before this viewer existed).
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, MarkdownText, Modal, ReadBlock, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReadBlockLine } from '@deepseek-ai/dsh-client-ui-primitives'
import { WorkspaceFileBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceFileContent } from '@deepseek-ai/dsh-client-runtime/client'
import { langFromPath, viewerKindFor } from './classify.ts'
import type { WorkspaceKey } from '../locales.ts'
import css from './FileViewer.module.css'

/** The standard locale seat this viewer consumes (a slice of the browser's full namespace). */
type FileViewerTranslate = (key: WorkspaceKey, vars?: Record<string, string | number>) => string

export interface FileViewerProps {
  /** The file to preview; the dialog is open exactly while this is set. */
  path: string | null
  /** Read the file's content (workspace-scoped, size-bounded on the Host). */
  readFile: (path: string, signal?: AbortSignal) => Promise<WorkspaceFileContent>
  /** Open the file with the Host OS default application. */
  openPath: (path: string) => Promise<void>
  /** Close the preview (mask, Escape, close control, or the external-open action). */
  onClose: () => void
  t: FileViewerTranslate
}

/** Basename of a path for the dialog title, both separators accepted. */
function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) || path
}

/** Split text into `ReadBlock` lines, 1-based file line numbers. */
function toReadBlockLines(text: string): ReadBlockLine[] {
  // A trailing newline must not manufacture a phantom empty final line: a
  // file ending in "\n" splits to N lines of real content, not N+1.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  if (body === '') return []
  return body.split('\n').map((line, index) => ({ number: index + 1, text: line }))
}

/** Decode base64 wire bytes to a revocable blob URL for `<img>`; null input yields no URL. */
function useBlobUrl(base64: string | null, mediaType: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (base64 === null || mediaType === undefined) {
      setUrl(null)
      return
    }
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const created = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
    setUrl(created)
    return () => { URL.revokeObjectURL(created) }
  }, [base64, mediaType])
  return url
}

/** Fetch state for the currently previewed path. */
type FetchState =
  | { phase: 'loading' }
  | { phase: 'ready'; content: WorkspaceFileContent }
  | { phase: 'too-large'; maxBytes: number }
  | { phase: 'error' }

/** Resolve one readFile rejection into the state its cause distinguishes. */
function stateFromError(error: unknown): FetchState {
  if (error instanceof WorkspaceFileBrowseError && error.rpcError.code === 'file-too-large') {
    return { phase: 'too-large', maxBytes: error.rpcError.details.maxBytes }
  }
  return { phase: 'error' }
}

/**
 * Render the file-preview dialog.
 * @param props - see {@link FileViewerProps}.
 * @returns the dialog element (renders nothing while `path` is null, via `Modal`).
 */
export function FileViewer({ path, readFile, openPath, onClose, t }: FileViewerProps) {
  const [state, setState] = useState<FetchState>({ phase: 'loading' })
  const kind = useMemo(() => (path === null ? 'external' : viewerKindFor(path)), [path])

  useEffect(() => {
    if (path === null) return
    setState({ phase: 'loading' })
    // External-viewer files (PDF, unrecognized extensions) never fetch
    // content at all: the dialog's only action is the OS handoff.
    if (viewerKindFor(path) === 'external') return
    const controller = new AbortController()
    readFile(path, controller.signal).then((content) => {
      if (controller.signal.aborted) return
      setState({ phase: 'ready', content })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setState(stateFromError(error))
    })
    return () => { controller.abort() }
  }, [path, readFile])

  const binaryBase64 = state.phase === 'ready' && state.content.kind === 'binary' ? state.content.data : null
  const binaryMediaType = state.phase === 'ready' && state.content.kind === 'binary' ? state.content.mediaType : undefined
  const imageUrl = useBlobUrl(kind === 'image' ? binaryBase64 : null, binaryMediaType)

  const [copied, setCopied] = useState(false)
  const onCopy = (text: string): void => {
    if (copied) return
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }

  if (path === null) return null

  // A binary read where the classified kind expected text (a mismatched
  // extension on real binary content) falls back the same way an
  // over-the-bound file or a genuinely external kind does.
  const binaryMismatch = state.phase === 'ready' && state.content.kind === 'binary' && kind !== 'image'
  const showsExternalOnly = kind === 'external' || state.phase === 'error' || state.phase === 'too-large' || binaryMismatch

  let body: ReactNode
  if (kind === 'external') {
    body = <p className={css.notice}>{t('files.viewer.openExternally')}</p>
  } else if (state.phase === 'loading') {
    body = <p className={css.notice}>{t('files.viewer.loading')}</p>
  } else if (state.phase === 'error' || binaryMismatch) {
    body = <p className={css.notice} role="alert">{t('files.viewer.loadError')}</p>
  } else if (state.phase === 'too-large') {
    body = <p className={css.notice} role="alert">{t('files.viewer.tooLarge', { maxMB: Math.round(state.maxBytes / (1024 * 1024)) })}</p>
  } else if (kind === 'image') {
    body = imageUrl === null
      ? <p className={css.notice}>{t('files.viewer.loading')}</p>
      : <img className={css.image} src={imageUrl} alt={basename(path)} />
  } else if (kind === 'markdown' && state.content.kind === 'text') {
    body = <MarkdownText text={state.content.content} />
  } else {
    // Reached only for kind === 'text' with a text read: a binary read here
    // would already have taken the binaryMismatch branch above (kind !==
    // 'image' covers 'markdown' and 'text' alike), so state.content.kind is
    // guaranteed 'text'. TypeScript still requires the narrowing check.
    /* v8 ignore next -- the false arm is unreachable per the comment above; only TypeScript's narrowing needs it. */
    const lines = state.content.kind === 'text' ? toReadBlockLines(state.content.content) : []
    body = <ReadBlock label={path} lines={lines} totalLines={lines.length} lang={langFromPath(path)} />
  }

  const footer = showsExternalOnly
    ? (
      <Button variant="outline" onClick={() => { void openPath(path); onClose() }}>
        {t('files.viewer.openExternally')}
      </Button>
    )
    : state.phase === 'ready' && state.content.kind === 'text' && kind === 'text'
      ? (
        <Button
          variant="outline"
          onClick={() => {
            /* v8 ignore next -- narrowing guard: the outer ternary already required state.content.kind === 'text' to reach this button. */
            if (state.content.kind === 'text') onCopy(state.content.content)
          }}
        >
          {copied ? t('files.viewer.copied') : t('files.viewer.copy')}
        </Button>
      )
      : undefined

  return (
    <Modal open onClose={onClose} title={basename(path)} closeLabel={t('files.viewer.close')} footer={footer}>
      <div className={css.body}>{body}</div>
    </Modal>
  )
}
