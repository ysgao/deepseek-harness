/** Host Workspace Remote owner: explicit commands and reconnect-safe state. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceCommands } from './commands.ts'
import { DirectoryPickerController } from './directory-picker.ts'
import { WorkspaceFeed } from './feed.ts'
import { WorkspaceFileCommands } from './file-commands.ts'
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_READ_BYTES } from './files.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceEntryListing,
  WorkspaceFileContent,
  WorkspaceFileDiff,
  WorkspaceFollowFrame,
  WorkspaceGitCommitAllRequest,
  WorkspaceGitCommitAllValue,
  WorkspaceGitDiscardAllValue,
  WorkspaceGitFileDiffRequest,
  WorkspaceGitPullRebaseValue,
  WorkspaceGitPushValue,
  WorkspaceGitRequest,
  WorkspaceGitStatus,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceListEntriesRequest,
  WorkspaceOrderValue,
  WorkspaceReadFileRequest,
  WorkspaceRenameRequest,
  WorkspaceValue,
  WorkspaceWriteFileRequest,
  WorkspaceWriteFileValue,
} from './types.ts'

export type * from './types.ts'
export { DirectoryPickerController } from './directory-picker.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Workspace business API and Remote namespace owner. */
    workspaceController: WorkspaceController
  }
}

/** Workspace Controller deployment policy. */
export interface Config {
  /** Maximum entries listed per Files-tree directory level before truncation. */
  readonly workspaceFilesMaxEntries?: number
  /** Maximum bytes read or written for one Workspace file. */
  readonly workspaceFilesMaxReadBytes?: number
}

/** Host service backing the generated `ctx.remote.workspace` namespace. */
export class WorkspaceController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry']

  static Config: z<Config> = z.object({
    workspaceFilesMaxEntries: z.natural().default(DEFAULT_MAX_ENTRIES),
    workspaceFilesMaxReadBytes: z.natural().default(DEFAULT_MAX_READ_BYTES),
  })

  private readonly commands: WorkspaceCommands
  private readonly feed: WorkspaceFeed
  private readonly files: WorkspaceFileCommands

  /**
   * @param ctx - Host context containing the Workspace registry.
   * @param config - Files-tree listing and read/write byte bounds.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspaceController', { namespace: 'workspace' })
    this.commands = new WorkspaceCommands(ctx)
    this.feed = new WorkspaceFeed(ctx)
    this.files = new WorkspaceFileCommands(ctx, {
      ...(config.workspaceFilesMaxEntries === undefined ? {} : { maxEntries: config.workspaceFilesMaxEntries }),
      ...(config.workspaceFilesMaxReadBytes === undefined ? {} : { maxReadBytes: config.workspaceFilesMaxReadBytes }),
    })
    // This package is the Loader entry for both Remote owners it hosts: the
    // directory-picking seam is abstract and never an entry itself. The child
    // stays pending until a picking backend is composed, so a host without one
    // registers no picking namespace instead of answering an unservable verb.
    ctx.plugin(DirectoryPickerController)
  }

  /**
   * Create or idempotently resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  @Remote('create')
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.commands.create(request)
  }

  /**
   * Rename one Workspace to a unique non-blank title.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  @Remote('rename')
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    return this.commands.rename(request)
  }

  /**
   * Remove one Workspace registration while retaining files and Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  @Remote('delete')
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.commands.delete(request)
  }

  /**
   * Move one Workspace within the registry display order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  @Remote('insertBefore')
  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    return this.commands.insertBefore(request)
  }

  /**
   * Move one accounted Session within a Workspace.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  @Remote('insertSessionBefore')
  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    return this.commands.insertSessionBefore(request)
  }

  /**
   * Hide one known Session from Workspace grouping surfaces.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  @Remote('archiveSession')
  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.archiveSession(request)
  }

  /**
   * Stream a complete Workspace baseline followed by ordered increments.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    return this.feed.follow(signal)
  }

  /**
   * Lists one directory level under a workspace root: subdirectories and
   * regular files together. `path` must be the workspace's own canonical
   * path or a descendant of it.
   * @param request - workspace identity and target directory.
   * @param signal - caller lifetime; abort stops the scan.
   * @returns the level's entries and truncation flag.
   */
  @Remote('listEntries')
  listEntries(request: WorkspaceListEntriesRequest, signal: AbortSignal): Promise<WorkspaceEntryListing> {
    return this.files.listEntries(request, signal)
  }

  /**
   * Reads one regular file under a workspace root for in-app preview.
   * @param request - workspace identity and target file.
   * @param signal - caller lifetime; abort stops the read.
   * @returns the decoded content.
   */
  @Remote('readFile')
  readFile(request: WorkspaceReadFileRequest, signal: AbortSignal): Promise<WorkspaceFileContent> {
    return this.files.readFile(request, signal)
  }

  /**
   * Overwrites one existing regular file under a workspace root, guarded by
   * `expectedVersion` against a concurrent change.
   * @param request - workspace identity, target file, new content, and expected version.
   * @param signal - caller lifetime; abort rejects before publication.
   * @returns the version the write produced.
   */
  @Remote('writeFile')
  writeFile(request: WorkspaceWriteFileRequest, signal: AbortSignal): Promise<WorkspaceWriteFileValue> {
    return this.files.writeFile(request, signal)
  }

  /**
   * Reports the current branch and pending file changes of the git
   * repository enclosing a workspace's own directory.
   * @param request - workspace identity.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns the workspace's git status.
   */
  @Remote('gitStatus')
  gitStatus(request: WorkspaceGitRequest, signal: AbortSignal): Promise<WorkspaceGitStatus> {
    return this.files.gitStatus(request, signal)
  }

  /**
   * Stages every pending change and commits them.
   * @param request - workspace identity and commit message.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns commit confirmation.
   */
  @Remote('gitCommitAll')
  gitCommitAll(request: WorkspaceGitCommitAllRequest, signal: AbortSignal): Promise<WorkspaceGitCommitAllValue> {
    return this.files.gitCommitAll(request, signal)
  }

  /**
   * Reverts every tracked file's pending change to its `HEAD` content.
   * @param request - workspace identity.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns discard confirmation.
   */
  @Remote('gitDiscardAll')
  gitDiscardAll(request: WorkspaceGitRequest, signal: AbortSignal): Promise<WorkspaceGitDiscardAllValue> {
    return this.files.gitDiscardAll(request, signal)
  }

  /**
   * Fetches from the remote tracked by the current branch and rebases local commits on top.
   * @param request - workspace identity.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns pull confirmation.
   */
  @Remote('gitPullRebase')
  gitPullRebase(request: WorkspaceGitRequest, signal: AbortSignal): Promise<WorkspaceGitPullRebaseValue> {
    return this.files.gitPullRebase(request, signal)
  }

  /**
   * Pushes the current branch to its configured remote.
   * @param request - workspace identity.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns push confirmation.
   */
  @Remote('gitPush')
  gitPush(request: WorkspaceGitRequest, signal: AbortSignal): Promise<WorkspaceGitPushValue> {
    return this.files.gitPush(request, signal)
  }

  /**
   * Reads one file's `HEAD` and current working-tree text, for a side-by-side diff.
   * @param request - workspace identity and target file.
   * @param signal - caller lifetime; abort rejects with the abort reason.
   * @returns the file's `HEAD` and working-tree text.
   */
  @Remote('gitFileDiff')
  gitFileDiff(request: WorkspaceGitFileDiffRequest, signal: AbortSignal): Promise<WorkspaceFileDiff> {
    return this.files.gitFileDiff(request, signal)
  }
}

export default WorkspaceController
