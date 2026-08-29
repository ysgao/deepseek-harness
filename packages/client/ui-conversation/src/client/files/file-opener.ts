/**
 * Cross-plugin file-open registry: the one way another plugin — the
 * Workspace Files tree today — hands this package a path to preview instead
 * of only ever falling back to the Host OS-default handoff.
 *
 * `conversationStore`'s bound actions are reachable only from inside that
 * store's own registered components (ui-slots resolves and caches store
 * instances per-entry, and does not expose that resolution outside the
 * render tree — see `docs/cookbook` slot-system standard, "stores: read via
 * useStore, write via actions"). This registry is therefore the actual
 * cross-session, cross-plugin handoff surface (mirrors `ComposerBlockRegistry`'s
 * shape exactly): `apply.ts`'s `conversationFileOpener` service writes to it,
 * and `ConversationSession` (which legitimately holds `conversationStore`'s
 * bound actions for its own session) drains it into the store's `openView('file', path)`
 * action through an effect.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'

/** One pending cross-plugin file-open request. */
export interface PendingFileOpen {
  readonly path: string
  /**
   * The requester's own workspace, when known (e.g. the Workspace Files
   * tree, which is always browsing one specific workspace). Absent when the
   * requester only has a session (e.g. a chat-message file mention) — the
   * File view then falls back to deriving the owning workspace from the
   * session's own membership, which can miss for a session not yet
   * reflected in that workspace's roster.
   */
  readonly workspaceId?: WorkspaceId
  readonly seq: number
}

/** The registry face `ConversationFileOpener` writes and `ConversationSession` drains. */
export interface FileOpenRegistry {
  /**
   * Request opening `path` in one session's File tab. Idempotent by request
   * identity, not content: two requests for the same path both notify (a
   * re-click while the tab is already showing that file re-focuses it).
   * @param sessionId - target session.
   * @param path - workspace-scoped absolute path to preview.
   * @param workspaceId - the requester's own workspace, when known.
   */
  request(sessionId: SessionId, path: string, workspaceId?: WorkspaceId): void
  /**
   * The store one session's `ConversationSession` drains on every change.
   * Created on first read from either side, so a request may arrive before
   * that session's component mounts and it still sees it.
   * @param sessionId - the session to observe.
   * @returns that session's pending-path store (undefined = no pending request).
   */
  storeFor(sessionId: SessionId): SnapshotStore<PendingFileOpen | undefined>
  /**
   * Drop one session's store. The session scope's disposer calls this; a
   * requester never needs to.
   * @param sessionId - the session being torn down.
   */
  forget(sessionId: SessionId): void
}

/** The per-session file-open registry (one instance per plugin fiber). */
export class FileOpenRegistryImpl implements FileOpenRegistry {
  private readonly stores = new Map<SessionId, SnapshotStore<PendingFileOpen | undefined>>()
  private nextSeq = 0

  /** @inheritdoc */
  request(sessionId: SessionId, path: string, workspaceId?: WorkspaceId): void {
    // seq, not just path, so requesting the same path twice in a row still
    // notifies (ConversationSession's drain effect keys off the change).
    // Spread, not a `workspaceId` shorthand: exactOptionalPropertyTypes
    // treats an explicit `undefined` value differently from an absent key.
    this.storeFor(sessionId).set({ path, seq: this.nextSeq++, ...(workspaceId !== undefined && { workspaceId }) })
  }

  /** @inheritdoc */
  storeFor(sessionId: SessionId): SnapshotStore<PendingFileOpen | undefined> {
    const existing = this.stores.get(sessionId)
    if (existing !== undefined) return existing
    const created = createSnapshotStore<PendingFileOpen | undefined>(undefined)
    this.stores.set(sessionId, created)
    return created
  }

  /** @inheritdoc */
  forget(sessionId: SessionId): void {
    this.stores.delete(sessionId)
  }
}
