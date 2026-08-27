/**
 * workspace domain contract. Wire projection of the host-side workspace
 * entity (@deepseek-ai/dsh-workspace): a stable id over a directory path,
 * a display title, and the ordered session account. Method signatures are the
 * source of truth, same as the sessions domain.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * Wire-side workspace id brand. Deliberately re-declared here rather than
 * imported from dsh-workspace: api/ must stay browser-importable with zero
 * host-package dependencies, and the brand string matches, so both sides
 * agree structurally.
 */
export type WorkspaceId = Branded<'WorkspaceId'>

/** One workspace row: the record projection every workspace.* value carries. */
export interface WorkspaceView {
  workspaceId: WorkspaceId
  /** Canonical directory path (host-side realpath canon). */
  path: string
  /** Display title (defaults to the path basename at create). */
  title: string
  /**
   * Sessions accounted under this workspace, in manually owned order
   * (attach prepends, insertSessionBefore reorders; activity never does).
   */
  sessionIds: SessionId[]
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 last-mutation instant. */
  updatedAt: string
}

/** One row of a `workspace.listEntries` level: a subdirectory or a regular file. */
export interface WorkspaceEntry {
  /** Base name within the listed directory. */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** Whether the row is a directory (including a symlink resolving to one) or a regular file. */
  type: 'directory' | 'file'
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean
  /** Byte size of a file row; absent for a directory row. */
  size?: number
}

/** `workspace.listEntries` response value: one directory level, directories and files together. */
export interface WorkspaceEntryListing {
  /** Absolute path of the listed directory. */
  path: string
  /** Direct children (directories and regular files), name-sorted with directories first. */
  entries: WorkspaceEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean
}

/** `workspace.readFile` response value: a size-bounded file read, decoded by content kind. */
export type WorkspaceFileContent =
  /** UTF-8 text, decoded to a string; the wire's native JSON string form. */
  | { kind: 'text'; content: string }
  /** Binary content the client cannot decode as text; base64-encoded on the wire. */
  | { kind: 'binary'; mediaType: string; data: string }

/** `workspace.gitStatus` response value: current branch and pending file changes of a workspace's enclosing git repository. */
export interface WorkspaceGitStatus {
  /** Whether the workspace's own directory is inside a git working tree. */
  isRepo: boolean
  /** Current branch name (`HEAD` when detached); null when `isRepo` is false. */
  branch: string | null
  /**
   * Absolute path (matching `WorkspaceEntry.path`) -> single-letter git
   * status code (`M`/`A`/`D`/`R`/`C`/`U`), one entry per path with a
   * pending change.
   */
  files: Record<string, string>
}

