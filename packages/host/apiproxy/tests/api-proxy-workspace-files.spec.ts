/**
 * `workspace.listEntries`/`workspace.readFile` over a real filesystem: the
 * Files tree's host primitives, independent of and unaffected by the
 * directory-only `host.listDirectory`/`ctx.directoryPicker` seam.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { WorkspaceFileVersion } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`workspace-files-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function expectErr<T>(response: RpcResponse<T>): Extract<RpcResponse<T>['result'], { ok: false }>['error'] {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  return response.result.error
}

function stubAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Compose the API over real Session, Agent, Storage, Domain, and Workspace services (harness precedent: api-proxy-workspace.spec.ts). */
async function harness(
  extras: { workspaceFilesMaxEntries?: number; workspaceFilesMaxReadBytes?: number } = {},
) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-files-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: () => {
          unregister()
          return Promise.resolve()
        },
      }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  const picker: DirectoryPickerCapability = { kind: 'native', pick: async () => null }
  ctx.provide('directoryPicker', { capability: () => picker } as never)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: root,
    ...extras.workspaceFilesMaxEntries === undefined ? {} : { workspaceFilesMaxEntries: extras.workspaceFilesMaxEntries },
    ...extras.workspaceFilesMaxReadBytes === undefined ? {} : { workspaceFilesMaxReadBytes: extras.workspaceFilesMaxReadBytes },
  })
  return { api, root }
}

