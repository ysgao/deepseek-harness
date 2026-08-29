/**
 * Browser-safe request, result, and state-stream vocabulary for the Workspace
 * and directory-picking Remote namespaces this package owns. The picking seam
 * declares its own listing types, so they are re-exported here rather than
 * restated: a browser consumer reads the very declaration the backend answers.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { z as zCore } from 'zod'

type ZodIssue = zCore.core.$ZodIssue

export type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
export type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'

/**
 * Wire-side opaque staleness-guard token for one text file's content (a
 * content hash, not a timestamp): returned by `workspace.readFile` and a
 * successful `workspace.writeFile`, and required as `workspace.writeFile`'s
 * `expectedVersion` to guard against clobbering a concurrent change.
 */
export type WorkspaceFileVersion = Branded<'WorkspaceFileVersion'>

/** One durable Workspace projected for browser consumers. */
export interface WorkspaceView {
  readonly workspaceId: WorkspaceId
  /** Canonical host directory path. */
  readonly path: string
  /** User-visible title. */
  readonly title: string
  /** Sessions accounted to this Workspace in manual order. */
  readonly sessionIds: readonly SessionId[]
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 last-mutation instant. */
  readonly updatedAt: string
}

/** Stable Workspace failure details returned by unary methods. */
export interface WorkspaceErrorDetailsMap {
  'bad-request': Record<never, never>
  'workspace-invalid-path': { readonly path: string }
  'workspace-not-found': { readonly workspaceId: WorkspaceId }
  'workspace-name-conflict': { readonly name: string }
  'workspace-move-invalid': {
    readonly workspaceId: WorkspaceId
    readonly sessionId: SessionId
    readonly beforeSessionId?: SessionId
  }
  'session-not-found': { readonly sessionId: SessionId }
  /** The requested path is outside the workspace's own root, or the target cannot be listed/read/written. */
  'directory-unreadable': { readonly path: string }
  /** The read or write content exceeds the deployment's byte bound. */
  'file-too-large': { readonly path: string; readonly maxBytes: number }
  /** A `writeFile`'s `expectedVersion` did not match the file's current on-disk content. */
  'file-changed': { readonly path: string }
  /** A `createFile`/`createDirectory` target path already names a file or directory. */
  'already-exists': { readonly path: string }
  /** A `createFile`/`createDirectory` target's enclosing directory does not exist. */
  'parent-missing': { readonly path: string }
  /** A `createFile`/`createDirectory` `name` is blank, `.`/`..`, or contains a path separator. */
  'invalid-name': { readonly name: string }
  /** The workspace's own directory is outside any git working tree. */
  'git-not-a-repository': { readonly path: string }
  /** The underlying `git` command exited non-zero; `message` carries its own output. */
  'git-command-failed': { readonly command: string }
}

/** Workspace business failure returned without throwing a carrier error. */
export type WorkspaceError = {
  [Code in keyof WorkspaceErrorDetailsMap]: {
    readonly code: Code
    readonly message: string
    readonly details: WorkspaceErrorDetailsMap[Code]
  }
}[keyof WorkspaceErrorDetailsMap]

/** Stable directory-picking failure details returned by the picking wire verbs. */
export interface DirectoryPickerErrorDetailsMap {
  /** The directory creation request violates its semantic input constraints. */
  'bad-request': { readonly issues: ZodIssue[] }
  /** The verb needs an interaction the composed backend does not serve. */
  'directory-picker-unavailable': { readonly capability: string }
  /** The target is not fully qualified, or the backend cannot list it. */
  'directory-unreadable': { readonly path: string }
  /** A child of that name is already there. */
  'directory-exists': { readonly path: string }
  /** The parent is not fully qualified, the name is not one segment, or creation failed. */
  'directory-create-failed': { readonly path: string }
  /** The caller's own timeout or disconnect ended the chooser or the scan. */
  cancelled: Record<never, never>
  /** A backend failure with no seam code of its own. */
  internal: Record<never, never>
}

