/**
 * Shared file-content preview body: text/code (line-numbered, syntax-
 * highlighted through {@link ReadBlock}), Markdown (rendered through
 * {@link MarkdownText}), or an image (a caller-supplied blob URL shown
 * inline). Every other kind — external (PDF, unrecognized extension),
 * too-large, error, or a binary read whose classified kind expected text
 * (a mismatched extension on real binary content) — renders a one-line
 * notice. Pure presentation: the caller resolves its own fetch/classify
 * concepts (workspace file read, tool read result, or any other file
 * source) into {@link FilePreviewState} and {@link FilePreviewKind} before
 * rendering this component, so it carries no host- or domain-specific
 * vocabulary (no wire error types, no workspace RPC shapes).
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { MarkdownText } from './markdown/MarkdownText.tsx'
import { ReadBlock } from './ReadBlock.tsx'
import type { ReadBlockLine } from './ReadBlock.tsx'
import css from './FilePreview.module.css'

/** Which body a file path selects (mirrors the caller's own extension classification). */
export type FilePreviewKind = 'markdown' | 'image' | 'text' | 'external'

/** Fetch/decode outcome for the currently previewed path, caller-resolved. */
export type FilePreviewState =
  | { phase: 'loading' }
  | { phase: 'ready'; content: { kind: 'text'; text: string } | { kind: 'binary'; blobUrl: string | null } }
  | { phase: 'too-large'; maxBytes: number }
  | { phase: 'error' }

export interface FilePreviewProps {
  /** Display path (ReadBlock's banner label; also the image `alt` text unless `imageAlt` overrides it). */
  path: string
  /** Which body renders the content ('image' expects a `binary` ready state's blobUrl). */
  kind: FilePreviewKind
  /** Fetch/decode state; ignored while `kind === 'external'` (the caller need not fetch at all). */
  state: FilePreviewState
  /** shiki grammar hint for the text body; unknown or absent renders plain monospace. */
  lang?: string | undefined
  /** Image `alt` text; defaults to `path` (a caller wanting just the basename passes it explicitly). */
  imageAlt?: string | undefined
  loadingLabel: string
  loadErrorLabel: string
  externalLabel: string
  tooLargeLabel: (maxMB: number) => string
  /** Extra class merged onto the scrolling body wrapper. */
  className?: string | undefined
}

/** Split text into `ReadBlock` lines, 1-based file line numbers. */
function toReadBlockLines(text: string): ReadBlockLine[] {
  // A trailing newline must not manufacture a phantom empty final line: a
  // file ending in "\n" splits to N lines of real content, not N+1.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  if (body === '') return []
  return body.split('\n').map((line, index) => ({ number: index + 1, text: line }))
}

/**
 * Render the file-preview body for the resolved kind and fetch state.
 * @param props - see {@link FilePreviewProps}.
 * @returns the body element (a notice, a rendered image, Markdown, or a `ReadBlock`).
 */
export function FilePreview({
  path, kind, state, lang, imageAlt, loadingLabel, loadErrorLabel, externalLabel, tooLargeLabel, className,
}: FilePreviewProps) {
  // A binary read where the classified kind expected text (a mismatched
  // extension on real binary content) falls back the same way an
  // over-the-bound file or a genuinely external kind does.
  const binaryMismatch = state.phase === 'ready' && state.content.kind === 'binary' && kind !== 'image'

  const lines = useMemo(() => {
    if (kind !== 'text' || state.phase !== 'ready' || state.content.kind !== 'text') return null
    return toReadBlockLines(state.content.text)
  }, [kind, state])

  let body: ReactNode
  if (kind === 'external') {
    body = <p className={css.notice}>{externalLabel}</p>
  } else if (state.phase === 'loading') {
    body = <p className={css.notice}>{loadingLabel}</p>
  } else if (state.phase === 'error' || binaryMismatch) {
    body = <p className={css.notice} role="alert">{loadErrorLabel}</p>
  } else if (state.phase === 'too-large') {
    body = <p className={css.notice} role="alert">{tooLargeLabel(Math.round(state.maxBytes / (1024 * 1024)))}</p>
  } else if (kind === 'image') {
    const blobUrl = state.content.kind === 'binary' ? state.content.blobUrl : null
    body = blobUrl === null
      ? <p className={css.notice}>{loadingLabel}</p>
      : <img className={css.image} src={blobUrl} alt={imageAlt ?? path} />
  } else if (kind === 'markdown' && state.content.kind === 'text') {
    body = <MarkdownText text={state.content.text} />
  } else {
    // Reached only for kind === 'text' with a text read: a binary read here
    // would already have taken the binaryMismatch branch above (kind !==
    // 'image' covers 'markdown' and 'text' alike), so `lines` is non-null.
    /* v8 ignore next -- the false arm is unreachable per the comment above; only TypeScript's narrowing needs it. */
    body = <ReadBlock label={path} lines={lines ?? []} totalLines={(lines ?? []).length} lang={lang} />
  }

  return <div className={className ?? css.body}>{body}</div>
}
