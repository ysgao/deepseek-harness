/**
 * Host-side git operations for the Web GUI's Files tree and File tab: status
 * (branch and pending-change classification), a file's `HEAD` content (for
 * the File tab's diff view), and the Commit-all/Discard-all/Pull-rebase/Push
 * write actions, all scanned or applied against the git repository enclosing
 * a workspace's own directory (which may be an ancestor of it). Shells out to
 * the host's own `git` binary via the shared {@link runNativeCommand} runner
 * (no-shell `execFile`, Windows console hide, abort propagation); there is no
 * bundled git implementation.
 *
 * `workspaceGitStatus` treats a directory outside any working tree, or a
 * host with no `git` binary at all, as `isRepo: false` rather than a thrown
 * error — it never distinguishes "not a repo" from "can't tell". The write
 * actions (`commitAllChanges`, `discardAllChanges`, `pullRebase`, `push`)
 * cannot use that same quiet fallback — a write the caller believes
 * succeeded must not silently no-op — so they throw
 * {@link GitNotARepositoryError} instead.
 * @module
 */

import { stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import type { WorkspaceGitStatus } from './types.ts'

/**
 * Run one `git` subcommand through the shared no-shell runner. `signal` stays
 * optional on every function in this module (an unset caller lifetime simply
 * never aborts); {@link runNativeCommand} itself requires a signal, so an
 * absent one is backed by a controller nothing ever triggers.
 * @param args - argv after `git` (never a shell string).
 * @param signal - caller lifetime; abort terminates the child and rejects with the abort reason.
 * @returns captured stdout/stderr on exit 0.
 */
function runGit(args: readonly string[], signal: AbortSignal | undefined): Promise<{ stdout: string; stderr: string }> {
  return runNativeCommand('git', args, signal ?? new AbortController().signal)
}

/** Thrown by a write action when its target directory is outside any git working tree. */
export class GitNotARepositoryError extends Error {
  /** @param path - the directory that was checked. */
  constructor(readonly path: string) {
    super(`"${path}" is not inside a git working tree`)
    this.name = 'GitNotARepositoryError'
  }
}

/** Thrown by a write action when the underlying git command exits non-zero (including a failing commit hook). */
export class GitCommandError extends Error {
  /**
   * @param command - short name of the failing step (`add`, `commit`, `reset`, `checkout`, `rebase-abort`, `pull`, `push`).
   * @param message - git's own stderr/stdout text.
   */
  constructor(readonly command: string, message: string) {
    super(message)
    this.name = 'GitCommandError'
  }
}

function messageOf(error: unknown): string {
  /* v8 ignore next -- every catch site here rejects with a real
     node:child_process Error; the String() fallback exists only for the
     `unknown` narrowing. */
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolves the git repository root enclosing `path` via `rev-parse
 * --show-toplevel`; the caller decides how to report a non-repository
 * (`workspaceGitStatus` collapses it to `isRepo: false`, the write actions
 * throw {@link GitNotARepositoryError}) — this helper only distinguishes an
 * abort (rethrown as-is) from every other failure (rethrown as a plain
 * `Error`, folded by the caller).
 * @param path - candidate directory (absolute).
 * @param signal - caller lifetime; abort rejects with the abort reason.
 * @returns the repository's absolute root path.
 * @throws when `path` is not inside a working tree, or the caller aborts.
 */
async function repoToplevel(path: string, signal: AbortSignal | undefined): Promise<string> {
  const { stdout } = await runGit(['-C', path, 'rev-parse', '--show-toplevel'], signal)
  return stdout.trim()
}

/** Porcelain v1 status-record prefix width (`XY` + one space) before the path field starts. */
const STATUS_PREFIX_LENGTH = 3

/**
 * The porcelain `XY` pairs marking an unmerged path (a rebase or merge
 * conflict), per `git-status`'s own documented table — every combination
 * pairing `D`/`A`/`U` with `U` (in either position), plus `AA`/`DD` for both
 * sides adding or deleting the same path.
 */
const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/**
 * Single display code for one porcelain `XY` pair: `X` for an unmerged
 * (conflicted) path, else the staged (index) letter when set, else the
 * worktree letter, else `U` for an untracked (`??`) entry. Checked before the
 * `??` test since neither shares a character with an unmerged pair.
 * @param xy - the two-character porcelain status code.
 * @returns one of `M`/`A`/`D`/`R`/`C`/`U`/`X`.
 */
function classify(xy: string): string {
  if (UNMERGED_CODES.has(xy)) return 'X'
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
    repoRoot = await repoToplevel(path, signal)
  } catch (error: unknown) {
    // An abort must propagate (the caller reports cancelled), not collapse
    // into the ordinary "not a repo" result.
    if (signal?.aborted) throw error
    return { isRepo: false, branch: null, files: {} }
  }
  const [branch, { stdout: statusOut }] = await Promise.all([
    currentBranch(repoRoot, signal),
    runGit(['-C', repoRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], signal),
  ])
  return { isRepo: true, branch, files: parsePorcelain(statusOut, repoRoot) }
}

/**
 * Stages every pending change — tracked and untracked alike — and commits
 * them with `message` to the git repository enclosing `path`.
 * @param path - workspace's own directory (absolute).
 * @param message - commit message (the caller/schema enforces non-blank).
 * @param signal - caller lifetime; abort rejects with the abort reason.
 * @throws {GitNotARepositoryError} when `path` is outside any git working tree.
 * @throws {GitCommandError} when `git add` or `git commit` exits non-zero
 * (a failing commit hook, no pending changes, no configured git identity, …).
 */
export async function commitAllChanges(path: string, message: string, signal?: AbortSignal): Promise<void> {
  const repoRoot = await repoRootOrThrow(path, signal)
  try {
    await runGit(['-C', repoRoot, 'add', '-A'], signal)
  } catch (error: unknown) {
    /* v8 ignore next -- needs the caller signal to abort in the narrow window
       between the repo-root check settling and this call settling; not
       reliably raceable in a portable test (see currentBranch's own guard). */
    if (signal?.aborted) throw error
    /* v8 ignore next -- `git add -A` fails only on a filesystem-permission or
       similar host condition; forcing one needs a platform-specific trick
       (chmod semantics differ enough across this suite's OS matrix) rather
       than a portable repro. */
    throw new GitCommandError('add', messageOf(error))
  }
  try {
    await runGit(['-C', repoRoot, 'commit', '-m', message], signal)
  } catch (error: unknown) {
    /* v8 ignore next -- same narrow-window rationale as the `add` catch above. */
    if (signal?.aborted) throw error
    throw new GitCommandError('commit', messageOf(error))
  }
}

/**
 * Whether `repoRoot` has a rebase currently in progress (conflicted or not) —
 * a `rebase-merge` or `rebase-apply` state directory present under `.git`,
 * git's own on-disk marker for "mid-rebase", checked via `rev-parse
 * --git-path` (which computes the path unconditionally, present or not)
 * rather than assuming the ordinary `.git/<name>` layout, since a worktree or
 * a relocated `$GIT_DIR` can move it. `--git-path` prints a path relative to
 * `repoRoot` (as `-C` puts it, not this process's own cwd) unless the git
 * directory lives elsewhere, so it is resolved against `repoRoot` before use
 * — `resolve()` leaves an already-absolute path (the relocated-`$GIT_DIR`
 * case) untouched.
 * @param repoRoot - absolute repository root.
 * @param signal - caller lifetime; abort rejects with the abort reason.
 * @returns whether a rebase is in progress.
 */
async function isRebaseInProgress(repoRoot: string, signal: AbortSignal | undefined): Promise<boolean> {
  const gitPaths = await Promise.all(['rebase-merge', 'rebase-apply'].map(async (name) => {
    const { stdout } = await runGit(['-C', repoRoot, 'rev-parse', '--git-path', name], signal)
    return resolve(repoRoot, stdout.trim())
  }))
  const present = await Promise.all(gitPaths.map(async (gitPath) => {
    try {
      await stat(gitPath)
      return true
    } catch {
      // ENOENT: this state directory is absent, i.e. no rebase of this kind.
      return false
    }
  }))
  return present.some(Boolean)
}

/**
 * Reverts every tracked file's pending change — staged or unstaged,
 * modified/added/deleted/renamed — to its `HEAD` content, in the git
 * repository enclosing `path`. An untracked file (never added to the index)
 * is left untouched: git has no copy of it to restore, so discarding it
 * would delete it permanently. Unstaging a newly `add`ed file (no `HEAD`
 * version) returns it to untracked rather than deleting it, for the same
 * reason — verified empirically, since `git restore --staged --worktree`
 * deletes such a file outright, unlike the `reset` + `checkout` pair used
 * here.
 *
 * When a prior {@link pullRebase} left the repository mid-rebase (a rebase
 * conflict), `HEAD` transiently points at the commit currently being
 * replayed, not the branch's own pre-rebase tip — a plain `reset` +
 * `checkout` would "discard" onto that transient commit and leave the branch
 * detached with the conflict markers untouched. This runs `git rebase
 * --abort` instead in that case, which is what "discard everything and
 * return to a clean state" actually means mid-rebase: it restores the
 * branch's pre-rebase tip and working tree in one step, undoing the
 * conflicted files along with it.
 * @param path - workspace's own directory (absolute).
 * @param signal - caller lifetime; abort rejects with the abort reason.
 * @throws {GitNotARepositoryError} when `path` is outside any git working tree.
 * @throws {GitCommandError} when `git rebase --abort` (mid-rebase) or
 * `git reset`/`git checkout` (otherwise) exits non-zero.
 */
export async function discardAllChanges(path: string, signal?: AbortSignal): Promise<void> {
  const repoRoot = await repoRootOrThrow(path, signal)
  if (await isRebaseInProgress(repoRoot, signal)) {
    try {
      await runGit(['-C', repoRoot, 'rebase', '--abort'], signal)
    } catch (error: unknown) {
      /* v8 ignore next -- same narrow-window rationale as commitAllChanges's own catch blocks. */
      if (signal?.aborted) throw error
      /* v8 ignore next -- `git rebase --abort` against a state directory this
         function just confirmed exists fails only on the same kind of host
         filesystem condition as `git add -A` above, not portably reproducible. */
      throw new GitCommandError('rebase-abort', messageOf(error))
    }
    return
  }
  try {
    await runGit(['-C', repoRoot, 'reset'], signal)
  } catch (error: unknown) {
    /* v8 ignore next -- same narrow-window rationale as commitAllChanges's own catch blocks. */
    if (signal?.aborted) throw error
    /* v8 ignore next -- `git reset` (no arguments, against an already-resolved
       repository root) fails only on the same kind of host filesystem
       condition as `git add -A` above, not portably reproducible. */
    throw new GitCommandError('reset', messageOf(error))
  }
  try {
    await runGit(['-C', repoRoot, 'checkout', '--', '.'], signal)
  } catch (error: unknown) {
    /* v8 ignore next -- same narrow-window rationale as commitAllChanges's own catch blocks. */
    if (signal?.aborted) throw error
    throw new GitCommandError('checkout', messageOf(error))
  }
}

/**
 * Fetches from the remote tracked by the current branch and rebases local
 * commits on top, in the git repository enclosing `path`.
 * @param path - workspace's own directory (absolute).
 * @param signal - caller lifetime; abort rejects with the abort reason.
 * @throws {GitNotARepositoryError} when `path` is outside any git working tree.
 * @throws {GitCommandError} when `git pull --rebase` exits non-zero (no
 * configured remote/upstream, a rebase conflict, network failure, …).
 */
export async function pullRebase(path: string, signal?: AbortSignal): Promise<void> {
  const repoRoot = await repoRootOrThrow(path, signal)
  try {
    await runGit(['-C', repoRoot, 'pull', '--rebase'], signal)
  } catch (error: unknown) {
    /* v8 ignore next -- needs the caller signal to abort in the narrow window
       between the repo-root check settling and this call settling; not
       reliably raceable in a portable test (see currentBranch's own guard). */
    if (signal?.aborted) throw error
    throw new GitCommandError('pull', messageOf(error))
  }
}

/**
 * The remote name the current branch pushes to, read from `branch.<name>.remote`.
 * Used to push an explicit `<remote> HEAD` refspec so the current branch is
 * the only one affected, independent of the host's `push.default`/
 * `remote.<name>.push` configuration. Undefined when the branch has no
 * configured remote — {@link push} then falls back to a bare `git push`,
 * which reports the same "no configured push destination" failure either way.
 * @param repoRoot - absolute repository root.
 * @param branch - the current branch name (never `"HEAD"`; the caller only
 * looks this up for a named branch).
 * @param signal - caller lifetime; abort rejects with the abort reason.
 * @returns the configured remote name, or undefined when none is set.
 */
async function currentRemote(repoRoot: string, branch: string, signal: AbortSignal | undefined): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['-C', repoRoot, 'config', '--get', `branch.${branch}.remote`], signal)
    const remote = stdout.trim()
    /* v8 ignore next -- `git config --get` on a present key returns its
       stored value; git rejects setting an empty remote name, so an empty
       success result is not reachable through ordinary config. */
    return remote === '' ? undefined : remote
  } catch (error: unknown) {
    /* v8 ignore next -- needs the caller signal to abort in the narrow window
       between the repo-root check settling and this call settling; not
       reliably raceable in a portable test (see currentBranch's own guard). */
    if (signal?.aborted) throw error
    // No `branch.<name>.remote` entry: `git config --get` exits 1 rather
    // than emitting an empty line, which lands here rather than the empty
    // string above.
    return undefined
  }
}

