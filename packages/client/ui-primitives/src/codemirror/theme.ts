/**
 * FileEditor's CodeMirror theme: colors resolve through the same `--dsw-*`
 * tokens `ReadBlock`/`SideBySideDiff` already use for the read-only file
 * surfaces, so the editing surface matches their light/dark appearance with
 * no separate theme plumbing.
 */

import { EditorView } from '@codemirror/view'

/** `FileEditor`'s CodeMirror theme extension; apply as one of the editor's `extensions`. */
export const editorTheme = EditorView.theme({
  '&': {
    color: 'var(--dsw-alias-label-primary)',
    backgroundColor: 'var(--dsw-alias-markdown-code-block)',
    height: '100%',
  },
  '.cm-content': {
    font: 'var(--dsw-font-markdown-code-block)',
    caretColor: 'var(--dsw-alias-label-primary)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--dsw-alias-label-primary)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--dsw-alias-markdown-code-block-banner)',
    color: 'var(--dsw-alias-label-tertiary)',
    border: 'none',
  },
  '.cm-scroller': {
    font: 'var(--dsw-font-markdown-code-block)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
})