/** Workspace-domain unary methods (the map keys workspace.* of RpcMethodMap). */
export interface WorkspaceApi {
  /**
   * Lists all workspaces in the registry's durable display order, plus the
   * registry-global archive set (the reconnect baseline of
   * `host/archived-sessions-changed`). Archived sessions stay in their
   * workspace's `sessionIds` account; grouping surfaces hide them.
   */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ items: WorkspaceView[]; archivedSessionIds: SessionId[] }>>

  /**
   * Creates (or idempotently resolves) a workspace over an EXISTING directory
   * (no mkdir — a missing or non-directory path fails with
   * `workspace-invalid-path`). A path resolving to a directory already owned
   * by a workspace returns that workspace (`created: false`). Adoption allows
   * distinct canonical paths whose basenames produce the same display title;
   * the registry's basename title default names the new workspace.
   */
  create(request: RpcRequest<{ path: string }>):
  Promise<RpcResponse<{ workspace: WorkspaceView; created: boolean }>>

  /**
   * Renames a workspace. `title` is trimmed and must be non-empty
   * (schema-enforced). An unknown id fails with `workspace-not-found`; a
   * title equal to another workspace's fails with `workspace-name-conflict`.
   * Renaming to the current title is a no-op success (no durable write).
   */
  rename(request: RpcRequest<{ workspaceId: WorkspaceId; title: string }>):
  Promise<RpcResponse<{ workspace: WorkspaceView }>>

  /**
   * Removes one Workspace registration. The directory, every user file, and
   * every session log remain untouched; those Sessions consequently become
   * ungrouped. An unknown id fails with `workspace-not-found`.
   */
  delete(request: RpcRequest<{ workspaceId: WorkspaceId }>):
  Promise<RpcResponse<{ deleted: true }>>

  /**
   * Moves one Workspace within the registry display order,
   * DOM-insertBefore-like. An omitted anchor appends to the end.
   */
  insertBefore(request: RpcRequest<{
    workspaceId: WorkspaceId
    beforeWorkspaceId?: WorkspaceId
  }>): Promise<RpcResponse<{ workspaceIds: WorkspaceId[] }>>

  /**
   * Moves an accounted session within its workspace's manual order,
   * DOM-insertBefore-like: with `beforeSessionId` the session is inserted
   * before that anchor; omitted appends to the end. An unknown workspace
   * fails with `workspace-not-found`; a session or anchor not accounted by
   * the workspace fails with `workspace-move-invalid`. A move to the current
   * position is a no-op success.
   */
  insertSessionBefore(request: RpcRequest<{
    workspaceId: WorkspaceId
    sessionId: SessionId
    beforeSessionId?: SessionId
  }>): Promise<RpcResponse<{ workspace: WorkspaceView }>>

  /**
   * Adds one session to the registry-global archive set: the session
   * disappears from every grouping surface but keeps its session log and its
   * workspace accounting slot (a future unarchive restores its position).
   * Idempotent for an already archived id. A session neither live nor in
   * session persistence fails with `session-not-found`. Returns the full
   * updated set (same snapshot the changed frame carries).
   */
  archiveSession(request: RpcRequest<{ sessionId: SessionId }>):
  Promise<RpcResponse<{ archivedSessionIds: SessionId[] }>>

  /**
   * Lists one directory level under a workspace root: subdirectories AND
   * regular files together (unlike `host.listDirectory`, which serves the
   * directory-only workspace-picker interaction). `path` must be the
   * workspace's own canonical path or a descendant of it; a request outside
   * that root fails with `directory-unreadable`. Symlinks to a directory are
   * followed and reported as `type: 'directory'`; broken/cyclic symlinks and
   * non-regular entries (sockets, devices) are skipped. Bounded and
   * `truncated`-flagged the same way `host.listDirectory` is.
   */
  listEntries(request: RpcRequest<{ workspaceId: WorkspaceId; path: string }>, signal: AbortSignal):
  Promise<RpcResponse<WorkspaceEntryListing>>

  /**
   * Reads one regular file under a workspace root for in-app preview. `path`
   * must be the workspace's own canonical path or a descendant of it; a
   * request outside that root fails with `directory-unreadable`. Valid UTF-8
   * decodes as `kind: 'text'`; otherwise the bytes return as `kind: 'binary'`
   * with a best-effort media type from the file extension. A file exceeding
   * the deployment's read bound fails with `file-too-large`.
   */
  readFile(request: RpcRequest<{ workspaceId: WorkspaceId; path: string }>, signal: AbortSignal):
  Promise<RpcResponse<WorkspaceFileContent>>

  /**
   * Reports the current branch and pending file changes of the git
   * repository enclosing a workspace's own directory (which may be an
   * ancestor of it — the workspace need not be the repository root). A
   * workspace directory outside any git working tree reports `isRepo:
   * false`; this is normal state, not a business error. `files` keys are
   * always absolute, matching `WorkspaceEntry.path`, regardless of which
   * directory level of the workspace tree they belong to.
   */
  gitStatus(request: RpcRequest<{ workspaceId: WorkspaceId }>, signal: AbortSignal):
  Promise<RpcResponse<WorkspaceGitStatus>>

  /**
   * Stages every pending change — tracked and untracked alike — and commits
   * them with `message` to the git repository enclosing a workspace's own
   * directory. A blank `message` fails schema validation before this method
   * runs. Fails `git-not-a-repository` when the directory is outside any
   * git working tree, `git-command-failed` when `git add`/`git commit`
   * itself exits non-zero (a failing commit hook, no pending changes, no
   * configured git identity, …) — the message is git's own output.
   */
  gitCommitAll(request: RpcRequest<{ workspaceId: WorkspaceId; message: string }>, signal: AbortSignal):
  Promise<RpcResponse<{ committed: true }>>

  /**
   * Reverts every tracked file's pending change to its `HEAD` content in the
   * git repository enclosing a workspace's own directory; an untracked file
   * is left untouched (git has no copy of it to restore). Fails
   * `git-not-a-repository` when the directory is outside any git working
   * tree, `git-command-failed` when the underlying `git` commands exit
   * non-zero.
   */
  gitDiscardAll(request: RpcRequest<{ workspaceId: WorkspaceId }>, signal: AbortSignal):
  Promise<RpcResponse<{ discarded: true }>>
}
