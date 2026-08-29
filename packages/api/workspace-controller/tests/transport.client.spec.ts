import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  RemoteStream,
  RemoteStreamCarrierError,
  type RemoteStreamOptions,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import * as WorkspaceClientPlugin from '../src/client/index.ts'
import {
  ClientWorkspaceModel,
  createWorkspaceStateStream,
  WorkspaceController,
  WorkspaceCreateError,
  WorkspaceFileBrowseError,
  type WorkspaceFollowSink,
  type WorkspaceRemote,
} from '../src/client/index.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateDirectoryValue,
  WorkspaceCreateEntryRequest,
  WorkspaceCreateFileValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceEntryListing,
  WorkspaceFileContent,
  WorkspaceFileDiff,
  WorkspaceFileVersion,
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
  WorkspaceError,
  WorkspaceId,
  WorkspaceValue,
  WorkspaceView,
  WorkspaceWriteFileRequest,
  WorkspaceWriteFileValue,
} from '../src/types.ts'

const AVAILABLE_CONNECTION = {
  generation: {
    getSnapshot: () => ({ id: 1, host: { home: '/home/fixture' } }),
    subscribe: () => () => {},
  },
}

function workspaceClient(
  remote: WorkspaceRemote,
  connection: Pick<ConnectionHandle, 'generation'> = AVAILABLE_CONNECTION,
) {
  return {
    workspace: remote,
    $stream: <Item>(options: RemoteStreamOptions<Item>) => new RemoteStream(connection, options),
  }
}

interface Generation {
  readonly frames: readonly WorkspaceFollowFrame[]
  readonly error?: unknown
  readonly hold?: boolean
  readonly afterAbort?: () => void
  readonly afterAbortError?: unknown
}

