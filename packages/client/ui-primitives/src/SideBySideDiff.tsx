// SideBySideDiff: a git-style two-column diff — HEAD content on the left,
// working-tree content on the right, each with its own line-number gutter —
// for the File tab's dedicated diff view (as opposed to DiffBlock's stacked
// removed-then-added chat card). Unlike DiffBlock/ReadBlock this shows the
// WHOLE file, not a context-limited hunk or a height-capped window: it is
// already the file's own dedicated view, so there is nothing to collapse.
// No syntax highlighting, matching DiffBlock's own choice for the same
// reason: a diff's meaning-carrying color (removed/added) already competes
// for the reader's attention. Colors resolve through --dsw-* tokens.

import { useCallback, useMemo, useState } from 'react'
import clsx from 'clsx'
import { diffLines } from 'diff'
import { writeClipboard } from './clipboard.ts'
import css from './SideBySideDiff.module.css'

/** One side's cell in a diff row: absent (no line here) is `number: null, text: null`. */
interface DiffCell {
  /** 1-based line number on this side, or `null` when this side has no line for this row. */
  number: number | null
  /** The line's text, or `null` when this side has no line for this row. */
  text: string | null
  /** Meaning-carrying tone: `del`/`add` paint the removed/added colors, `plain` is unchanged or absent. */
  tone: 'plain' | 'del' | 'add'
}

/** One aligned row: the old (HEAD) side and the new (working-tree) side, independently populated. */
interface DiffRow {
  old: DiffCell
  new: DiffCell
}

export interface SideBySideDiffProps {
  /** Banner label (the file path); omitted draws an empty label (the banner itself, and its copy control, always render). */
  path?: string | undefined
  /** Content at `HEAD`; `null` when the file has no committed blob at this path. */
  oldText: string | null
  /** Current working-tree content; `null` when the file no longer exists on disk. */
  newText: string | null
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/** Split a diff part's value into its content lines, dropping the line-terminating (not interior) trailing newline. */
function contentLines(text: string): string[] {
  /* v8 ignore next -- `diffLines` never emits an empty-string part: every hunk covers at least one line. */
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

const EMPTY_CELL: DiffCell = { number: null, text: null, tone: 'plain' }

/**
 * Align `oldText`/`newText` into row-paired cells: an unchanged block keeps
 * both sides in step; a removed block immediately followed by an added block
 * (a replacement) pairs their lines row-for-row, the longer side's excess
 * lines standing alone; any other removed-only or added-only block leaves the
 * other side blank for those rows.
 * @param oldText - HEAD content, `null` treated as empty (a new/untracked file).
 * @param newText - working-tree content, `null` treated as empty (a deleted file).
 * @returns the aligned rows, in file order.
 */
function buildRows(oldText: string | null, newText: string | null): DiffRow[] {
  const parts = diffLines(oldText ?? '', newText ?? '')
  const rows: DiffRow[] = []
  let oldNum = 1
  let newNum = 1
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    /* v8 ignore next -- `i < parts.length` guards the loop; this narrows the noUncheckedIndexedAccess type, not a real gap. */
    if (part === undefined) continue
    const next = parts[i + 1]
    if (part.removed && next?.added) {
      const removedLines = contentLines(part.value)
      const addedLines = contentLines(next.value)
      const pairCount = Math.max(removedLines.length, addedLines.length)
      for (let j = 0; j < pairCount; j++) {
        const oldLine = removedLines[j]
        const newLine = addedLines[j]
        rows.push({
          old: oldLine === undefined ? EMPTY_CELL : { number: oldNum++, text: oldLine, tone: 'del' },
          new: newLine === undefined ? EMPTY_CELL : { number: newNum++, text: newLine, tone: 'add' },
        })
      }
      i++ // the paired `added` part is consumed alongside `part`.
      continue
    }
    if (part.removed) {
      for (const line of contentLines(part.value)) {
        rows.push({ old: { number: oldNum++, text: line, tone: 'del' }, new: EMPTY_CELL })
      }
      continue
    }
    if (part.added) {
      for (const line of contentLines(part.value)) {
        rows.push({ old: EMPTY_CELL, new: { number: newNum++, text: line, tone: 'add' } })
      }
      continue
    }
    for (const line of contentLines(part.value)) {
      rows.push({
        old: { number: oldNum++, text: line, tone: 'plain' },
        new: { number: newNum++, text: line, tone: 'plain' },
      })
    }
  }
  return rows
}

/**
 * The diff text a reader copies: a unified `-`/`+`/` ` prefixed line per row
 * side, in file order — the same convention `DiffBlock`'s copy control uses.
 * @param rows - the aligned rows.
 * @returns the diff as plain text.
 */
function copyText(rows: readonly DiffRow[]): string {
  const lines: string[] = []
  for (const row of rows) {
    if (row.old.tone === 'plain' && row.old.text !== null) {
      lines.push(`  ${row.old.text}`)
      continue
    }
    if (row.old.text !== null) lines.push(`- ${row.old.text}`)
    if (row.new.text !== null) lines.push(`+ ${row.new.text}`)
  }
  return lines.join('\n')
}

const CELL_CLASS: Record<DiffCell['tone'], string | undefined> = {
  plain: undefined,
  del: css.del,
  add: css.add,
}

/**
 * Render one file's HEAD-vs-working-tree content as a two-column diff.
 * @param props - see {@link SideBySideDiffProps}.
 * @returns the diff element, or `null` when there is no content on either
 * side (both `oldText` and `newText` are `null` or empty) — an unchanged
 * file with content still renders its lines, all in the plain tone.
 */
export function SideBySideDiff({ path, oldText, newText, className }: SideBySideDiffProps) {
  const rows = useMemo(() => buildRows(oldText, newText), [oldText, newText])
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(copyText(rows)).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, rows])

  if (rows.length === 0) return null

  return (
    <div className={clsx(css.block, className)} data-side-by-side-diff="">
      <div className={css.banner}>
        <div className={css.label}>{path ?? ''}</div>
        <button type="button" className={css.copyButton} onClick={onCopy}>
          {copied ? '复制成功' : '复制'}
        </button>
      </div>
      <div className={css.body}>
        {rows.map((row, index) => (
          <div key={index} className={css.row}>
            <span className={css.gutter} aria-hidden>{row.old.number ?? ''}</span>
            <span className={clsx(css.content, CELL_CLASS[row.old.tone])}>{row.old.text ?? ''}</span>
            <span className={css.gutter} aria-hidden>{row.new.number ?? ''}</span>
            <span className={clsx(css.content, CELL_CLASS[row.new.tone])}>{row.new.text ?? ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
