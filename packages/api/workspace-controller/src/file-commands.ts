/**
 * Glue between the Workspace registry, the pure file/git primitives in
 * `files.ts`/`workspace-git.ts`, and stable Remote failure mapping: resolves
 * a `workspaceId` to its directory, enforces workspace-root containment for
 * every path-taking method, and folds `WorkspaceFileError`/
 * `GitNotARepositoryError`/`GitCommandError` into `TypertRemoteFailure`.
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  createWorkspaceDirectory, createWorkspaceFile, isWithinWorkspace, listWorkspaceEntries, readWorkspaceFile,
  resolveWorkspacePath, WorkspaceFileError, writeWorkspaceFile,
} from './files.ts'
import {
  commitAllChanges, discardAllChanges, fetchRemote, GitCommandError, GitNotARepositoryError, pullRebase, push,
  workspaceFileAtHead, workspaceGitStatus,
} from './workspace-git.ts'
import type {
  WorkspaceCreateDirectoryValue,
  WorkspaceCreateEntryRequest,
  WorkspaceCreateFileValue,
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
  WorkspaceGitRequest,
  WorkspaceGitStatus,
  WorkspaceListEntriesRequest,
  WorkspaceReadFileRequest,
  WorkspaceWriteFileRequest,
  WorkspaceWriteFileValue,
} from './types.ts'

/** A single non-blank path segment: non-blank, not `.`/`..`, no path separator. */
function isValidEntryName(name: string): boolean {
  return name.trim() !== '' && name !== '.' && name !== '..' && !/[/\\]/.test(name)
}

/** Workspace file-tree deployment policy. */
export interface WorkspaceFileCommandsConfig {
  /** Maximum entries listed per directory level before truncation. */
  readonly maxEntries?: number
  /** Maximum bytes read or written for one file. */
  readonly maxReadBytes?: number
}

/** Implements Workspace file-tree browsing, in-app editing, and git actions. */
export class WorkspaceFileCommands {
  private readonly maxEntries: number | undefined
  private readonly maxReadBytes: number | undefined

  /**
   * @param ctx - Host context containing the Workspace registry.
   * @param config - file-tree listing and read/write byte bounds.
   */
  constructor(private readonly ctx: Context, config: WorkspaceFileCommandsConfig = {}) {
    this.maxEntries = config.maxEntries
    this.maxReadBytes = config.maxReadBytes
  }

  /**
   * Lists one directory level under a workspace root.
   * @param request - workspace identity and target directory.
   * @param signal - caller lifetime; abort stops the scan.
   * @returns the level's entries and truncation flag.
   */
  listEntries(request: WorkspaceListEntriesRequest, signal: AbortSignal): Promise<WorkspaceEntryListing> {
    const path = this.requireContainedPath(request.workspaceId, request.path)
    return listWorkspaceEntries(path, this.maxEntries, signal).catch(mapFileError)
  }

  /**
   * Reads one regular file under a workspace root for in-app preview.
   * @param request - workspace identity and target file.
   * @param signal - caller lifetime; abort stops the read.
   * @returns the decoded content.
   */
  readFile(request: WorkspaceReadFileRequest, signal: AbortSignal): Promise<WorkspaceFileContent> {
    const path = this.requireContainedPath(request.workspaceId, request.path)
    return readWorkspaceFile(path, this.maxReadBytes, signal).catch(mapFileError)
  }

  /**
   * Overwrites one existing regular file under a workspace root, guarded by
   * `expectedVersion` against a concurrent change.
   * @param request - workspace identity, target file, new content, and expected version.
   * @param signal - caller lifetime; abort rejects before publication.
   * @returns the version the write produced.
   */
  async writeFile(request: WorkspaceWriteFileRequest, signal: AbortSignal): Promise<WorkspaceWriteFileValue> {
    const path = this.requireContainedPath(request.workspaceId, request.path)
    const version = await writeWorkspaceFile(path, request.content, request.expectedVersion, this.maxReadBytes, signal)
      .catch(mapFileError)
    return { version }
  }