/**
 * Pushes the current branch to its configured remote, in the git repository
 * enclosing `path`. Resolves the branch's own remote and pushes an explicit
 * `<remote> HEAD` refspec rather than a bare `git push`, so only the current
 * branch is ever affected — a bare `git push`'s scope instead depends on the
 * host's `push.default`/`remote.<name>.push` configuration, which can push
 * every locally-diverged branch with a same-named remote counterpart
 * (`push.default: matching`).
 * @param path - workspace's own directory (absolute).
 * @param signal - caller lifetime; abort rejects with the abort reason.
 * @throws {GitNotARepositoryError} when `path` is outside any git working tree.
 * @throws {GitCommandError} when `git push` exits non-zero (no configured
 * remote/upstream, a non-fast-forward rejection, authentication failure, …).
 */
export async function push(path: string, signal?: AbortSignal): Promise<void> {
  const repoRoot = await repoRootOrThrow(path, signal)
  const branch = await currentBranch(repoRoot, signal)
  const remote = branch === 'HEAD' ? undefined : await currentRemote(repoRoot, branch, signal)
  const gitArgs = remote === undefined ? ['push'] : ['push', remote, 'HEAD']
  try {
    await runGit(['-C', repoRoot, ...gitArgs], signal)
  } catch (error: unknown) {
    /* v8 ignore next -- same narrow-window rationale as pullRebase's own catch above. */
    if (signal?.aborted) throw error
    throw new GitCommandError('push', messageOf(error))
  }
}

