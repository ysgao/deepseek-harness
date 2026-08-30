/** Client-side Workspace state model shared by Remote transport and UI projection. */

import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/remote'
import type { RemoteFailure, RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceBaseline,
  WorkspaceCreateDirectoryValue,
  WorkspaceCreateEntryRequest,
  WorkspaceCreateFileValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteValue,
  WorkspaceEntryListing,
  WorkspaceFileContent,
  WorkspaceFileDiff,
  WorkspaceGitCommitAllRequest,
  WorkspaceGitCommitAllValue,
  WorkspaceGitDiscardAllValue,
  WorkspaceGitFetchValue,
  WorkspaceGitFileDiffRequest,
  WorkspaceGitPullRebaseValue,
  WorkspaceGitPushValue,
  WorkspaceGitStatus,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceListEntriesRequest,
  WorkspaceOrderValue,
  WorkspaceReadFileRequest,
  WorkspaceValue,
  WorkspaceWriteFileRequest,
  WorkspaceWriteFileValue,
  WorkspaceId,
  WorkspaceView,
} from '../types.ts'

/** Complete generated `ctx.remote.workspace` namespace. */
export type WorkspaceRemote = TypertClientRemote['workspace']

/** Monotone Workspace-list arrival lifecycle. */
export type WorkspaceListPhase = 'pending' | 'ready'

/** Immutable Client Workspace state. */
export interface WorkspaceSnapshot {
  readonly items: readonly WorkspaceView[]
  /** Complete registry-global archive set in Host order. */
  readonly archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds']
  readonly state: 'idle' | 'loading' | 'error'
  readonly phase: WorkspaceListPhase
  readonly error: RemoteFailure | null
}

/** State operations emitted by a decoded Workspace follow generation. */
export interface WorkspaceFollowSink {
  /** Replace all state from the generation baseline. */
  replaceBaseline(value: WorkspaceBaseline): void
  /** Merge one Workspace row. */
  upsertView(workspace: WorkspaceView): void
  /** Remove one Workspace row. */
  removeView(workspaceId: WorkspaceId): void
  /** Replace the Host-confirmed Workspace order. */
  replaceOrder(workspaceIds: readonly WorkspaceId[]): void
  /** Replace the complete archived Session set. */
  replaceArchived(sessionIds: WorkspaceArchiveValue['archivedSessionIds']): void
}

/**
 * Owns the Client Workspace projection, mutation echoes, and stream/unary race resolution.
 */
export class ClientWorkspaceModel implements WorkspaceFollowSink {
  private items: readonly WorkspaceView[] = []
  private archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds'] = []
  private state: WorkspaceSnapshot['state'] = 'loading'
  private phase: WorkspaceListPhase = 'pending'
  private error: RemoteFailure | null = null
  /** Latest local reorder request; only its unary echo may install order. */
  private orderRequestGeneration = 0
  /** Increments on stream orders so a later remote commit outranks an older unary echo. */
  private orderFrameGeneration = 0
  /** Last complete order accepted from a baseline, increment, or current unary echo. */
  private committedOrder: WorkspaceId[] = []
  /** Host Workspace ids are never reused, so delayed data cannot resurrect a removed row. */
  private readonly removedIds = new Set<WorkspaceId>()
  private readonly listeners = new Set<() => void>()
  private snapshotCache: WorkspaceSnapshot
  private snapshotDirty = false
  private notificationPending = false
  private notificationScheduled = false
  private notificationGeneration = 0

