/**
 * The outward workspaces-service face — what `ctx.workspaces` exposes to
 * feature packages and the renderer host, and therefore exactly what the
 * test runtime's workspaces double must implement. Wire-pump entry points
 * (handleHostEnvelope/handleConnected/refresh/startInitialSelection) stay on
 * the concrete class. Widening this interface is the explicit act of
 * widening what features may do to the workspaces domain.
 */
import type {
  DirectoryListing, SessionId, WorkspaceEntryListing, WorkspaceFileContent, WorkspaceGitStatus, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from '../workspaces/service.ts'
import type { ObservableSnapshot } from './store.ts'

/** The workspaces-service face injected as `ctx.workspaces`. */
export interface IWorkspaces {
  /** The useWorkspaces standard feed (read face — writes stay inside the domain). */
  readonly list: ObservableSnapshot<WorkspaceListState>
  /**
   * Connect a Workspace to its reusable or freshly created blank session.
   * @param workspaceId - target workspace.
   * @returns the connected session id.
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  /**
   * The New Session flow: connect the explicit, current-Session, or recent
   * Workspace and open the resulting session; failures surface on the session
   * list state.
   * @param workspaceId - explicit target; omitted inherits the current
   * Session's Workspace before falling back to the recency projection.
   */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * Register an existing path as a Workspace.
   * @param input - the Host create payload.
   * @returns the created or idempotently resolved Workspace.
   */
  create(input: { path: string }): Promise<WorkspaceView>
  /**
   * Open the Host's native directory picker.
   * @returns the selected path, or null when the user cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * List one directory level through the Host's `browse` capability.
   * @param path - absolute directory to list; absent lists the Host home directory.
   * @param signal - aborts the wire request (and the Host's scan) when the caller supersedes it.
   * @returns the level's listing with breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create one child directory through the Host's `browse` capability.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank path segment.
   * @returns the created directory's absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>
  /**
   * Open a filesystem path with the Host operating system's default application.
   * @param path - absolute or host-resolvable path.
   */
  openPath(path: string): Promise<void>
  /**
   * Rename a Workspace.
   * @param workspaceId - target workspace.
   * @param title - the new display title.
   * @returns the updated Workspace view.
   */
  rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>
  /**
   * Delete a Workspace (its sessions fall back to the unaccounted group).
   * @param workspaceId - target workspace.
   */
  delete(workspaceId: WorkspaceId): Promise<void>
  /**
   * Move a Workspace within the registry display order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor workspace; omitted appends.
   */
  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>
  /**
   * Move an accounted session within/into a Workspace's ordered list.
   * @param workspaceId - target workspace.
   * @param sessionId - accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   * @returns the updated Workspace view.
   */
  insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView>
  /**
   * Archive a session into the registry-global set (hidden from grouping
   * surfaces; session log and accounting slot remain). Archiving the current
   * session clears the selection into the New Session view state.
   * @param sessionId - session to archive.
   */
  archiveSession(sessionId: SessionId): Promise<void>
  /**
   * List one directory level under a Workspace root: subdirectories AND
   * regular files together (the Files sidebar sibling to a Workspace's
   * session list) — unlike {@link listDirectory}, which serves only the
   * directory-only workspace-root picker.
   * @param workspaceId - owning workspace; `path` must be its own path or a descendant.
   * @param path - absolute directory to list.
   * @param signal - aborts the wire request (and the Host's scan) when the caller supersedes it.
   * @returns the level's entries and truncation flag.
   */
  listWorkspaceEntries(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<WorkspaceEntryListing>
  /**
   * Read one regular file under a Workspace root for in-app preview.
   * @param workspaceId - owning workspace; `path` must be its own path or a descendant.
   * @param path - absolute file path.
   * @param signal - aborts the wire request when the caller supersedes it.
   * @returns the decoded content (text, or base64 binary with a media type).
   */
  readWorkspaceFile(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<WorkspaceFileContent>
  /**
   * Report a Workspace's current git branch and pending file changes, from
   * the repository enclosing its own directory (the Files tree sibling's
   * header and per-row change markers).
   * @param workspaceId - target workspace.
   * @param signal - aborts the wire request when the caller supersedes it.
   * @returns the workspace's git status; `isRepo: false` when its directory is outside any git working tree.
   */
  listWorkspaceGitStatus(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<WorkspaceGitStatus>
  /**
   * Stage every pending change (tracked and untracked) and commit them with
   * `message` to the git repository enclosing the Workspace's directory.
   * @param workspaceId - target workspace.
   * @param message - commit message; must be non-blank.
   * @param signal - aborts the wire request when the caller supersedes it.
   */
  commitAllWorkspaceChanges(workspaceId: WorkspaceId, message: string, signal?: AbortSignal): Promise<void>
  /**
   * Revert every tracked file's pending change to its `HEAD` content in the
   * git repository enclosing the Workspace's directory; an untracked file is
   * left untouched.
   * @param workspaceId - target workspace.
   * @param signal - aborts the wire request when the caller supersedes it.
   */
  discardAllWorkspaceChanges(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void>
}