/**
 * Reads one file's content at `HEAD`, in the git repository enclosing `path`.
 * Fails loud with {@link GitNotARepositoryError} when `path` is outside any
 * git working tree — a diff without a repository is meaningless, the same
 * "must not silently no-op" stance the write actions take. Any OTHER `git
 * show` failure — no committed blob at this path (a new, untracked, or
 * renamed-from-elsewhere file), or an unborn branch (no commits yet) — folds
 * to `null`: the only thing this distinguishes is "no HEAD blob", not
 * general git health.
 * @param path - workspace's own directory (absolute), used only to resolve the enclosing repository.
 * @param filePath - the file's absolute path, resolved relative to the repository root for `git show`.
 * @param signal - caller lifetime; abort rejects with the abort reason.
 * @returns the file's `HEAD` content, or `null` when it has no committed blob at this path.
 * @throws {GitNotARepositoryError} when `path` is outside any git working tree.
 */
export async function workspaceFileAtHead(path: string, filePath: string, signal?: AbortSignal): Promise<string | null> {
  const repoRoot = await repoRootOrThrow(path, signal)
  const relativePath = relative(repoRoot, filePath)
  try {
    const { stdout } = await runGit(['-C', repoRoot, 'show', `HEAD:${relativePath}`], signal)
    return stdout
  } catch (error: unknown) {
    /* v8 ignore next -- needs the caller signal to abort in the narrow window
       between the repo-root check settling and this call settling; not
       reliably raceable in a portable test (see currentBranch's own guard). */
    if (signal?.aborted) throw error
    return null
  }
}

/**
 * Shared repo-root resolution for the write actions: unlike
 * {@link workspaceGitStatus}, a non-repository must fail loud rather than
 * quietly no-op a write the caller believes succeeded.
 * @param path - candidate directory (absolute).
 * @param signal - caller lifetime; abort rejects with the abort reason.
 * @returns the repository's absolute root path.
 * @throws {GitNotARepositoryError} when `path` is outside any git working tree.
 */
async function repoRootOrThrow(path: string, signal: AbortSignal | undefined): Promise<string> {
  try {
    return await repoToplevel(path, signal)
  } catch (error: unknown) {
    if (signal?.aborted) throw error
    throw new GitNotARepositoryError(path)
  }
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
    const { stdout } = await runGit(['-C', repoRoot, 'symbolic-ref', '--short', 'HEAD'], signal)
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
