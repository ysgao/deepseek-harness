/**
 * In-app text editor for the File tab: a CodeMirror 6 buffer, with a live
 * rendered Markdown preview pane alongside it for `kind: 'markdown'`. Deliberately
 * uncontrolled after mount — `text`/`kind` seed the initial buffer only; a
 * caller wanting a fresh buffer for a different file remounts by keying on
 * the file's path (CodeMirror, not React, then owns the buffer, undo
 * history, and cursor/selection for that file's lifetime). Every change
 * reports upward through `onChange`; save/dirty/error chrome is the
 * caller's concern (FileView owns the Save button and Cmd/Ctrl+S binding
 * that reads the caller's own committed buffer, not this component's).
 *
 * No per-language syntax highlighting while editing: the app's one syntax
 * highlighter (`markdown/highlight.ts`, shiki-based) already covers the
 * read-only preview (`ReadBlock`/`FilePreview`'s View mode) for every
 * language `langFromPath` recognizes, so duplicating that coverage with a
 * second, CodeMirror-native grammar per language would double the
 * highlighting surface for no reader-facing gain while editing — a
 * deliberate scope line, not an oversight (see the owning Agent Note). The
 * editing surface is undecorated monospace; only Markdown gets Structure-
 * aware editing (`@codemirror/lang-markdown`, for list/blockquote
 * continuation) because it is the one kind with a live preview pane to
 * justify the extra package.
 */

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import clsx from 'clsx'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { MarkdownText } from './markdown/MarkdownText.tsx'
import { editorTheme } from './codemirror/theme.ts'
import { useSplitRatio } from './useSplitRatio.ts'
import css from './FileEditor.module.css'

/** `--ds-file-editor-ratio` holds a unitless number read back by {@link FileEditor.module.css}'s `calc()` column widths. */
type SplitRootStyle = CSSProperties & { '--ds-file-editor-ratio': number }

/** Debounce between a keystroke and the Markdown preview pane re-rendering it. */
const MARKDOWN_PREVIEW_DEBOUNCE_MS = 150

export interface FileEditorProps {
  /** Display path; not read by this component today, kept for parity with the other file-surface primitives and future banner use. */
  path: string
  /** Initial buffer content — read once, at mount, then owned by CodeMirror. */
  text: string
  /** `'markdown'` adds the live preview pane and Markdown-aware editing; `'text'` is a single plain-monospace pane. */
  kind: 'text' | 'markdown'
  /** Called with the full buffer content after every edit. */
  onChange: (text: string) => void
  /**
   * Bound to Cmd/Ctrl+S while the editor has focus (suppresses the browser's
   * own save-page dialog); omitted leaves the shortcut unhandled here.
   */
  onSaveRequested?: () => void
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/**
 * Render the CodeMirror buffer (and, for Markdown, its live preview pane).
 * @param props - see {@link FileEditorProps}.
 * @returns the editor element.
 */
export function FileEditor({ text, kind, onChange, onSaveRequested, className }: FileEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRequestedRef = useRef(onSaveRequested)
  onSaveRequestedRef.current = onSaveRequested
  const [previewText, setPreviewText] = useState(kind === 'markdown' ? text : '')
  const { ratio, dividerProps } = useSplitRatio()

  useEffect(() => {
    const host = hostRef.current
    // The ref is always attached by the time this effect runs (the div it
    // targets renders unconditionally, see below); nothing in a portable
    // test can leave it null.
    /* v8 ignore next */
    if (host === null) return
    let previewTimer: number | undefined
    const extensions = [
      lineNumbers(),
      history(),
      keymap.of([
        { key: 'Mod-s', run: () => { onSaveRequestedRef.current?.(); return true } },
        indentWithTab,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.lineWrapping,
      editorTheme,
      ...(kind === 'markdown' ? [markdown()] : []),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const next = update.state.doc.toString()
        onChangeRef.current(next)
        if (kind === 'markdown') {
          window.clearTimeout(previewTimer)
          previewTimer = window.setTimeout(() => { setPreviewText(next) }, MARKDOWN_PREVIEW_DEBOUNCE_MS)
        }
      }),
    ]
    const view = new EditorView({ state: EditorState.create({ doc: text, extensions }), parent: host })
    return () => {
      window.clearTimeout(previewTimer)
      view.destroy()
    }
    // Mount-once: `text`/`kind` seed the initial buffer only (see the
    // component doc comment) — CodeMirror owns the document from here.
  }, [])

  const splitStyle: SplitRootStyle | undefined = kind === 'markdown'
    ? { '--ds-file-editor-ratio': ratio }
    : undefined

  return (
    <div
      className={clsx(kind === 'markdown' ? css.splitRoot : css.root, className)}
      style={splitStyle}
    >
      <div className={css.editorPane} ref={hostRef} />
      {kind === 'markdown' && (
        <>
          <div
            className={css.divider}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize preview pane"
            tabIndex={0}
            title="Drag to resize. Double-click to reset."
            {...dividerProps}
          />
          <div className={css.previewPane}>
            <MarkdownText text={previewText} />
          </div>
        </>
      )}
    </div>
  )
}
