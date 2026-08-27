/**
 * Host-side git status for the Web GUI's Files tree: current branch and
 * pending-change file classification, scanned from the git repository
 * enclosing a workspace's own directory (which may be an ancestor of it).
 * Shells out to the host's own `git` binary; there is no bundled git
 * implementation. A directory outside any working tree, or a host with no
 * `git` binary at all, both resolve as `isRepo: false` rather than a thrown
 * error — this module never distinguishes "not a repo" from "can't tell".
 * @module
 */

import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { WorkspaceGitStatus } from './api/workspace.ts'

const execFileAsync = promisify(execFile)

/** Porcelain v1 status-record prefix width (`XY` + one space) before the path field starts. */
const STATUS_PREFIX_LENGTH = 3

/**
 * Single display code for one porcelain `XY` pair: the staged (index) letter
 * when set, else the worktree letter, else `U` for an untracked (`??`) entry.
 * @param xy - the two-character porcelain status code.
 * @returns one of `M`/`A`/`D`/`R`/`C`/`U`.
 */
function classify(xy: string): string {
  if (xy === '??') return 'U'
  const staged = xy.slice(0, 1)
  return staged !== ' ' ? staged : xy.slice(1, 2)
}

/**
 * Parses NUL-terminated `git status --porcelain=v1 -z` output into an
 * absolute-path status map. `-z` reports every path verbatim, byte-for-byte
 * — unlike the default LF-terminated form, it never C-style-quotes a path,
 * which sidesteps re-decoding a quoted non-ASCII (e.g. Chinese) filename. A
 * rename/copy record is two consecutive NUL-terminated fields (new path,
 * then original path); only the new path — the one the Files tree currently
 * shows — is recorded.
 * @param stdout - raw NUL-terminated porcelain output, repo-root-relative paths.
 * @param repoRoot - absolute repository root the paths are relative to.
 * @returns absolute path -> single-letter status code.
 */
function parsePorcelain(stdout: string, repoRoot: string): Record<string, string> {
  const files: Record<string, string> = {}
  const fields = stdout.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]
    if (record === undefined || record === '') continue
    const xy = record.slice(0, 2)
    files[resolve(repoRoot, record.slice(STATUS_PREFIX_LENGTH))] = classify(xy)
    if (xy.includes('R') || xy.includes('C')) i++ // skip the paired original-path field
  }
  return files
}

/**
 * Reports one workspace's git branch and pending file changes, scanned from
 * the git repository enclosing `path` (its own directory, or an ancestor of
 * it). A directory outside any working tree, or a host missing the `git`
 * binary, reports `isRepo: false`.
 * @param path - workspace's own directory (absolute).
 * @param signal - caller lifetime; abort rejects with the abort reason.
 * @returns the workspace's git status.
 */
export async function workspaceGitStatus(path: string, signal?: AbortSignal): Promise<WorkspaceGitStatus> {
  let repoRoot: string
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { signal })
    repoRoot = stdout.trim()
  } catch (error: unknown) {
    // An abort must propagate (the caller reports cancelled), not collapse
    // into the ordinary "not a repo" result.
    if (signal?.aborted) throw error
    return { isRepo: false, branch: null, files: {} }
  }
  const [branch, { stdout: statusOut }] = await Promise.all([
    currentBranch(repoRoot, signal),
    execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { signal }),
  ])
  return { isRepo: true, branch, files: parsePorcelain(statusOut, repoRoot) }
}

/**
 * The repository's current branch name. `symbolic-ref` (not `rev-parse
 * --abbrev-ref`) reads HEAD's ref target directly, so it resolves on an
 * unborn branch (a fresh repository with no commits yet) the same as one
 * with history; `rev-parse --abbrev-ref HEAD` fails on an unborn branch
 * because it has no commit to resolve. A detached HEAD (points at a commit,
 * not a ref) has no branch name — reported as the literal `"HEAD"`, git's
 * own convention.
 * @param repoRoot - absolute repository root.
 * @param signal - caller lifetime; abort rejects with the abort reason.
 * @returns the branch name, or `"HEAD"` when detached.
 */
async function currentBranch(repoRoot: string, signal: AbortSignal | undefined): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'symbolic-ref', '--short', 'HEAD'], { signal })
    return stdout.trim()
  } catch (error: unknown) {
    /* v8 ignore next -- needs the caller signal to abort in the narrow window
       between the repo-root check settling and this call settling; not
       reliably raceable in a portable test (see the sibling guard above,
       covered directly since its abort can be set before the call starts). */
    if (signal?.aborted) throw error
    return 'HEAD'
  }
}