/** Existing directory requested for Workspace adoption. */
export interface WorkspaceCreateRequest {
  readonly path: string
}

/** Created or previously registered Workspace. */
export interface WorkspaceCreateValue {
  readonly workspace: WorkspaceView
  readonly created: boolean
}

/** Workspace title mutation. */
export interface WorkspaceRenameRequest {
  readonly workspaceId: WorkspaceId
  readonly title: string
}

/** Workspace mutation returning the complete changed row. */
export interface WorkspaceValue {
  readonly workspace: WorkspaceView
}

/** Workspace registration deletion. */
export interface WorkspaceDeleteRequest {
  readonly workspaceId: WorkspaceId
}

/** Receipt after one Workspace registration is deleted. */
export interface WorkspaceDeleteValue {
  readonly deleted: true
}

/** DOM-insertBefore-like Workspace order mutation. */
export interface WorkspaceInsertBeforeRequest {
  readonly workspaceId: WorkspaceId
  readonly beforeWorkspaceId?: WorkspaceId
}

/** Complete Workspace registry order after a mutation. */
export interface WorkspaceOrderValue {
  readonly workspaceIds: readonly WorkspaceId[]
}

/** DOM-insertBefore-like Session membership order mutation. */
export interface WorkspaceInsertSessionBeforeRequest {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly beforeSessionId?: SessionId
}

/** Session requested for archival from Workspace grouping surfaces. */
export interface WorkspaceArchiveSessionRequest {
  readonly sessionId: SessionId
}

/** Complete archived Session set after a mutation. */
export interface WorkspaceArchiveValue {
  readonly archivedSessionIds: readonly SessionId[]
}

/** Complete reconnect baseline for Workspace browser state. */
export interface WorkspaceBaseline {
  readonly items: readonly WorkspaceView[]
  readonly archivedSessionIds: readonly SessionId[]
}

/** One ordered Workspace change after a generation's baseline. */
export type WorkspaceFollowIncrement =
  | { readonly type: 'upsert'; readonly workspace: WorkspaceView }
  | { readonly type: 'remove'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'order'; readonly workspaceIds: readonly WorkspaceId[] }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly SessionId[] }

/** Workspace state stream; every generation starts with exactly one baseline. */
export type WorkspaceFollowFrame =
  | { readonly type: 'baseline'; readonly value: WorkspaceBaseline }
  | WorkspaceFollowIncrement

/** One row of a `workspace.listEntries` level: a subdirectory or a regular file. */
export interface WorkspaceEntry {
  /** Base name within the listed directory. */
  readonly name: string
  /** Absolute host path — the client never joins path segments itself. */
  readonly path: string
  /** Whether the row is a directory (including a symlink resolving to one) or a regular file. */
  readonly type: 'directory' | 'file'
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  readonly hidden: boolean
  /** Byte size of a file row; absent for a directory row. */
  readonly size?: number
}

/** `workspace.listEntries` response value: one directory level, directories and files together. */
export interface WorkspaceEntryListing {
  /** Absolute path of the listed directory. */
  readonly path: string
  /** Direct children (directories and regular files), name-sorted with directories first. */
  readonly entries: readonly WorkspaceEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  readonly truncated: boolean
}

/** `workspace.readFile` response value: a size-bounded file read, decoded by content kind. */
export type WorkspaceFileContent =
  /**
   * UTF-8 text, decoded to a string; the wire's native JSON string form.
   * `version` is the content's staleness-guard token, threaded back through
   * a subsequent `workspace.writeFile` as `expectedVersion`.
   */
  | { readonly kind: 'text'; readonly content: string; readonly version: WorkspaceFileVersion }
  /** Binary content the client cannot decode as text; base64-encoded on the wire. */
  | { readonly kind: 'binary'; readonly mediaType: string; readonly data: string }

