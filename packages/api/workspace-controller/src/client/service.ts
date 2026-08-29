/** React-free Client Workspace service and command facade. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  WorkspaceEntryListing, WorkspaceFileContent, WorkspaceFileDiff, WorkspaceFileVersion, WorkspaceGitStatus,
  WorkspaceView,
} from '../types.ts'
import type { ClientWorkspaceModel, WorkspaceSnapshot } from './model.ts'

/** Structured create failure for callers that distinguish Host business errors. */
export class WorkspaceCreateError extends Error {
  override readonly name = 'WorkspaceCreateError'

  /** @param rpcError - Host business or folded transport failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`workspace create failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/**
 * Structured file read/write failure for callers that distinguish Host
 * business errors (e.g. `file-too-large` from `readFile`, `file-changed`
 * from `writeFile`). Client feature packages may not import this class as a
 * value (the cross-plugin bundle-purity gate), so they discriminate a
 * rejection through the stable `error.name` string instead of `instanceof`.
 */
export class WorkspaceFileBrowseError extends Error {
  override readonly name = 'WorkspaceFileBrowseError'

  /**
   * @param operation - the failing call, for the message only (`readFile`/`writeFile`).
   * @param rpcError - Host business or folded transport failure.
   */
  constructor(operation: string, readonly rpcError: RemoteFailure) {
    super(`workspace ${operation} failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Bare observable source for the Workspace Controller snapshot. */
export interface WorkspaceSource {
  /** Read the identity-stable current snapshot. */
  getSnapshot(): WorkspaceSnapshot
  /**
   * Subscribe to snapshot changes.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/** Workspace Controller's Client service face. */
export interface IWorkspaces {
  /** Host-authoritative Workspace rows, order, archive set, and follow lifecycle. */
  readonly list: WorkspaceSource
  /**
   * Register an existing path as a Workspace.
   * @param input - Host create payload.
   * @returns the created or idempotently resolved Workspace.
   */
  create(input: { path: string }): Promise<WorkspaceView>
  /**
   * Rename a Workspace.
   * @param workspaceId - target Workspace.
   * @param title - new display title.
   * @returns the renamed Workspace.
   */
  rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>
  /**
   * Delete a Workspace registration without deleting Sessions or files.
   * @param workspaceId - target Workspace.
   */
  delete(workspaceId: WorkspaceId): Promise<void>
  /**
   * Move a Workspace within the Host registry order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - anchor Workspace; omitted appends.
   */
  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>
  /**
   * Archive a Session from Workspace grouping surfaces.
   * @param sessionId - Session to archive.
   */
  archiveSession(sessionId: SessionId): Promise<void>
  /**
   * Move a Session within one Workspace account.
   * @param workspaceId - owning Workspace.
   * @param sessionId - Session to move.
   * @param beforeSessionId - anchor Session; omitted appends.
   * @returns the changed Workspace.
   */
  insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView>
  /**
   * List one directory level under a workspace root (directories and files together).
   * @param workspaceId - target workspace.
   * @param path - directory to list.
   * @param signal - caller lifetime; abort stops the scan.
   * @returns the directory's entries, name-sorted.
   */
  listEntries(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<WorkspaceEntryListing>
  /**
   * Read one file's content for in-app preview.
   * @param workspaceId - target workspace.
   * @param path - file to read.
   * @param signal - caller lifetime; abort stops the read.
   * @returns the file's decoded content and version.
   */
  readFile(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<WorkspaceFileContent>
  /**
   * Overwrite one existing file, guarded by `expectedVersion`.
   * @param workspaceId - target workspace.
   * @param path - file to write.
   * @param content - new file content.
   * @param expectedVersion - staleness guard from the last read or write.
   * @param signal - caller lifetime; abort rejects before publication.
   * @returns the version the write produced.
   */
  writeFile(
    workspaceId: WorkspaceId,
    path: string,
    content: string,
    expectedVersion: WorkspaceFileVersion,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileVersion>
  /**
   * Report the current branch and pending file changes of a workspace's enclosing git repository.
   * @param workspaceId - target workspace.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns the current branch and per-file/folder status.
   */
  gitStatus(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<WorkspaceGitStatus>
  /**
   * Stage every pending change and commit them.
   * @param workspaceId - target workspace.
   * @param message - commit message.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   */
  commitAllChanges(workspaceId: WorkspaceId, message: string, signal?: AbortSignal): Promise<void>
  /**
   * Revert every tracked file's pending change to its `HEAD` content.
   * @param workspaceId - target workspace.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   */
  discardAllChanges(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void>
  /**
   * Fetch from the remote tracked by the current branch and rebase local commits on top.
   * @param workspaceId - target workspace.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   */
  pullRebase(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void>
  /**
   * Push the current branch to its configured remote.
   * @param workspaceId - target workspace.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   */
  push(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void>
  /**
   * Read one file's `HEAD` and working-tree text, for a side-by-side diff.
   * @param workspaceId - target workspace.
   * @param path - file to diff.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns the file's `HEAD` and working-tree sides.
   */
  gitFileDiff(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<WorkspaceFileDiff>
}

/** Owns the bare Workspace snapshot and Workspace-only commands. */
export class WorkspaceController extends Service implements IWorkspaces {
  readonly list: WorkspaceSource

  /**
   * @param ctx - Client root Context.
   * @param model - Remote-backed Workspace state model.
   */
  constructor(ctx: Context, private readonly model: ClientWorkspaceModel) {
    super(ctx, 'workspaces')
    this.list = model
  }

  async create(input: { path: string }): Promise<WorkspaceView> {
    const result = await this.model.create(input)
    if (!result.ok) throw new WorkspaceCreateError(result.error)
    return result.value.workspace
  }

  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    const result = await this.model.rename(workspaceId, title)
    if (!result.ok) throw commandError('rename', result.error)
    return result.value.workspace
  }

  async delete(workspaceId: WorkspaceId): Promise<void> {
    const result = await this.model.delete(workspaceId)
    if (!result.ok) throw commandError('delete', result.error)
  }

  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    const result = await this.model.insertBefore(workspaceId, beforeWorkspaceId)
    if (!result.ok) throw commandError('reorder', result.error)
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    const result = await this.model.archiveSession(sessionId)
    if (!result.ok) throw commandError('session archive', result.error)
  }

  async insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    const result = await this.model.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    if (!result.ok) throw commandError('move', result.error)
    return result.value.workspace
  }

  async listEntries(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<WorkspaceEntryListing> {
    const result = await this.model.listEntries({ workspaceId, path }, signal)
    if (!result.ok) throw commandError('list entries', result.error)
    return result.value
  }

  async readFile(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<WorkspaceFileContent> {
    const result = await this.model.readFile({ workspaceId, path }, signal)
    if (!result.ok) throw new WorkspaceFileBrowseError('read file', result.error)
    return result.value
  }

  async writeFile(
    workspaceId: WorkspaceId,
    path: string,
    content: string,
    expectedVersion: WorkspaceFileVersion,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileVersion> {
    const result = await this.model.writeFile({ workspaceId, path, content, expectedVersion }, signal)
    if (!result.ok) throw new WorkspaceFileBrowseError('write file', result.error)
    return result.value.version
  }

  async gitStatus(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<WorkspaceGitStatus> {
    const result = await this.model.gitStatus(workspaceId, signal)
    if (!result.ok) throw commandError('git status', result.error)
    return result.value
  }

  async commitAllChanges(workspaceId: WorkspaceId, message: string, signal?: AbortSignal): Promise<void> {
    const result = await this.model.gitCommitAll({ workspaceId, message }, signal)
    if (!result.ok) throw commandError('git commit', result.error)
  }

  async discardAllChanges(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void> {
    const result = await this.model.gitDiscardAll(workspaceId, signal)
    if (!result.ok) throw commandError('git discard', result.error)
  }

  async pullRebase(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void> {
    const result = await this.model.gitPullRebase(workspaceId, signal)
    if (!result.ok) throw commandError('git pull', result.error)
  }

  async push(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void> {
    const result = await this.model.gitPush(workspaceId, signal)
    if (!result.ok) throw commandError('git push', result.error)
  }

  async gitFileDiff(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<WorkspaceFileDiff> {
    const result = await this.model.gitFileDiff({ workspaceId, path }, signal)
    if (!result.ok) throw commandError('git diff', result.error)
    return result.value
  }
}

function commandError(operation: string, failure: RemoteFailure): Error {
  return new Error(`workspace ${operation} failed: ${failure.code}: ${failure.message}`)
}