  /**
   * Creates one new, empty regular file as a child of `parentPath` under a
   * workspace root — the Files tree's "Add file" action. Never overwrites
   * an existing file (a distinct primitive from `writeFile`, which only
   * ever overwrites).
   * @param request - workspace identity, target parent directory, and new file's name.
   * @param signal - caller lifetime; abort rejects before creation.
   * @returns the created file's absolute path and initial content version.
   */
  async createFile(request: WorkspaceCreateEntryRequest, signal: AbortSignal): Promise<WorkspaceCreateFileValue> {
    const path = this.requireContainedChildPath(request)
    const version = await createWorkspaceFile(path, signal).catch(mapFileError)
    return { path, version }
  }

  /**
   * Creates one new, empty directory as a child of `parentPath` under a
   * workspace root — the Files tree's "Add folder" action.
   * @param request - workspace identity, target parent directory, and new directory's name.
   * @param signal - caller lifetime; abort rejects before creation.
   * @returns the created directory's absolute path.
   */
  async createDirectory(request: WorkspaceCreateEntryRequest, signal: AbortSignal): Promise<WorkspaceCreateDirectoryValue> {
    const path = this.requireContainedChildPath(request)
    await createWorkspaceDirectory(path, signal).catch(mapFileError)
    return { path }
  }

  /**
   * Reports the current branch and pending file changes of the git
   * repository enclosing a workspace's own directory.
   * @param request - workspace identity.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns the workspace's git status.
   */
  gitStatus(request: WorkspaceGitRequest, signal: AbortSignal): Promise<WorkspaceGitStatus> {
    const path = this.requireWorkspacePath(request.workspaceId)
    return workspaceGitStatus(path, signal)
  }

  /**
   * Stages every pending change and commits them.
   * @param request - workspace identity and commit message.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns commit confirmation.
   */
  async gitCommitAll(request: WorkspaceGitCommitAllRequest, signal: AbortSignal): Promise<WorkspaceGitCommitAllValue> {
    const message = request.message.trim()
    if (message === '') {
      throw failure('bad-request', 'a commit message must be non-blank', {})
    }
    const path = this.requireWorkspacePath(request.workspaceId)
    await commitAllChanges(path, message, signal).catch(mapGitError)
    return { committed: true }
  }

  /**
   * Reverts every tracked file's pending change to its `HEAD` content.
   * @param request - workspace identity.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns discard confirmation.
   */
  async gitDiscardAll(request: WorkspaceGitRequest, signal: AbortSignal): Promise<WorkspaceGitDiscardAllValue> {
    const path = this.requireWorkspacePath(request.workspaceId)
    await discardAllChanges(path, signal).catch(mapGitError)
    return { discarded: true }
  }

  /**
   * Downloads new commits and updates the workspace's remote-tracking refs,
   * without touching the current branch or working tree.
   * @param request - workspace identity.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns fetch confirmation.
   */
  async gitFetch(request: WorkspaceGitRequest, signal: AbortSignal): Promise<WorkspaceGitFetchValue> {
    const path = this.requireWorkspacePath(request.workspaceId)
    await fetchRemote(path, signal).catch(mapGitError)
    return { fetched: true }
  }

  /**
   * Rebases local commits onto the current branch's already-known upstream,
   * without fetching first (pair with {@link gitFetch} for the rebase to
   * include the remote's very latest commits).
   * @param request - workspace identity.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns pull confirmation.
   */
  async gitPullRebase(request: WorkspaceGitRequest, signal: AbortSignal): Promise<WorkspaceGitPullRebaseValue> {
    const path = this.requireWorkspacePath(request.workspaceId)
    await pullRebase(path, signal).catch(mapGitError)
    return { pulled: true }
  }

