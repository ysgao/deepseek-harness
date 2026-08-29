/** Test-owned workspaces face: the renderer standard-kit observable plus recorded actions. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  IWorkspaces, WorkspaceEntryListing, WorkspaceFileContent, WorkspaceFileDiff, WorkspaceFileVersion,
  WorkspaceGitStatus, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { workspaceSnapshot } from './fixtures.ts'
import type { FixtureSnapshot, Stabilizer } from './fixtures.ts'

/** Writable test representation of the immutable Workspace Controller snapshot. */
type WorkspaceFixtureSnapshot = FixtureSnapshot<WorkspaceSnapshot>

/** Callable command names on the production Workspace Controller face. */
type WorkspaceAction = {
  [Key in keyof IWorkspaces]: IWorkspaces[Key] extends (...args: never[]) => unknown ? Key : never
}[keyof IWorkspaces]

/** Test replacement retaining one Controller command's parameters and result. */
type WorkspaceStub<Key extends WorkspaceAction> = (
  ...args: Parameters<IWorkspaces[Key]>
) => ReturnType<IWorkspaces[Key]>

/**
 * Workspaces test double. Implements the same IWorkspaces face features
 * receive as `ctx.workspaces`, so a production face change breaks this
 * double at compile time. Every action records into {@link
 * TestWorkspaces.calls}; defaults are inert echoes — feature tests needing
 * richer behavior replace them via {@link TestWorkspaces.stub}.
 */
export class TestWorkspaces implements IWorkspaces {
  /** The useWorkspaces standard feed. */
  readonly list: SnapshotStore<WorkspaceFixtureSnapshot>

  /** Calls observed on the action face, newest last. */
  readonly calls: { method: string; args: unknown[] }[] = []

  /** Replaceable action seat: feature tests may stub richer behavior. */
  private readonly stubs = new Map<WorkspaceAction, (...args: unknown[]) => unknown>()

  /**
   * @param stabilize - the owning runtime's act wrapper.
   */
  constructor(private readonly stabilize: Stabilizer) {
    this.list = createSnapshotStore<WorkspaceFixtureSnapshot>({ ...workspaceSnapshot() })
  }

  /**
   * Update the workspace list state through an immer draft.
   * @param mutate - draft mutator.
   */
  async update(mutate: (draft: WorkspaceFixtureSnapshot) => void): Promise<void> {
    await this.stabilize(() => { this.list.update(mutate) })
  }

  /**
   * Replace an action's behavior (the recorded call is still appended first).
   * @param method - Controller action name (e.g. 'create').
   * @param impl - replacement behavior.
   */
  stub<Key extends WorkspaceAction>(method: Key, impl: WorkspaceStub<Key>): void {
    this.stubs.set(method, impl as (...args: unknown[]) => unknown)
  }

  /**
   * Create a Workspace (recorded). The default echoes a view derived from
   * the input; stub for failure or list-coupled flows.
   * @param input - the Host create payload.
   * @returns the created Workspace view.
   */
  async create(input: { path: string }): Promise<WorkspaceView> {
    this.calls.push({ method: 'create', args: [input] })
    const stub = this.stubs.get('create')
    if (stub !== undefined) return await (stub(input) as Promise<WorkspaceView>)
    return {
      workspaceId: `ws-${input.path}` as WorkspaceId,
      title: input.path,
      path: input.path,
      sessionIds: [],
    } as unknown as WorkspaceView
  }