describe('workspace.listEntries', () => {
  it('lists directories and files together, directories first, name-sorted within each group, hidden-flagged', async () => {
    const { api, root } = await harness()
    mkdirSync(join(root, 'zzz-dir'))
    mkdirSync(join(root, 'aaa-dir'))
    mkdirSync(join(root, '.hidden-dir'))
    writeFileSync(join(root, 'zzz.txt'), 'z')
    writeFileSync(join(root, 'aaa.txt'), 'a')
    writeFileSync(join(root, '.hidden-file'), 'h')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const listing = expectOk(await api.workspace.listEntries(
      request({ workspaceId: created.workspaceId, path: root }),
      new AbortController().signal,
    ))
    expect(listing.path).toBe(root)
    expect(listing.truncated).toBe(false)
    expect(listing.entries.map(e => [e.name, e.type])).toEqual([
      ['.hidden-dir', 'directory'],
      ['aaa-dir', 'directory'],
      ['zzz-dir', 'directory'],
      ['.hidden-file', 'file'],
      ['aaa.txt', 'file'],
      ['zzz.txt', 'file'],
    ])
    expect(listing.entries.find(e => e.name === '.hidden-file')?.hidden).toBe(true)
    expect(listing.entries.find(e => e.name === 'aaa.txt')?.hidden).toBe(false)
    // Every entry path is absolute and host-joined; a file row carries its size.
    expect(listing.entries.every(e => e.path === join(root, e.name))).toBe(true)
    expect(listing.entries.find(e => e.name === 'aaa.txt')?.size).toBe(1)
  })

  it('follows a symlink to a directory (reported as type: directory) and skips a broken symlink', async () => {
    const { api, root } = await harness()
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'linked'), 'junction')
    symlinkSync(join(root, 'missing'), join(root, 'broken'), 'junction')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const listing = expectOk(await api.workspace.listEntries(
      request({ workspaceId: created.workspaceId, path: root }),
      new AbortController().signal,
    ))
    expect(listing.entries.map(e => e.name)).not.toContain('broken')
    expect(listing.entries.find(e => e.name === 'linked')).toMatchObject({ type: 'directory' })
  })

  it('rejects a path outside the workspace root with directory-unreadable', async () => {
    const { api, root } = await harness()
    mkdirSync(join(root, 'inside'))
    const created = expectOk(await api.workspace.create(request({ path: join(root, 'inside') }))).workspace

    const error = expectErr(await api.workspace.listEntries(
      request({ workspaceId: created.workspaceId, path: root }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('directory-unreadable')
  })

  it('rejects an unknown workspace id with workspace-not-found', async () => {
    const { api } = await harness()
    const error = expectErr(await api.workspace.listEntries(
      request({ workspaceId: 'no-such-workspace' as never, path: '/tmp' }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('workspace-not-found')
  })

  it('cuts each bucket at maxEntries and flags the level truncated', async () => {
    const { api, root } = await harness({ workspaceFilesMaxEntries: 2 })
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(root, name), '')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const listing = expectOk(await api.workspace.listEntries(
      request({ workspaceId: created.workspaceId, path: root }),
      new AbortController().signal,
    ))
    expect(listing.truncated).toBe(true)
    expect(listing.entries.length).toBe(2)
  })

  it('aborts the scan and reports cancelled when the caller signal fires', async () => {
    const { api, root } = await harness()
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace
    const controller = new AbortController()
    controller.abort()
    const error = expectErr(await api.workspace.listEntries(
      request({ workspaceId: created.workspaceId, path: root }), controller.signal,
    ))
    expect(error.code).toBe('cancelled')
  })
})

describe('workspace.readFile', () => {
  it('reads a UTF-8 text file as kind: text', async () => {
    const { api, root } = await harness()
    writeFileSync(join(root, 'notes.txt'), '你好，fixture\n')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const content = expectOk(await api.workspace.readFile(
      request({ workspaceId: created.workspaceId, path: join(root, 'notes.txt') }),
      new AbortController().signal,
    ))
    expect(content).toEqual({ kind: 'text', content: '你好，fixture\n', version: expect.any(String) }) // oxlint-disable-line typescript/no-unsafe-assignment
  })

  it('reads a non-UTF-8 file as kind: binary with a media type from the extension', async () => {
    const { api, root } = await harness()
    // A 1x1 PNG's header bytes are not valid UTF-8.
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    writeFileSync(join(root, 'pixel.png'), png)
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const content = expectOk(await api.workspace.readFile(
      request({ workspaceId: created.workspaceId, path: join(root, 'pixel.png') }),
      new AbortController().signal,
    ))
    expect(content.kind).toBe('binary')
    if (content.kind !== 'binary') throw new Error('unreachable')
    expect(content.mediaType).toBe('image/png')
    expect(Buffer.from(content.data, 'base64')).toEqual(png)
  })

  it('rejects a file exceeding the configured read bound with file-too-large', async () => {
    const { api, root } = await harness({ workspaceFilesMaxReadBytes: 4 })
    writeFileSync(join(root, 'big.txt'), 'more than four bytes')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const error = expectErr(await api.workspace.readFile(
      request({ workspaceId: created.workspaceId, path: join(root, 'big.txt') }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('file-too-large')
    if (error.code !== 'file-too-large') throw new Error('unreachable')
    expect(error.details.maxBytes).toBe(4)
  })

  it('rejects a path outside the workspace root with directory-unreadable', async () => {
    const outsideRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-files-outside-')))
    const { api, root } = await harness()
    mkdirSync(join(root, 'inside'))
    writeFileSync(join(outsideRoot, 'sibling.txt'), 'nope')
    const created = expectOk(await api.workspace.create(request({ path: join(root, 'inside') }))).workspace

    const error = expectErr(await api.workspace.readFile(
      request({ workspaceId: created.workspaceId, path: join(outsideRoot, 'sibling.txt') }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('directory-unreadable')
  })

  it('rejects a missing file with directory-unreadable', async () => {
    const { api, root } = await harness()
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace
    const error = expectErr(await api.workspace.readFile(
      request({ workspaceId: created.workspaceId, path: join(root, 'missing.txt') }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('directory-unreadable')
  })
})

describe('workspace.writeFile', () => {
  it('overwrites the file and returns a version a follow-up read agrees with', async () => {
    const { api, root } = await harness()
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'original')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace
    const read = expectOk(await api.workspace.readFile(
      request({ workspaceId: created.workspaceId, path }), new AbortController().signal,
    ))
    if (read.kind !== 'text') throw new Error('unreachable')

    const written = expectOk(await api.workspace.writeFile(
      request({ workspaceId: created.workspaceId, path, content: 'edited content', expectedVersion: read.version }),
      new AbortController().signal,
    ))
    expect(readFileSync(path, 'utf-8')).toBe('edited content')

    const reread = expectOk(await api.workspace.readFile(
      request({ workspaceId: created.workspaceId, path }), new AbortController().signal,
    ))
    if (reread.kind !== 'text') throw new Error('unreachable')
    expect(reread.version).toBe(written.version)
  })

  it('rejects a stale expectedVersion with file-changed, leaving the file untouched', async () => {
    const { api, root } = await harness()
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'current on disk')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace
    const read = expectOk(await api.workspace.readFile(
      request({ workspaceId: created.workspaceId, path }), new AbortController().signal,
    ))
    if (read.kind !== 'text') throw new Error('unreachable')

    // The file changes on disk after the version was captured (a concurrent
    // edit — by the agent, another tab, or an external editor).
    writeFileSync(path, 'changed after the read')

    const error = expectErr(await api.workspace.writeFile(
      request({ workspaceId: created.workspaceId, path, content: 'my edit', expectedVersion: read.version }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('file-changed')
    expect(readFileSync(path, 'utf-8')).toBe('changed after the read')
  })

  it('rejects a path outside the workspace root with directory-unreadable', async () => {
    const outsideRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-files-write-outside-')))
    const { api, root } = await harness()
    mkdirSync(join(root, 'inside'))
    writeFileSync(join(outsideRoot, 'sibling.txt'), 'nope')
    const created = expectOk(await api.workspace.create(request({ path: join(root, 'inside') }))).workspace

    const error = expectErr(await api.workspace.writeFile(
      request({
        workspaceId: created.workspaceId, path: join(outsideRoot, 'sibling.txt'), content: 'x',
        expectedVersion: 'irrelevant' as WorkspaceFileVersion,
      }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('directory-unreadable')
    expect(readFileSync(join(outsideRoot, 'sibling.txt'), 'utf-8')).toBe('nope')
  })

  it('does not leave a partial file or a temp file when the write itself fails', async () => {
    const { api, root } = await harness()
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'original')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace
    const read = expectOk(await api.workspace.readFile(
      request({ workspaceId: created.workspaceId, path }), new AbortController().signal,
    ))
    if (read.kind !== 'text') throw new Error('unreachable')

    // Read-only directory: the version check (a read) still succeeds, but
    // the temp-file write and rename that follow it cannot. Skipped when
    // running as root, which ignores directory write permissions.
    if (process.getuid?.() === 0) return
    chmodSync(root, 0o500)
    try {
      const error = expectErr(await api.workspace.writeFile(
        request({ workspaceId: created.workspaceId, path, content: 'new content', expectedVersion: read.version }),
        new AbortController().signal,
      ))
      expect(error.code).toBe('directory-unreadable')
    } finally {
      chmodSync(root, 0o700)
    }
    expect(readFileSync(path, 'utf-8')).toBe('original')
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toHaveLength(0)
  })
})

describe('workspace.gitStatus', () => {
  it('reports the branch and pending changes of a workspace inside a git repository', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.txt'), 'hello')
    execFileSync('git', ['-C', root, 'add', '-A'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init'])
    writeFileSync(join(root, 'a.txt'), 'changed')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const status = expectOk(await api.workspace.gitStatus(
      request({ workspaceId: created.workspaceId }),
      new AbortController().signal,
    ))
    expect(status).toEqual({ isRepo: true, branch: 'main', files: { [join(root, 'a.txt')]: 'M' } })
  })

  it('reports isRepo: false for a workspace outside any git working tree', async () => {
    const { api, root } = await harness()
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const status = expectOk(await api.workspace.gitStatus(
      request({ workspaceId: created.workspaceId }),
      new AbortController().signal,
    ))
    expect(status).toEqual({ isRepo: false, branch: null, files: {} })
  })

  it('rejects an unknown workspace id with workspace-not-found', async () => {
    const { api } = await harness()
    const error = expectErr(await api.workspace.gitStatus(
      request({ workspaceId: 'no-such-workspace' as never }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('workspace-not-found')
  })

  it('aborts and reports cancelled when the caller signal fires', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace
    const controller = new AbortController()
    controller.abort()
    const error = expectErr(await api.workspace.gitStatus(
      request({ workspaceId: created.workspaceId }), controller.signal,
    ))
    expect(error.code).toBe('cancelled')
  })
})

describe('workspace.gitCommitAll', () => {
  it('stages and commits every pending change with the given message', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.txt'), 'hello')
    execFileSync('git', ['-C', root, 'add', '-A'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init'])
    writeFileSync(join(root, 'a.txt'), 'changed')
    writeFileSync(join(root, 'new.txt'), 'new file')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const value = expectOk(await api.workspace.gitCommitAll(
      request({ workspaceId: created.workspaceId, message: 'commit everything' }),
      new AbortController().signal,
    ))
    expect(value).toEqual({ committed: true })
    expect(execFileSync('git', ['-C', root, 'log', '-1', '--format=%s']).toString().trim()).toBe('commit everything')
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain']).toString()).toBe('')
  })

  it('rejects an unknown workspace id with workspace-not-found', async () => {
    const { api } = await harness()
    const error = expectErr(await api.workspace.gitCommitAll(
      request({ workspaceId: 'no-such-workspace' as never, message: 'msg' }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('workspace-not-found')
  })

  it('rejects a workspace outside any git working tree with git-not-a-repository', async () => {
    const { api, root } = await harness()
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const error = expectErr(await api.workspace.gitCommitAll(
      request({ workspaceId: created.workspaceId, message: 'msg' }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('git-not-a-repository')
  })

  it('rejects with git-command-failed when there is nothing to commit', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.txt'), 'hello')
    execFileSync('git', ['-C', root, 'add', '-A'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init'])
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const error = expectErr(await api.workspace.gitCommitAll(
      request({ workspaceId: created.workspaceId, message: 'nothing pending' }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('git-command-failed')
    if (error.code !== 'git-command-failed') throw new Error('unreachable')
    expect(error.details.command).toBe('commit')
  })

  it('aborts and reports cancelled when the caller signal fires', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace
    const controller = new AbortController()
    controller.abort()
    const error = expectErr(await api.workspace.gitCommitAll(
      request({ workspaceId: created.workspaceId, message: 'msg' }), controller.signal,
    ))
    expect(error.code).toBe('cancelled')
  })
})

describe('workspace.gitDiscardAll', () => {
  it('reverts every tracked file to HEAD, leaving an untracked file alone', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.txt'), 'hello')
    execFileSync('git', ['-C', root, 'add', '-A'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init'])
    writeFileSync(join(root, 'a.txt'), 'changed')
    writeFileSync(join(root, 'untracked.txt'), 'never added')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const value = expectOk(await api.workspace.gitDiscardAll(
      request({ workspaceId: created.workspaceId }),
      new AbortController().signal,
    ))
    expect(value).toEqual({ discarded: true })
    expect(readFileSync(join(root, 'a.txt'), 'utf-8')).toBe('hello')
    expect(existsSync(join(root, 'untracked.txt'))).toBe(true)
  })

  it('rejects an unknown workspace id with workspace-not-found', async () => {
    const { api } = await harness()
    const error = expectErr(await api.workspace.gitDiscardAll(
      request({ workspaceId: 'no-such-workspace' as never }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('workspace-not-found')
  })

  it('rejects a workspace outside any git working tree with git-not-a-repository', async () => {
    const { api, root } = await harness()
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const error = expectErr(await api.workspace.gitDiscardAll(
      request({ workspaceId: created.workspaceId }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('git-not-a-repository')
  })

  it('aborts and reports cancelled when the caller signal fires', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace
    const controller = new AbortController()
    controller.abort()
    const error = expectErr(await api.workspace.gitDiscardAll(
      request({ workspaceId: created.workspaceId }), controller.signal,
    ))
    expect(error.code).toBe('cancelled')
  })
})

/** Initializes a bare repository at `root`, usable as a `gitPullRebase`/`gitPush` remote. */
function initBareRemote(root: string): void {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', root])
}

/** Clones `remote` into an existing empty directory `dest`, with a deterministic committer identity. */
function cloneInto(remote: string, dest: string): void {
  execFileSync('git', ['clone', '-q', remote, dest])
  execFileSync('git', ['-C', dest, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', dest, 'config', 'user.name', 'Test'])
}

/** Commits every pending change (tracked and untracked) in `root` with `message`. */
function commitAll(root: string, message: string): void {
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', message])
}

describe('workspace.gitPullRebase', () => {
  it('fetches from the remote and rebases local commits on top', async () => {
    const { api, root } = await harness()
    const remote = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-git-remote-')))
    initBareRemote(remote)
    cloneInto(remote, root)
    writeFileSync(join(root, 'local.txt'), 'local')
    commitAll(root, 'local change')

    const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-git-other-')))
    cloneInto(remote, other)
    writeFileSync(join(other, 'remote.txt'), 'remote')
    commitAll(other, 'remote change')
    execFileSync('git', ['-C', other, 'push', '-q'])

    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace
    const value = expectOk(await api.workspace.gitPullRebase(
      request({ workspaceId: created.workspaceId }),
      new AbortController().signal,
    ))
    expect(value).toEqual({ pulled: true })
    expect(execFileSync('git', ['-C', root, 'log', '--format=%s']).toString().trim().split('\n')).toEqual([
      'local change', 'remote change',
    ])
  })

  it('rejects an unknown workspace id with workspace-not-found', async () => {
    const { api } = await harness()
    const error = expectErr(await api.workspace.gitPullRebase(
      request({ workspaceId: 'no-such-workspace' as never }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('workspace-not-found')
  })

  it('rejects a workspace outside any git working tree with git-not-a-repository', async () => {
    const { api, root } = await harness()
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const error = expectErr(await api.workspace.gitPullRebase(
      request({ workspaceId: created.workspaceId }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('git-not-a-repository')
  })

  it('rejects with git-command-failed when there is no configured remote', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const error = expectErr(await api.workspace.gitPullRebase(
      request({ workspaceId: created.workspaceId }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('git-command-failed')
    if (error.code !== 'git-command-failed') throw new Error('unreachable')
    expect(error.details.command).toBe('pull')
  })

  it('aborts and reports cancelled when the caller signal fires', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace
    const controller = new AbortController()
    controller.abort()
    const error = expectErr(await api.workspace.gitPullRebase(
      request({ workspaceId: created.workspaceId }), controller.signal,
    ))
    expect(error.code).toBe('cancelled')
  })
})

describe('workspace.gitPush', () => {
  it('pushes local commits to the configured remote', async () => {
    const { api, root } = await harness()
    const remote = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-git-remote-')))
    initBareRemote(remote)
    cloneInto(remote, root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const value = expectOk(await api.workspace.gitPush(
      request({ workspaceId: created.workspaceId }),
      new AbortController().signal,
    ))
    expect(value).toEqual({ pushed: true })

    const check = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-git-check-')))
    cloneInto(remote, check)
    expect(readFileSync(join(check, 'a.txt'), 'utf-8')).toBe('hello')
  })

  it('rejects an unknown workspace id with workspace-not-found', async () => {
    const { api } = await harness()
    const error = expectErr(await api.workspace.gitPush(
      request({ workspaceId: 'no-such-workspace' as never }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('workspace-not-found')
  })

  it('rejects a workspace outside any git working tree with git-not-a-repository', async () => {
    const { api, root } = await harness()
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const error = expectErr(await api.workspace.gitPush(
      request({ workspaceId: created.workspaceId }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('git-not-a-repository')
  })

  it('rejects with git-command-failed when there is no configured remote', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const error = expectErr(await api.workspace.gitPush(
      request({ workspaceId: created.workspaceId }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('git-command-failed')
    if (error.code !== 'git-command-failed') throw new Error('unreachable')
    expect(error.details.command).toBe('push')
  })

  it('aborts and reports cancelled when the caller signal fires', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace
    const controller = new AbortController()
    controller.abort()
    const error = expectErr(await api.workspace.gitPush(
      request({ workspaceId: created.workspaceId }), controller.signal,
    ))
    expect(error.code).toBe('cancelled')
  })
})

describe('workspace.gitFileDiff', () => {
  it('reads a modified tracked file\'s HEAD and working-tree text', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.txt'), 'hello')
    execFileSync('git', ['-C', root, 'add', '-A'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init'])
    writeFileSync(join(root, 'a.txt'), 'changed')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const value = expectOk(await api.workspace.gitFileDiff(
      request({ workspaceId: created.workspaceId, path: join(root, 'a.txt') }),
      new AbortController().signal,
    ))
    expect(value).toEqual({ oldText: 'hello', newText: 'changed' })
  })

  it('reports oldText: null for an untracked file with no HEAD blob', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.txt'), 'hello')
    execFileSync('git', ['-C', root, 'add', '-A'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init'])
    writeFileSync(join(root, 'new.txt'), 'brand new')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const value = expectOk(await api.workspace.gitFileDiff(
      request({ workspaceId: created.workspaceId, path: join(root, 'new.txt') }),
      new AbortController().signal,
    ))
    expect(value).toEqual({ oldText: null, newText: 'brand new' })
  })

  it('reports newText: null for a file deleted from the working tree', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.txt'), 'hello')
    execFileSync('git', ['-C', root, 'add', '-A'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init'])
    rmSync(join(root, 'a.txt'))
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const value = expectOk(await api.workspace.gitFileDiff(
      request({ workspaceId: created.workspaceId, path: join(root, 'a.txt') }),
      new AbortController().signal,
    ))
    expect(value).toEqual({ oldText: 'hello', newText: null })
  })

  it('reports newText: null for a working-tree read that decodes as binary', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.bin'), 'hello')
    execFileSync('git', ['-C', root, 'add', '-A'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init'])
    writeFileSync(join(root, 'a.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const value = expectOk(await api.workspace.gitFileDiff(
      request({ workspaceId: created.workspaceId, path: join(root, 'a.bin') }),
      new AbortController().signal,
    ))
    expect(value).toEqual({ oldText: 'hello', newText: null })
  })

  it('rejects a working-tree read over the byte bound with file-too-large', async () => {
    const { api, root } = await harness({ workspaceFilesMaxReadBytes: 4 })
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.txt'), 'a')
    execFileSync('git', ['-C', root, 'add', '-A'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init'])
    writeFileSync(join(root, 'a.txt'), 'much too long for the bound')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const error = expectErr(await api.workspace.gitFileDiff(
      request({ workspaceId: created.workspaceId, path: join(root, 'a.txt') }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('file-too-large')
  })

  it('rejects a path outside the workspace with directory-unreadable', async () => {
    const outsideRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-files-outside-')))
    const { api, root } = await harness()
    mkdirSync(join(root, 'inside'))
    writeFileSync(join(outsideRoot, 'sibling.txt'), 'nope')
    const created = expectOk(await api.workspace.create(request({ path: join(root, 'inside') }))).workspace

    const error = expectErr(await api.workspace.gitFileDiff(
      request({ workspaceId: created.workspaceId, path: join(outsideRoot, 'sibling.txt') }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('directory-unreadable')
  })

  it('rejects an unknown workspace id with workspace-not-found', async () => {
    const { api } = await harness()
    const error = expectErr(await api.workspace.gitFileDiff(
      request({ workspaceId: 'no-such-workspace' as never, path: '/x' }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('workspace-not-found')
  })

  it('rejects a workspace outside any git working tree with git-not-a-repository', async () => {
    const { api, root } = await harness()
    writeFileSync(join(root, 'a.txt'), 'hello')
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace

    const error = expectErr(await api.workspace.gitFileDiff(
      request({ workspaceId: created.workspaceId, path: join(root, 'a.txt') }),
      new AbortController().signal,
    ))
    expect(error.code).toBe('git-not-a-repository')
  })

  it('aborts and reports cancelled when the caller signal fires', async () => {
    const { api, root } = await harness()
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    const created = expectOk(await api.workspace.create(request({ path: root }))).workspace
    const controller = new AbortController()
    controller.abort()
    const error = expectErr(await api.workspace.gitFileDiff(
      request({ workspaceId: created.workspaceId, path: join(root, 'a.txt') }), controller.signal,
    ))
    expect(error.code).toBe('cancelled')
  })
})