const baseline = (id?: string): Extract<WorkspaceFollowFrame, { type: 'baseline' }> => ({
  type: 'baseline',
  value: {
    items: id === undefined ? [] : [{
      workspaceId: id as never,
      path: `/work/${id}`,
      title: id,
      sessionIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    archivedSessionIds: [],
  },
})

const wid = (id: string): WorkspaceId => id as WorkspaceId
const sid = (id: string): SessionId => SessionId(id)

function workspace(id: string, overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: wid(id),
    path: `/work/${id}`,
    title: id,
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function remoteOk<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function remoteFailure(error: WorkspaceError): RemoteResult<never> {
  return { ok: false, error }
}

function accepts(overrides: Partial<WorkspaceFollowSink> = {}): WorkspaceFollowSink {
  const ignore = (): void => {}
  return {
    replaceBaseline: ignore,
    upsertView: ignore,
    removeView: ignore,
    replaceOrder: ignore,
    replaceArchived: ignore,
    ...overrides,
  }
}

class ScriptedWorkspaceRemote implements WorkspaceRemote {
  readonly signals: AbortSignal[] = []
  calls = 0

  constructor(private readonly generations: readonly Generation[]) {}

  create(_request: WorkspaceCreateRequest): Promise<RemoteResult<WorkspaceCreateValue>> {
    throw new Error('unused')
  }

  rename(_request: WorkspaceRenameRequest): Promise<RemoteResult<WorkspaceValue>> {
    throw new Error('unused')
  }

  delete(_request: WorkspaceDeleteRequest): Promise<RemoteResult<WorkspaceDeleteValue>> {
    throw new Error('unused')
  }

  insertBefore(_request: WorkspaceInsertBeforeRequest): Promise<RemoteResult<WorkspaceOrderValue>> {
    throw new Error('unused')
  }

  insertSessionBefore(_request: WorkspaceInsertSessionBeforeRequest): Promise<RemoteResult<WorkspaceValue>> {
    throw new Error('unused')
  }

  archiveSession(_request: WorkspaceArchiveSessionRequest): Promise<RemoteResult<WorkspaceArchiveValue>> {
    throw new Error('unused')
  }

  listEntries(_request: WorkspaceListEntriesRequest): Promise<RemoteResult<WorkspaceEntryListing>> {
    throw new Error('unused')
  }

  readFile(_request: WorkspaceReadFileRequest): Promise<RemoteResult<WorkspaceFileContent>> {
    throw new Error('unused')
  }

  writeFile(_request: WorkspaceWriteFileRequest): Promise<RemoteResult<WorkspaceWriteFileValue>> {
    throw new Error('unused')
  }

  createFile(_request: WorkspaceCreateEntryRequest): Promise<RemoteResult<WorkspaceCreateFileValue>> {
    throw new Error('unused')
  }

  createDirectory(_request: WorkspaceCreateEntryRequest): Promise<RemoteResult<WorkspaceCreateDirectoryValue>> {
    throw new Error('unused')
  }

  gitStatus(_request: WorkspaceGitRequest): Promise<RemoteResult<WorkspaceGitStatus>> {
    throw new Error('unused')
  }

  gitCommitAll(_request: WorkspaceGitCommitAllRequest): Promise<RemoteResult<WorkspaceGitCommitAllValue>> {
    throw new Error('unused')
  }

  gitDiscardAll(_request: WorkspaceGitRequest): Promise<RemoteResult<WorkspaceGitDiscardAllValue>> {
    throw new Error('unused')
  }

  gitPullRebase(_request: WorkspaceGitRequest): Promise<RemoteResult<WorkspaceGitPullRebaseValue>> {
    throw new Error('unused')
  }

  gitPush(_request: WorkspaceGitRequest): Promise<RemoteResult<WorkspaceGitPushValue>> {
    throw new Error('unused')
  }

  gitFileDiff(_request: WorkspaceGitFileDiffRequest): Promise<RemoteResult<WorkspaceFileDiff>> {
    throw new Error('unused')
  }

  async *follow(signal = new AbortController().signal): AsyncIterable<WorkspaceFollowFrame> {
    const generation = this.generations[this.calls++]
    if (generation === undefined) throw new Error('no scripted Workspace generation')
    this.signals.push(signal)
    for (const frame of generation.frames) yield frame
    if (generation.error !== undefined) throw generation.error
    if (generation.hold === true && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      generation.afterAbort?.()
      if (generation.afterAbortError !== undefined) throw generation.afterAbortError
    }
  }
}

class CommandWorkspaceRemote implements WorkspaceRemote {
  readonly create = vi.fn<WorkspaceRemote['create']>(request => Promise.resolve(remoteOk({
    workspace: workspace('created', { path: request.path }),
    created: true,
  })))

  readonly rename = vi.fn<WorkspaceRemote['rename']>(request => Promise.resolve(remoteOk({
    workspace: workspace(String(request.workspaceId), { title: request.title }),
  })))

  readonly delete = vi.fn<WorkspaceRemote['delete']>(() => Promise.resolve(remoteOk({ deleted: true })))

  readonly insertBefore = vi.fn<WorkspaceRemote['insertBefore']>(request => Promise.resolve(remoteOk({
    workspaceIds: [request.workspaceId],
  })))

  readonly insertSessionBefore = vi.fn<WorkspaceRemote['insertSessionBefore']>(request => Promise.resolve(remoteOk({
    workspace: workspace(String(request.workspaceId), { sessionIds: [request.sessionId] }),
  })))

  readonly archiveSession = vi.fn<WorkspaceRemote['archiveSession']>(request => Promise.resolve(remoteOk({
    archivedSessionIds: [request.sessionId],
  })))

  readonly listEntries = vi.fn<WorkspaceRemote['listEntries']>(request => Promise.resolve(remoteOk({
    path: request.path, entries: [], truncated: false,
  })))

  readonly readFile = vi.fn<WorkspaceRemote['readFile']>(() => Promise.resolve(remoteOk({
    kind: 'text', content: '', version: 'fake-version',
  } as WorkspaceFileContent)))

  readonly writeFile = vi.fn<WorkspaceRemote['writeFile']>(() => Promise.resolve(remoteOk({
    version: 'fake-version',
  } as WorkspaceWriteFileValue)))

  readonly createFile = vi.fn<WorkspaceRemote['createFile']>(request => Promise.resolve(remoteOk({
    path: `${request.parentPath}/${request.name}`, version: 'fake-version',
  } as WorkspaceCreateFileValue)))

  readonly createDirectory = vi.fn<WorkspaceRemote['createDirectory']>(request => Promise.resolve(remoteOk({
    path: `${request.parentPath}/${request.name}`,
  })))

  readonly gitStatus = vi.fn<WorkspaceRemote['gitStatus']>(() => Promise.resolve(remoteOk({
    isRepo: false, branch: null, files: {},
  })))

  readonly gitCommitAll = vi.fn<WorkspaceRemote['gitCommitAll']>(() => Promise.resolve(remoteOk({ committed: true })))

  readonly gitDiscardAll = vi.fn<WorkspaceRemote['gitDiscardAll']>(() => Promise.resolve(remoteOk({ discarded: true })))

  readonly gitPullRebase = vi.fn<WorkspaceRemote['gitPullRebase']>(() => Promise.resolve(remoteOk({ pulled: true })))

  readonly gitPush = vi.fn<WorkspaceRemote['gitPush']>(() => Promise.resolve(remoteOk({ pushed: true })))

  readonly gitFileDiff = vi.fn<WorkspaceRemote['gitFileDiff']>(() => Promise.resolve(remoteOk({
    oldText: null, newText: null,
  })))

  async *follow(_signal?: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {}
}

async function waitFor(check: () => void): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      check()
      return
    } catch {
      await Promise.resolve()
    }
  }
  check()
}

function provideClientServices(ctx: Context, remote: WorkspaceRemote): void {
  const connection: ConnectionHandle = {
    isLoopback: true,
    generation: AVAILABLE_CONNECTION.generation,
    rpc: {
      call: () => Promise.reject(new Error('unexpected generic RPC call')),
    },
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
  }
  ctx.reflect.provide('connection', connection)
  ctx.reflect.provide('remote', workspaceClient(remote, connection))
  ctx.reflect.provide('remote.workspace', remote)
}

describe('Workspace Controller Client apply', () => {
  it('provides the Workspace service and stops its follow generation with the plugin fiber', async () => {
    const ctx = new Context()
    const remote = new ScriptedWorkspaceRemote([{ frames: [baseline('mounted')], hold: true }])
    provideClientServices(ctx, remote)
    const fiber = ctx.plugin(WorkspaceClientPlugin)
    await fiber
    await waitFor(() => {
      expect(ctx.workspaces.list.getSnapshot()).toMatchObject({
        phase: 'ready',
        state: 'idle',
        items: [{ workspaceId: 'mounted' }],
      })
    })

    await fiber.dispose()

    expect(remote.signals[0]?.aborted).toBe(true)
    expect(ctx.get('workspaces')).toBeUndefined()
  })

  it('marks carrier loss while retrying and publishes a later protocol failure', async () => {
    const ctx = new Context()
    const remote = new ScriptedWorkspaceRemote([
      {
        frames: [baseline('old')],
        error: new RemoteStreamCarrierError('generation lost'),
      },
      { frames: [baseline('fresh'), baseline('duplicate')] },
    ])
    provideClientServices(ctx, remote)
    const carrierFailure = vi.spyOn(ClientWorkspaceModel.prototype, 'handleCarrierFailure')
    const streamFailure = vi.spyOn(ClientWorkspaceModel.prototype, 'handleStreamFailure')
    const fiber = ctx.plugin(WorkspaceClientPlugin)
    await fiber
    await waitFor(() => {
      expect(ctx.workspaces.list.getSnapshot()).toMatchObject({
        phase: 'ready',
        state: 'error',
        items: [{ workspaceId: 'fresh' }],
        error: { code: 'internal', message: 'Workspace state stream emitted more than one opening snapshot' },
      })
    })

    expect(carrierFailure).toHaveBeenCalledOnce()
    expect(streamFailure).toHaveBeenCalledOnce()
    await fiber.dispose()
  })
})

describe('Workspace state stream', () => {
  it('delivers one baseline followed by increments', async () => {
    const opening = baseline('one')
    const workspace = opening.value.items[0]!
    const remote = new ScriptedWorkspaceRemote([{
      frames: [
        opening,
        { type: 'upsert', workspace },
        { type: 'remove', workspaceId: workspace.workspaceId },
        { type: 'order', workspaceIds: [workspace.workspaceId] },
        { type: 'archived', archivedSessionIds: ['session-one' as never] },
      ],
      hold: true,
    }])
    const replaceBaseline = vi.fn<WorkspaceFollowSink['replaceBaseline']>()
    const upsertView = vi.fn<WorkspaceFollowSink['upsertView']>()
    const removeView = vi.fn<WorkspaceFollowSink['removeView']>()
    const replaceOrder = vi.fn<WorkspaceFollowSink['replaceOrder']>()
    const replaceArchived = vi.fn<WorkspaceFollowSink['replaceArchived']>()
    const accept = accepts({
      replaceBaseline,
      upsertView,
      removeView,
      replaceOrder,
      replaceArchived,
    })
    const stream = createWorkspaceStateStream(workspaceClient(remote), {
      accept,
      failed: vi.fn(),
    })

    stream.start()
    stream.start()
    await vi.waitFor(() => { expect(replaceArchived).toHaveBeenCalledOnce() })

    expect(replaceBaseline).toHaveBeenCalledWith(opening.value)
    expect(upsertView).toHaveBeenCalledWith(workspace)
    expect(removeView).toHaveBeenCalledWith(workspace.workspaceId)
    expect(replaceOrder).toHaveBeenCalledWith([workspace.workspaceId])
    expect(replaceArchived).toHaveBeenCalledWith(['session-one'])
    await stream.dispose()
    expect(remote.signals[0]?.aborted).toBe(true)
  })

  it('retains the old state across carrier loss and applies the replacement baseline', async () => {
    const carrier = new RemoteStreamCarrierError('socket lost')
    const remote = new ScriptedWorkspaceRemote([
      { frames: [baseline('old')], error: carrier },
      { frames: [baseline('fresh')], hold: true },
    ])
    const replaceBaseline = vi.fn<WorkspaceFollowSink['replaceBaseline']>()
    const carrierFailed = vi.fn()
    const failed = vi.fn()
    const stream = createWorkspaceStateStream(workspaceClient(remote), {
      accept: accepts({ replaceBaseline }),
      carrierFailed,
      failed,
    })

    stream.start()
    await vi.waitFor(() => { expect(replaceBaseline).toHaveBeenCalledTimes(2) })

    expect(replaceBaseline.mock.calls.map(([value]) => value.items[0]?.title)).toEqual(['old', 'fresh'])
    expect(carrierFailed).toHaveBeenCalledWith(carrier)
    expect(failed).not.toHaveBeenCalled()
    await stream.dispose()
  })

  it('classifies a normal end after the opening baseline as carrier loss', async () => {
    const remote = new ScriptedWorkspaceRemote([
      { frames: [baseline('old')] },
      { frames: [baseline('fresh')], hold: true },
    ])
    const replaceBaseline = vi.fn<WorkspaceFollowSink['replaceBaseline']>()
    const carrierFailed = vi.fn()
    const stream = createWorkspaceStateStream(workspaceClient(remote), {
      accept: accepts({ replaceBaseline }),
      carrierFailed,
      failed: vi.fn(),
    })

    stream.start()
    await vi.waitFor(() => { expect(replaceBaseline).toHaveBeenCalledTimes(2) })
    expect(carrierFailed.mock.calls[0]?.[0]).toMatchObject({
      message: 'Workspace state stream ended without a terminal result',
    })
    await stream.dispose()
  })

  it('suppresses callback failure after disposal begins', async () => {
    const failed = vi.fn()
    let closing: Promise<void> | undefined
    const stream = createWorkspaceStateStream(
      workspaceClient(new ScriptedWorkspaceRemote([{ frames: [baseline()] }])),
      {
        accept: accepts({
          replaceBaseline: () => {
            closing = stream.dispose()
            throw new Error('disposed callback')
          },
        }),
        failed,
      },
    )

    stream.start()
    await vi.waitFor(() => { expect(closing).toBeDefined() })
    await closing
    expect(failed).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'an increment before the baseline',
      frames: [{ type: 'remove', workspaceId: 'one' as never }] as WorkspaceFollowFrame[],
      message: 'update before its opening snapshot',
    },
    {
      name: 'a duplicate baseline',
      frames: [baseline(), baseline()] as WorkspaceFollowFrame[],
      message: 'more than one opening snapshot',
    },
    {
      name: 'a normal end before the baseline',
      frames: [] as WorkspaceFollowFrame[],
      message: 'ended before its opening snapshot',
    },
  ])('reports $name as a terminal failure', async ({ frames, message }) => {
    const failed = vi.fn()
    const stream = createWorkspaceStateStream(
      workspaceClient(new ScriptedWorkspaceRemote([{ frames }])),
      { accept: accepts(), failed },
    )

    stream.start()
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
    const failure: unknown = failed.mock.calls[0]?.[0]
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('expected Workspace stream failure')
    expect(failure.message).toContain(message)
    await stream.dispose()
  })

  it('restarts a live generation without reporting cancellation as failure', async () => {
    const remote = new ScriptedWorkspaceRemote([
      { frames: [baseline('first')], hold: true },
      { frames: [baseline('second')], hold: true },
    ])
    const replaceBaseline = vi.fn<WorkspaceFollowSink['replaceBaseline']>()
    const failed = vi.fn()
    const stream = createWorkspaceStateStream(workspaceClient(remote), {
      accept: accepts({ replaceBaseline }),
      failed,
    })

    stream.start()
    await vi.waitFor(() => { expect(replaceBaseline).toHaveBeenCalledOnce() })
    stream.restart()
    await vi.waitFor(() => { expect(replaceBaseline).toHaveBeenCalledTimes(2) })
    expect(failed).not.toHaveBeenCalled()
    await stream.dispose()
  })
})