/** `workspace.gitFileDiff` response value: one file's `HEAD` and working-tree text, for a side-by-side diff. */
export interface WorkspaceFileDiff {
  /** Content at `HEAD`, or `null` when the file has no committed blob at this path (new, untracked, or renamed from elsewhere). */
  readonly oldText: string | null
  /** Current working-tree content, or `null` when the file no longer exists on disk (deleted). */
  readonly newText: string | null
}

/** `workspace.gitStatus` response value: current branch and pending file changes of a workspace's enclosing git repository. */
export interface WorkspaceGitStatus {
  /** Whether the workspace's own directory is inside a git working tree. */
  readonly isRepo: boolean
  /** Current branch name (`HEAD` when detached); null when `isRepo` is false. */
  readonly branch: string | null
  /**
   * Absolute path (matching `WorkspaceEntry.path`) -> single-letter git
   * status code (`M`/`A`/`D`/`R`/`C`/`U`/`X`, `X` marking an unmerged/
   * conflicted path), one entry per path with a pending change.
   */
  readonly files: Readonly<Record<string, string>>
}

/** `workspace.listEntries` request: one directory level under a workspace root. */
export interface WorkspaceListEntriesRequest {
  readonly workspaceId: WorkspaceId
  readonly path: string
}

/** `workspace.readFile` request: one regular file under a workspace root. */
export interface WorkspaceReadFileRequest {
  readonly workspaceId: WorkspaceId
  readonly path: string
}

/** `workspace.writeFile` request: an atomic, version-guarded overwrite of one regular file under a workspace root. */
export interface WorkspaceWriteFileRequest {
  readonly workspaceId: WorkspaceId
  readonly path: string
  readonly content: string
  readonly expectedVersion: WorkspaceFileVersion
}

/** `workspace.writeFile` response value: the version the write produced. */
export interface WorkspaceWriteFileValue {
  readonly version: WorkspaceFileVersion
}

/**
 * `workspace.createFile` / `workspace.createDirectory` request: one new
 * child of `parentPath` (an existing directory under the workspace root)
 * named `name` — a single non-blank path segment, never a multi-segment
 * path, so the caller cannot escape `parentPath` through the name field.
 */
export interface WorkspaceCreateEntryRequest {
  readonly workspaceId: WorkspaceId
  readonly parentPath: string
  readonly name: string
}

/** `workspace.createFile` response value: the created empty file's absolute path and initial content version. */
export interface WorkspaceCreateFileValue {
  readonly path: string
  readonly version: WorkspaceFileVersion
}

/** `workspace.createDirectory` response value: the created directory's absolute path. */
export interface WorkspaceCreateDirectoryValue {
  readonly path: string
}

/**
 * `workspace.gitStatus` / `workspace.gitCommitAll` / `workspace.gitDiscardAll` / `workspace.gitPullRebase` /
 * `workspace.gitPush` request: identifies the workspace whose enclosing git repository is acted on.
 */
export interface WorkspaceGitRequest {
  readonly workspaceId: WorkspaceId
}

/** `workspace.gitCommitAll` request: stages and commits every pending change. */
export interface WorkspaceGitCommitAllRequest {
  readonly workspaceId: WorkspaceId
  readonly message: string
}

/** `workspace.gitCommitAll` response value. */
export interface WorkspaceGitCommitAllValue {
  readonly committed: true
}

/** `workspace.gitDiscardAll` response value. */
export interface WorkspaceGitDiscardAllValue {
  readonly discarded: true
}

/** `workspace.gitPullRebase` response value. */
export interface WorkspaceGitPullRebaseValue {
  readonly pulled: true
}

/** `workspace.gitPush` response value. */
export interface WorkspaceGitPushValue {
  readonly pushed: true
}

/** `workspace.gitFileDiff` request: one file's `HEAD` vs. working-tree text under a workspace root. */
export interface WorkspaceGitFileDiffRequest {
  readonly workspaceId: WorkspaceId
  readonly path: string
}