  /**
   * Rename a Workspace (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param title - new title.
   * @returns the updated view.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    this.calls.push({ method: 'rename', args: [workspaceId, title] })
    const stub = this.stubs.get('rename')
    if (stub !== undefined) return await (stub(workspaceId, title) as Promise<WorkspaceView>)
    return { workspaceId, title, path: `/${title}`, sessionIds: [] } as unknown as WorkspaceView
  }

  /**
   * Delete a Workspace (recorded; default no-op).
   * @param workspaceId - target workspace.
   */
  async delete(workspaceId: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'delete', args: [workspaceId] })
    await (this.stubs.get('delete')?.(workspaceId) as Promise<void> | undefined)
  }

  /**
   * Move a Workspace in display order (recorded; default no-op).
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor; omitted appends.
   */
  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'insertBefore', args: [workspaceId, beforeWorkspaceId] })
    await (this.stubs.get('insertBefore')?.(workspaceId, beforeWorkspaceId) as Promise<void> | undefined)
  }

  /**
   * Move an accounted session (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param sessionId - session to move.
   * @param beforeSessionId - anchor; omitted appends.
   * @returns the updated view.
   */
  async insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView> {
    this.calls.push({ method: 'insertSessionBefore', args: [workspaceId, sessionId, beforeSessionId] })
    const stub = this.stubs.get('insertSessionBefore')
    if (stub !== undefined) return await (stub(workspaceId, sessionId, beforeSessionId) as Promise<WorkspaceView>)
    return { workspaceId, title: '', path: '', sessionIds: [sessionId] } as unknown as WorkspaceView
  }

  /**
   * Archive a session (recorded). The default mirrors the production face's
   * observable effect: the id joins the list state's archive set.
   * @param sessionId - session to archive.
   */
  async archiveSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'archiveSession', args: [sessionId] })
    const stub = this.stubs.get('archiveSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.archivedSessionIds = [...draft.archivedSessionIds, sessionId]
    })
  }

  /**
   * List one directory level under a Workspace root (recorded). The default
   * serves an empty level; stub to shape a tree.
   * @param workspaceId - owning workspace.
   * @param path - absolute directory to list.
   * @param signal - forwarded like the production face.
   * @returns the level's entries and truncation flag.
   */
  async listEntries(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<WorkspaceEntryListing> {
    this.calls.push({ method: 'listEntries', args: [workspaceId, path, signal] })
    const stub = this.stubs.get('listEntries')
    if (stub !== undefined) return await (stub(workspaceId, path, signal) as Promise<WorkspaceEntryListing>)
    return { path, entries: [], truncated: false }
  }

  /**
   * Read one file under a Workspace root (recorded). The default serves
   * empty text content; stub to shape a preview.
   * @param workspaceId - owning workspace.
   * @param path - absolute file path.
   * @param signal - forwarded like the production face.
   * @returns the decoded content.
   */
  async readFile(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<WorkspaceFileContent> {
    this.calls.push({ method: 'readFile', args: [workspaceId, path, signal] })
    const stub = this.stubs.get('readFile')
    if (stub !== undefined) return await (stub(workspaceId, path, signal) as Promise<WorkspaceFileContent>)
    return { kind: 'text', content: '', version: 'test-version' as WorkspaceFileVersion }
  }

  /**
   * Report a Workspace's git status (recorded). The default reports no
   * repository; stub to shape a branch and pending changes.
   * @param workspaceId - owning workspace.
   * @param signal - forwarded like the production face.
   * @returns the workspace's git status.
   */
  async gitStatus(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<WorkspaceGitStatus> {
    this.calls.push({ method: 'gitStatus', args: [workspaceId, signal] })
    const stub = this.stubs.get('gitStatus')
    if (stub !== undefined) return await (stub(workspaceId, signal) as Promise<WorkspaceGitStatus>)
    return { isRepo: false, branch: null, files: {} }
  }

  /**
   * Stage and commit every pending change (recorded). The default resolves with no effect; stub to simulate failure.
   * @param workspaceId - owning workspace.
   * @param message - commit message.
   * @param signal - forwarded like the production face.
   */
  async commitAllChanges(workspaceId: WorkspaceId, message: string, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: 'commitAllChanges', args: [workspaceId, message, signal] })
    const stub = this.stubs.get('commitAllChanges')
    if (stub !== undefined) await (stub(workspaceId, message, signal) as Promise<void>)
  }

  /**
   * Revert every tracked file's pending change (recorded). The default resolves with no effect; stub to simulate failure.
   * @param workspaceId - owning workspace.
   * @param signal - forwarded like the production face.
   */
  async discardAllChanges(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: 'discardAllChanges', args: [workspaceId, signal] })
    const stub = this.stubs.get('discardAllChanges')
    if (stub !== undefined) await (stub(workspaceId, signal) as Promise<void>)
  }

  /**
   * Fetch from the remote and rebase local commits on top (recorded). The default resolves with no effect; stub to simulate failure.
   * @param workspaceId - owning workspace.
   * @param signal - forwarded like the production face.
   */
  async pullRebase(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: 'pullRebase', args: [workspaceId, signal] })
    const stub = this.stubs.get('pullRebase')
    if (stub !== undefined) await (stub(workspaceId, signal) as Promise<void>)
  }

  /**
   * Push the current branch to its configured remote (recorded). The default resolves with no effect; stub to simulate failure.
   * @param workspaceId - owning workspace.
   * @param signal - forwarded like the production face.
   */
  async push(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: 'push', args: [workspaceId, signal] })
    const stub = this.stubs.get('push')
    if (stub !== undefined) await (stub(workspaceId, signal) as Promise<void>)
  }

  /**
   * Read one file's `HEAD` and working-tree text (recorded). The default
   * reports neither side present; stub to shape a diff.
   * @param workspaceId - owning workspace.
   * @param path - absolute file path.
   * @param signal - forwarded like the production face.
   * @returns the diff text.
   */
  async gitFileDiff(workspaceId: WorkspaceId, path: string, signal?: AbortSignal): Promise<WorkspaceFileDiff> {
    this.calls.push({ method: 'gitFileDiff', args: [workspaceId, path, signal] })
    const stub = this.stubs.get('gitFileDiff')
    if (stub !== undefined) return await (stub(workspaceId, path, signal) as Promise<WorkspaceFileDiff>)
    return { oldText: null, newText: null }
  }

  /**
   * Overwrite one file's content (recorded). The default echoes a version
   * derived from `content`; stub to simulate a `file-changed` rejection.
   * @param workspaceId - owning workspace.
   * @param path - absolute file path.
   * @param content - the full new UTF-8 text content.
   * @param expectedVersion - the version last observed for this path.
   * @param signal - forwarded like the production face.
   * @returns the version the write produced.
   */
  async writeFile(
    workspaceId: WorkspaceId, path: string, content: string, expectedVersion: WorkspaceFileVersion, signal?: AbortSignal,
  ): Promise<WorkspaceFileVersion> {
    this.calls.push({ method: 'writeFile', args: [workspaceId, path, content, expectedVersion, signal] })
    const stub = this.stubs.get('writeFile')
    if (stub !== undefined) return await (stub(workspaceId, path, content, expectedVersion, signal) as Promise<WorkspaceFileVersion>)
    return `test-version-${content.length}` as WorkspaceFileVersion
  }

  /**
   * Create one new, empty file (recorded). The default echoes the joined
   * path; stub to simulate an `already-exists`/`parent-missing` rejection.
   * @param workspaceId - owning workspace.
   * @param parentPath - existing parent directory.
   * @param name - new file's name.
   * @param signal - forwarded like the production face.
   * @returns the created file's absolute path.
   */
  async createFile(workspaceId: WorkspaceId, parentPath: string, name: string, signal?: AbortSignal): Promise<string> {
    this.calls.push({ method: 'createFile', args: [workspaceId, parentPath, name, signal] })
    const stub = this.stubs.get('createFile')
    if (stub !== undefined) return await (stub(workspaceId, parentPath, name, signal) as Promise<string>)
    return `${parentPath}/${name}`
  }

  /**
   * Create one new, empty directory (recorded). The default echoes the
   * joined path; stub to simulate an `already-exists`/`parent-missing` rejection.
   * @param workspaceId - owning workspace.
   * @param parentPath - existing parent directory.
   * @param name - new directory's name.
   * @param signal - forwarded like the production face.
   * @returns the created directory's absolute path.
   */
  async createDirectory(workspaceId: WorkspaceId, parentPath: string, name: string, signal?: AbortSignal): Promise<string> {
    this.calls.push({ method: 'createDirectory', args: [workspaceId, parentPath, name, signal] })
    const stub = this.stubs.get('createDirectory')
    if (stub !== undefined) return await (stub(workspaceId, parentPath, name, signal) as Promise<string>)
    return `${parentPath}/${name}`
  }
}