describe('WorkspaceController', () => {
  it('publishes the model source and exposes successful Workspace commands', async () => {
    const remote = new CommandWorkspaceRemote()
    const model = new ClientWorkspaceModel(remote)
    model.replaceBaseline({ items: [workspace('one')], archivedSessionIds: [] })
    const controller = new WorkspaceController(new Context(), model)

    expect(controller.list).toBe(model)
    await expect(controller.create({ path: '/work/created' })).resolves.toMatchObject({ workspaceId: 'created' })
    await expect(controller.rename(wid('one'), 'renamed')).resolves.toMatchObject({ title: 'renamed' })
    await expect(controller.insertBefore(wid('one'))).resolves.toBeUndefined()
    await expect(controller.insertSessionBefore(wid('one'), sid('session'))).resolves.toMatchObject({
      sessionIds: ['session'],
    })
    await expect(controller.archiveSession(sid('session'))).resolves.toBeUndefined()
    await expect(controller.delete(wid('one'))).resolves.toBeUndefined()

    await expect(controller.listEntries(wid('one'), '/work/one')).resolves.toMatchObject({ path: '/work/one' })
    await expect(controller.readFile(wid('one'), '/work/one/a.txt')).resolves.toMatchObject({ kind: 'text' })
    await expect(controller.writeFile(wid('one'), '/work/one/a.txt', 'x', 'fake-version' as WorkspaceFileVersion))
      .resolves.toBe('fake-version')
    await expect(controller.gitStatus(wid('one'))).resolves.toMatchObject({ isRepo: false })
    await expect(controller.commitAllChanges(wid('one'), 'msg')).resolves.toBeUndefined()
    await expect(controller.discardAllChanges(wid('one'))).resolves.toBeUndefined()
    await expect(controller.pullRebase(wid('one'))).resolves.toBeUndefined()
    await expect(controller.push(wid('one'))).resolves.toBeUndefined()
    await expect(controller.gitFileDiff(wid('one'), '/work/one/a.txt')).resolves.toMatchObject({ oldText: null })
  })

  it('maps generated business failures to the command facade errors', async () => {
    const remote = new CommandWorkspaceRemote()
    const controller = new WorkspaceController(new Context(), new ClientWorkspaceModel(remote))
    const missingWorkspace: WorkspaceError = {
      code: 'workspace-not-found',
      message: 'gone',
      details: { workspaceId: wid('missing') },
    }
    const missingSession: WorkspaceError = {
      code: 'session-not-found',
      message: 'missing session',
      details: { sessionId: sid('session') },
    }

    remote.create.mockResolvedValueOnce(remoteFailure({
      code: 'workspace-invalid-path',
      message: 'missing path',
      details: { path: '/missing' },
    }))
    const create = controller.create({ path: '/missing' })
    await expect(create).rejects.toBeInstanceOf(WorkspaceCreateError)
    await expect(create).rejects.toThrow('workspace-invalid-path: missing path')

    remote.rename.mockResolvedValueOnce(remoteFailure(missingWorkspace))
    await expect(controller.rename(wid('missing'), 'name')).rejects.toThrow('workspace rename failed: workspace-not-found: gone')
    remote.delete.mockResolvedValueOnce(remoteFailure(missingWorkspace))
    await expect(controller.delete(wid('missing'))).rejects.toThrow('workspace delete failed: workspace-not-found: gone')
    remote.insertBefore.mockResolvedValueOnce(remoteFailure(missingWorkspace))
    await expect(controller.insertBefore(wid('missing'))).rejects.toThrow('workspace reorder failed: workspace-not-found: gone')
    remote.archiveSession.mockResolvedValueOnce(remoteFailure(missingSession))
    await expect(controller.archiveSession(sid('session'))).rejects.toThrow('workspace session archive failed: session-not-found: missing session')
    remote.insertSessionBefore.mockResolvedValueOnce(remoteFailure({
      code: 'workspace-move-invalid',
      message: 'invalid move',
      details: { workspaceId: wid('missing'), sessionId: sid('session') },
    }))
    await expect(controller.insertSessionBefore(wid('missing'), sid('session')))
      .rejects.toThrow('workspace move failed: workspace-move-invalid: invalid move')
  })

  it('maps generated file/git business failures to the command facade errors', async () => {
    const remote = new CommandWorkspaceRemote()
    const controller = new WorkspaceController(new Context(), new ClientWorkspaceModel(remote))
    const outside: WorkspaceError = {
      code: 'directory-unreadable',
      message: 'outside workspace',
      details: { path: '/elsewhere' },
    }
    const tooLarge: WorkspaceError = {
      code: 'file-too-large',
      message: 'too large',
      details: { path: '/w/a.txt', maxBytes: 4 },
    }
    const notARepo: WorkspaceError = { code: 'git-not-a-repository', message: 'not a repo', details: { path: '/w' } }

    remote.listEntries.mockResolvedValueOnce(remoteFailure(outside))
    await expect(controller.listEntries(wid('w'), '/elsewhere'))
      .rejects.toThrow('workspace list entries failed: directory-unreadable: outside workspace')

    remote.readFile.mockResolvedValueOnce(remoteFailure(tooLarge))
    const read = controller.readFile(wid('w'), '/w/a.txt')
    await expect(read).rejects.toBeInstanceOf(WorkspaceFileBrowseError)
    await expect(read).rejects.toThrow('file-too-large: too large')

    remote.writeFile.mockResolvedValueOnce(remoteFailure(outside))
    const write = controller.writeFile(wid('w'), '/elsewhere', 'x', 'v' as WorkspaceFileVersion)
    await expect(write).rejects.toBeInstanceOf(WorkspaceFileBrowseError)
    await expect(write).rejects.toThrow('workspace write file failed: directory-unreadable: outside workspace')

    const changed: WorkspaceError = { code: 'file-changed', message: 'changed on disk', details: { path: '/w/a.txt' } }
    remote.writeFile.mockResolvedValueOnce(remoteFailure(changed))
    const conflict = controller.writeFile(wid('w'), '/w/a.txt', 'x', 'v' as WorkspaceFileVersion)
    await expect(conflict).rejects.toMatchObject({ name: 'WorkspaceFileBrowseError', rpcError: { code: 'file-changed' } })

    remote.gitStatus.mockResolvedValueOnce(remoteFailure(notARepo))
    await expect(controller.gitStatus(wid('w'))).rejects.toThrow('workspace git status failed: git-not-a-repository: not a repo')

    remote.gitCommitAll.mockResolvedValueOnce(remoteFailure(notARepo))
    await expect(controller.commitAllChanges(wid('w'), 'msg')).rejects.toThrow('workspace git commit failed: git-not-a-repository: not a repo')

    remote.gitDiscardAll.mockResolvedValueOnce(remoteFailure(notARepo))
    await expect(controller.discardAllChanges(wid('w'))).rejects.toThrow('workspace git discard failed: git-not-a-repository: not a repo')

    remote.gitPullRebase.mockResolvedValueOnce(remoteFailure(notARepo))
    await expect(controller.pullRebase(wid('w'))).rejects.toThrow('workspace git pull failed: git-not-a-repository: not a repo')

    remote.gitPush.mockResolvedValueOnce(remoteFailure(notARepo))
    await expect(controller.push(wid('w'))).rejects.toThrow('workspace git push failed: git-not-a-repository: not a repo')

    remote.gitFileDiff.mockResolvedValueOnce(remoteFailure(notARepo))
    await expect(controller.gitFileDiff(wid('w'), '/w/a.txt')).rejects.toThrow('workspace git diff failed: git-not-a-repository: not a repo')
  })
})