  /**
   * Pushes the current branch to its configured remote.
   * @param request - workspace identity.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns push confirmation.
   */
  async gitPush(request: WorkspaceGitRequest, signal: AbortSignal): Promise<WorkspaceGitPushValue> {
    const path = this.requireWorkspacePath(request.workspaceId)
    await push(path, signal).catch(mapGitError)
    return { pushed: true }
  }

  /**
   * Reads one file's `HEAD` and current working-tree text, for a side-by-side diff.
   * @param request - workspace identity and target file.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns the file's `HEAD` and working-tree text.
   */
  async gitFileDiff(request: WorkspaceGitFileDiffRequest, signal: AbortSignal): Promise<WorkspaceFileDiff> {
    const workspacePath = this.requireWorkspacePath(request.workspaceId)
    const path = this.requireContainedPath(request.workspaceId, request.path)
    const oldText = await workspaceFileAtHead(workspacePath, path, signal).catch(mapGitError)
    let newText: string | null
    try {
      const content = await readWorkspaceFile(path, this.maxReadBytes, signal)
      // A binary working-tree read has no text diff to show; the client only
      // offers the diff toggle for a text-kind file, so this folds the same
      // as "absent" here rather than earning its own wire state.
      newText = content.kind === 'text' ? content.content : null
    } catch (error) {
      if (error instanceof WorkspaceFileError && error.code === 'directory-unreadable') {
        newText = null // deleted from the working tree since the last git operation.
      } else {
        mapFileError(error)
      }
    }
    return { oldText, newText }
  }

  private requireWorkspacePath(workspaceId: WorkspaceId): string {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined) {
      throw failure('workspace-not-found', `Workspace "${workspaceId}" not found`, { workspaceId })
    }
    return workspace.path
  }

  private requireContainedPath(workspaceId: WorkspaceId, requestedPath: string): string {
    const root = this.requireWorkspacePath(workspaceId)
    const path = resolveWorkspacePath(requestedPath)
    if (!isWithinWorkspace(root, path)) {
      throw failure('directory-unreadable', `"${requestedPath}" is outside workspace "${workspaceId}"`, { path: requestedPath })
    }
    return path
  }

  /** Validate a create request's `name` as one path segment, then join and contain it under `parentPath`. */
  private requireContainedChildPath(request: WorkspaceCreateEntryRequest): string {
    if (!isValidEntryName(request.name)) {
      throw failure('invalid-name', `"${request.name}" is not a valid file or folder name`, { name: request.name })
    }
    const parent = this.requireContainedPath(request.workspaceId, request.parentPath)
    return join(parent, request.name)
  }
}

function mapFileError(error: unknown): never {
  if (error instanceof WorkspaceFileError) {
    if (error.code === 'file-too-large') {
      /* v8 ignore next -- WorkspaceFileError's own contract guarantees maxBytes for this code; the
         fallback only satisfies the constructor's shared optional-for-other-codes type. */
      throw failure('file-too-large', error.message, { path: error.path, maxBytes: error.maxBytes ?? 0 })
    }
    if (error.code === 'file-changed') {
      throw failure('file-changed', error.message, { path: error.path })
    }
    if (error.code === 'already-exists') {
      throw failure('already-exists', error.message, { path: error.path })
    }
    if (error.code === 'parent-missing') {
      throw failure('parent-missing', error.message, { path: error.path })
    }
    throw failure('directory-unreadable', error.message, { path: error.path })
  }
  throw error
}

function mapGitError(error: unknown): never {
  if (error instanceof GitNotARepositoryError) {
    throw failure('git-not-a-repository', error.message, { path: error.path })
  }
  if (error instanceof GitCommandError) {
    throw failure('git-command-failed', error.message, { command: error.command })
  }
  throw error
}

function failure(code: string, message: string, details: object): TypertRemoteFailure {
  return new TypertRemoteFailure({ code, message, details })
}