  /** @param remote - generated Workspace Remote namespace. */
  constructor(private readonly remote: WorkspaceRemote) {
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Create or resolve a Workspace and merge the unary result immediately.
   * @param input - existing absolute path to adopt.
   * @returns generated Remote result.
   */
  async create(input: WorkspaceCreateRequest): Promise<RemoteResult<WorkspaceCreateValue>> {
    let result: RemoteResult<WorkspaceCreateValue>
    try {
      result = await this.remote.create(input)
    } catch (error) {
      result = failureResult(error)
    }
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Rename a Workspace and merge the unary result immediately.
   * @param workspaceId - target Workspace.
   * @param title - new display title.
   * @returns generated Remote result.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<RemoteResult<WorkspaceValue>> {
    const result = await this.remote.rename({ workspaceId, title })
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Delete a Workspace and remove it from the local projection immediately.
   * @param workspaceId - target Workspace.
   * @returns generated Remote result.
   */
  async delete(workspaceId: WorkspaceId): Promise<RemoteResult<WorkspaceDeleteValue>> {
    const result = await this.remote.delete({ workspaceId })
    if (result.ok) this.remove(workspaceId, true)
    return result
  }

  /**
   * Optimistically move a Workspace and reconcile the returned complete order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - anchor Workspace; omitted appends.
   * @returns generated Remote result.
   */
  async insertBefore(
    workspaceId: WorkspaceId,
    beforeWorkspaceId?: WorkspaceId,
  ): Promise<RemoteResult<WorkspaceOrderValue>> {
    const requestGeneration = ++this.orderRequestGeneration
    const frameGeneration = this.orderFrameGeneration
    const localOrder = this.items.map(workspace => workspace.workspaceId)
    this.installOrder(insertIdBefore(localOrder, workspaceId, beforeWorkspaceId))
    let result: RemoteResult<WorkspaceOrderValue>
    try {
      result = await this.remote.insertBefore({
        workspaceId,
        ...beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId },
      })
    } catch (error) {
      if (requestGeneration === this.orderRequestGeneration
        && frameGeneration === this.orderFrameGeneration) {
        this.installOrder(this.committedOrder)
      }
      throw error
    }
    if (requestGeneration === this.orderRequestGeneration
      && frameGeneration === this.orderFrameGeneration) {
      this.installOrder(result.ok ? result.value.workspaceIds : this.committedOrder, result.ok)
    }
    return result
  }

  /**
   * Move a Session within its Workspace and merge the returned row.
   * @param workspaceId - owning Workspace.
   * @param sessionId - accounted Session to move.
   * @param beforeSessionId - accounted anchor; omitted appends.
   * @returns generated Remote result.
   */
  async insertSessionBefore(
    workspaceId: WorkspaceInsertSessionBeforeRequest['workspaceId'],
    sessionId: WorkspaceInsertSessionBeforeRequest['sessionId'],
    beforeSessionId?: WorkspaceInsertSessionBeforeRequest['beforeSessionId'],
  ): Promise<RemoteResult<WorkspaceValue>> {
    const result = await this.remote.insertSessionBefore({
      workspaceId,
      sessionId,
      ...beforeSessionId === undefined ? {} : { beforeSessionId },
    })
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Archive one Session and install the returned complete archive set.
   * @param sessionId - Session to archive.
   * @returns generated Remote result.
   */
  async archiveSession(
    sessionId: WorkspaceArchiveSessionRequest['sessionId'],
  ): Promise<RemoteResult<WorkspaceArchiveValue>> {
    const result = await this.remote.archiveSession({ sessionId })
    if (result.ok) this.installArchived(result.value.archivedSessionIds)
    return result
  }

  /**
   * List one directory level under a workspace root.
   * @param request - workspace identity and target directory.
   * @param signal - caller lifetime; abort stops the scan.
   * @returns generated Remote result.
   */
  listEntries(request: WorkspaceListEntriesRequest, signal?: AbortSignal): Promise<RemoteResult<WorkspaceEntryListing>> {
    return this.callFile(() => this.remote.listEntries(request, signal))
  }

  /**
   * Read one file's content for in-app preview.
   * @param request - workspace identity and target file.
   * @param signal - caller lifetime; abort stops the read.
   * @returns generated Remote result.
   */
  readFile(request: WorkspaceReadFileRequest, signal?: AbortSignal): Promise<RemoteResult<WorkspaceFileContent>> {
    return this.callFile(() => this.remote.readFile(request, signal))
  }

  /**
   * Overwrite one existing file, guarded by `expectedVersion`.
   * @param request - workspace identity, target file, content, and expected version.
   * @param signal - caller lifetime; abort rejects before publication.
   * @returns generated Remote result.
   */
  writeFile(request: WorkspaceWriteFileRequest, signal?: AbortSignal): Promise<RemoteResult<WorkspaceWriteFileValue>> {
    return this.callFile(() => this.remote.writeFile(request, signal))
  }

  /**
   * Create one new, empty regular file as a child of an existing directory under a workspace root.
   * @param request - workspace identity, target parent directory, and new file's name.
   * @param signal - caller lifetime; abort rejects before creation.
   * @returns generated Remote result.
   */
  createFile(request: WorkspaceCreateEntryRequest, signal?: AbortSignal): Promise<RemoteResult<WorkspaceCreateFileValue>> {
    return this.callFile(() => this.remote.createFile(request, signal))
  }

  /**
   * Create one new, empty directory as a child of an existing directory under a workspace root.
   * @param request - workspace identity, target parent directory, and new directory's name.
   * @param signal - caller lifetime; abort rejects before creation.
   * @returns generated Remote result.
   */
  createDirectory(
    request: WorkspaceCreateEntryRequest,
    signal?: AbortSignal,
  ): Promise<RemoteResult<WorkspaceCreateDirectoryValue>> {
    return this.callFile(() => this.remote.createDirectory(request, signal))
  }

  /**
   * Report the current branch and pending file changes of a workspace's enclosing git repository.
   * @param workspaceId - target workspace.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns generated Remote result.
   */
  gitStatus(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<RemoteResult<WorkspaceGitStatus>> {
    return this.callFile(() => this.remote.gitStatus({ workspaceId }, signal))
  }

  /**
   * Stage every pending change and commit them.
   * @param request - workspace identity and commit message.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns generated Remote result.
   */
  gitCommitAll(request: WorkspaceGitCommitAllRequest, signal?: AbortSignal): Promise<RemoteResult<WorkspaceGitCommitAllValue>> {
    return this.callFile(() => this.remote.gitCommitAll(request, signal))
  }

  /**
   * Revert every tracked file's pending change to its `HEAD` content.
   * @param workspaceId - target workspace.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns generated Remote result.
   */
  gitDiscardAll(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<RemoteResult<WorkspaceGitDiscardAllValue>> {
    return this.callFile(() => this.remote.gitDiscardAll({ workspaceId }, signal))
  }

  /**
   * Download new commits and update the workspace's remote-tracking refs,
   * without touching the current branch or working tree.
   * @param workspaceId - target workspace.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns generated Remote result.
   */
  gitFetch(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<RemoteResult<WorkspaceGitFetchValue>> {
    return this.callFile(() => this.remote.gitFetch({ workspaceId }, signal))
  }

  /**
   * Rebase local commits onto the current branch's already-known upstream,
   * without fetching first.
   * @param workspaceId - target workspace.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns generated Remote result.
   */
  gitPullRebase(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<RemoteResult<WorkspaceGitPullRebaseValue>> {
    return this.callFile(() => this.remote.gitPullRebase({ workspaceId }, signal))
  }

  /**
   * Push the current branch to its configured remote.
   * @param workspaceId - target workspace.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns generated Remote result.
   */
  gitPush(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<RemoteResult<WorkspaceGitPushValue>> {
    return this.callFile(() => this.remote.gitPush({ workspaceId }, signal))
  }

  /**
   * Read one file's `HEAD` and working-tree text, for a side-by-side diff.
   * @param request - workspace identity and target file.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns generated Remote result.
   */
  gitFileDiff(request: WorkspaceGitFileDiffRequest, signal?: AbortSignal): Promise<RemoteResult<WorkspaceFileDiff>> {
    return this.callFile(() => this.remote.gitFileDiff(request, signal))
  }

  /**
   * Replace the projection from one complete stream-generation baseline.
   * @param baseline - complete Workspace and archive projection.
   */
  replaceBaseline(baseline: WorkspaceBaseline): void {
    this.orderFrameGeneration++
    this.installViews(baseline.items)
    this.installArchived(baseline.archivedSessionIds)
    this.state = 'idle'
    this.phase = 'ready'
    this.error = null
    this.invalidate()
  }

  /** Merge one decoded Workspace upsert from the current follow generation. */
  upsertView(workspace: WorkspaceView): void {
    this.upsert(workspace)
  }

  /** Apply one decoded Workspace removal from the current follow generation. */
  removeView(workspaceId: WorkspaceId): void {
    this.remove(workspaceId)
  }

  /** Replace Host-confirmed order from the current follow generation. */
  replaceOrder(workspaceIds: readonly WorkspaceId[]): void {
    this.orderFrameGeneration++
    this.installOrder(workspaceIds, true)
  }

  /**
   * Replace the archived Session set from the current follow generation.
   * @param archivedSessionIds - complete Host-confirmed archive set.
   */
  replaceArchived(archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds']): void {
    this.installArchived(archivedSessionIds)
  }

  /** Keep the last complete projection visible while a lost carrier reconnects. */
  handleCarrierFailure(): void {
    this.state = 'loading'
    this.error = null
    this.invalidate()
  }

  /**
   * Publish a non-retryable stream or protocol failure.
   * @param error - terminal stream failure.
   */
  handleStreamFailure(error: unknown): void {
    this.state = 'error'
    this.error = failureOf(error)
    this.invalidate()
  }

  /**
   * Subscribe to Workspace state invalidation.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read the cached state, rebuilding it first when necessary.
   * @returns the current stable Workspace list snapshot.
   */
  getSnapshot(): WorkspaceSnapshot {
    this.refreshSnapshot()
    return this.snapshotCache
  }

  /** Pass a file/git call's result through unmodified: none of them touch the registry projection. */
  private async callFile<T>(call: () => Promise<RemoteResult<T>>): Promise<RemoteResult<T>> {
    try {
      return await call()
    } catch (error) {
      return failureResult(error)
    }
  }

  private buildSnapshot(): WorkspaceSnapshot {
    return {
      items: this.items,
      archivedSessionIds: this.archivedSessionIds,
      state: this.state,
      phase: this.phase,
      error: this.error,
    }
  }

  private installArchived(archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds']): void {
    if (archivedSessionIds.length === this.archivedSessionIds.length
      && archivedSessionIds.every((id, index) => id === this.archivedSessionIds[index])) return
    this.archivedSessionIds = [...archivedSessionIds]
    this.invalidate()
  }

  private installOrder(workspaceIds: readonly WorkspaceId[], committed = false): void {
    if (committed) this.committedOrder = [...workspaceIds]
    const rank = new Map(workspaceIds.map((id, index) => [id, index]))
    const items = [...this.items].sort((left, right) =>
      (rank.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER))
    if (items.every((item, index) => item === this.items[index])) return
    this.items = items
    this.invalidate()
  }

  private upsert(view: WorkspaceView): void {
    if (this.removedIds.has(view.workspaceId)) return
    const index = this.items.findIndex(item => item.workspaceId === view.workspaceId)
    const installed = this.items[index]
    // Unary responses and stream increments race on separate requests. Keep
    // the newest Host projection regardless of their arrival order.
    if (installed !== undefined && Date.parse(view.updatedAt) < Date.parse(installed.updatedAt)) return
    if (!this.committedOrder.includes(view.workspaceId)) {
      this.committedOrder = [view.workspaceId, ...this.committedOrder]
    }
    this.items = index === -1
      ? [view, ...this.items]
      : this.items.map((item, position) => position === index ? view : item)
    this.invalidate()
  }

  private remove(workspaceId: WorkspaceId, immediate = false): void {
    this.removedIds.add(workspaceId)
    this.committedOrder = this.committedOrder.filter(id => id !== workspaceId)
    const items = this.items.filter(item => item.workspaceId !== workspaceId)
    if (items.length === this.items.length) {
      // A successful unary echo still publishes an earlier increment's
      // pending removal before the user operation resolves.
      if (immediate) this.invalidate(true)
      return
    }
    this.items = items
    this.invalidate(immediate)
  }

  private installViews(views: readonly WorkspaceView[]): void {
    const installed = new Map<WorkspaceId, WorkspaceView>()
    for (const view of views) {
      if (!this.removedIds.has(view.workspaceId)) installed.set(view.workspaceId, view)
    }
    this.items = [...installed.values()]
    this.committedOrder = views.map(view => view.workspaceId)
  }

  private invalidate(immediate = false): void {
    this.snapshotDirty = true
    this.notificationPending = true
    if (immediate) {
      this.notificationGeneration++
      this.notificationScheduled = false
      this.flush()
      return
    }
    if (this.notificationScheduled) return
    this.notificationScheduled = true
    const generation = ++this.notificationGeneration
    queueMicrotask(() => {
      if (generation !== this.notificationGeneration) return
      this.notificationScheduled = false
      this.flush()
    })
  }

  private flush(): void {
    if (!this.notificationPending || this.listeners.size === 0) return
    this.notificationPending = false
    this.refreshSnapshot()
    notifySubscribers(this.listeners, '[workspace-controller]')
  }

  private refreshSnapshot(): void {
    if (!this.snapshotDirty) return
    this.snapshotDirty = false
    this.snapshotCache = this.buildSnapshot()
  }
}

function insertIdBefore(
  ids: readonly WorkspaceId[],
  id: WorkspaceId,
  beforeId?: WorkspaceId,
): WorkspaceId[] {
  if (!ids.includes(id) || (beforeId !== undefined && !ids.includes(beforeId)) || beforeId === id) {
    return [...ids]
  }
  const without = ids.filter(candidate => candidate !== id)
  const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
  return [...without.slice(0, at), id, ...without.slice(at)]
}

function failureResult<T>(error: unknown): RemoteResult<T> {
  return { ok: false, error: failureOf(error) }
}

function failureOf(error: unknown): RemoteFailure {
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}
