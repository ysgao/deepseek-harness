/**
 * Real-filesystem, real-git coverage of `WorkspaceController`'s file-tree and
 * git `@Remote` methods (`listEntries`/`readFile`/`writeFile`/`gitStatus`/
 * `gitCommitAll`/`gitDiscardAll`/`gitPullRebase`/`gitPush`/`gitFileDiff`) and
 * the `WorkspaceFileCommands` glue they delegate to: workspace-root
 * containment, error mapping from `WorkspaceFileError`/`GitNotARepositoryError`/
 * `GitCommandError` to `TypertRemoteFailure`, and the `workspace-not-found`
 * path shared by every method. `files.ts`/`workspace-git.ts`'s own pure-logic
 * branches are covered by their sibling specs; this file exercises the
 * Controller wiring above them.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import WorkspaceController from '../src/index.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(config?: { workspaceFilesMaxReadBytes?: number; workspaceFilesMaxEntries?: number }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-file-commands-')))
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
  } as never)
  const controller = new WorkspaceController(ctx, config)
  return { controller, ctx, root }
}

function initRepo(root: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
}

function commitAll(root: string, message: string): void {
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', message])
}

/**
 * `listEntries`/`readFile`/`gitStatus` throw workspace-resolution failures
 * synchronously (before any awaited call), so a bare `expect(call).rejects`
 * never sees a promise to unwrap. Deferring the call into an already-settled
 * microtask folds a synchronous throw into a normal rejection.
 */
function rejection(call: () => unknown): Promise<unknown> {
  return Promise.resolve().then(call).then(
    (value) => { throw new Error(`expected a rejection, resolved with ${JSON.stringify(value)}`) },
    (error: unknown) => error,
  )
}

describe('WorkspaceController file-tree methods', () => {
  it('lists a directory level, name-sorted, and rejects a path outside the workspace root', async () => {
    const { controller, root } = await harness()
    mkdirSync(join(root, 'zeta'), { recursive: true })
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'sub', 'a.txt'), 'hello')
    const created = await controller.create({ path: root })
    const workspaceId = created.workspace.workspaceId

    const listing = await controller.listEntries({ workspaceId, path: root }, new AbortController().signal)
    expect(listing.entries).toEqual([
      { name: 'sub', path: join(root, 'sub'), type: 'directory', hidden: false },
      { name: 'zeta', path: join(root, 'zeta'), type: 'directory', hidden: false },
    ])
    expect(listing.truncated).toBe(false)

    const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
    await expect(rejection(() => controller.listEntries({ workspaceId, path: outside }, new AbortController().signal)))
      .resolves.toMatchObject({ failure: { code: 'directory-unreadable' } })

    await expect(rejection(() => controller.listEntries({ workspaceId: 'missing' as WorkspaceId, path: root }, new AbortController().signal)))
      .resolves.toMatchObject({ failure: { code: 'workspace-not-found' } })
  })

  it('truncates a directory level to the configured maxEntries', async () => {
    const { controller, root } = await harness({ workspaceFilesMaxEntries: 1 })
    mkdirSync(join(root, 'alpha'), { recursive: true })
    mkdirSync(join(root, 'beta'), { recursive: true })
    const created = await controller.create({ path: root })
    const listing = await controller.listEntries(
      { workspaceId: created.workspace.workspaceId, path: root },
      new AbortController().signal,
    )
    expect(listing.entries).toHaveLength(1)
    expect(['alpha', 'beta']).toContain(listing.entries[0]?.name)
    expect(listing.truncated).toBe(true)
  })

  it('reads a text file and maps an oversized read to file-too-large', async () => {
    const { controller, root } = await harness({ workspaceFilesMaxReadBytes: 4 })
    writeFileSync(join(root, 'notes.txt'), 'hello world')
    const created = await controller.create({ path: root })
    const workspaceId = created.workspace.workspaceId

    await expect(controller.readFile({ workspaceId, path: join(root, 'notes.txt') }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'file-too-large', details: { maxBytes: 4 } } })
  })

  it('writes a file guarded by expectedVersion and maps a stale version to file-changed', async () => {
    const { controller, root } = await harness()
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'hello')
    const created = await controller.create({ path: root })
    const workspaceId = created.workspace.workspaceId

    const read = await controller.readFile({ workspaceId, path }, new AbortController().signal)
    if (read.kind !== 'text') throw new Error('expected text content')
    const written = await controller.writeFile(
      { workspaceId, path, content: 'hello world', expectedVersion: read.version },
      new AbortController().signal,
    )
    expect(written.version).not.toBe(read.version)

    await expect(controller.writeFile(
      { workspaceId, path, content: 'stale write', expectedVersion: read.version },
      new AbortController().signal,
    )).rejects.toMatchObject({ failure: { code: 'file-changed' } })
  })

  it('maps a missing file within the workspace to directory-unreadable', async () => {
    const { controller, root } = await harness()
    const created = await controller.create({ path: root })
    await expect(controller.readFile(
      { workspaceId: created.workspace.workspaceId, path: join(root, 'missing.txt') },
      new AbortController().signal,
    )).rejects.toMatchObject({ failure: { code: 'directory-unreadable' } })
  })

  it('propagates a non-WorkspaceFileError failure (an aborted signal) unwrapped', async () => {
    const { controller, root } = await harness()
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'hello')
    const created = await controller.create({ path: root })
    const aborter = new AbortController()
    aborter.abort(new Error('caller cancelled'))
    await expect(controller.readFile({ workspaceId: created.workspace.workspaceId, path }, aborter.signal))
      .rejects.toThrow('caller cancelled')
  })
})

describe('WorkspaceController createFile/createDirectory methods', () => {
  it('creates a new file as a child of the workspace root and rejects a duplicate name', async () => {
    const { controller, root } = await harness()
    const created = await controller.create({ path: root })
    const workspaceId = created.workspace.workspaceId

    const result = await controller.createFile(
      { workspaceId, parentPath: root, name: 'notes.txt' },
      new AbortController().signal,
    )
    expect(result.path).toBe(join(root, 'notes.txt'))
    expect(await controller.readFile({ workspaceId, path: result.path }, new AbortController().signal))
      .toMatchObject({ kind: 'text', content: '' })

    await expect(controller.createFile(
      { workspaceId, parentPath: root, name: 'notes.txt' },
      new AbortController().signal,
    )).rejects.toMatchObject({ failure: { code: 'already-exists' } })
  })

  it('creates a new directory as a child of an existing subdirectory', async () => {
    const { controller, root } = await harness()
    mkdirSync(join(root, 'src'))
    const created = await controller.create({ path: root })
    const workspaceId = created.workspace.workspaceId

    const result = await controller.createDirectory(
      { workspaceId, parentPath: join(root, 'src'), name: 'lib' },
      new AbortController().signal,
    )
    expect(result.path).toBe(join(root, 'src', 'lib'))
    const listing = await controller.listEntries({ workspaceId, path: join(root, 'src') }, new AbortController().signal)
    expect(listing.entries).toEqual([{ name: 'lib', path: join(root, 'src', 'lib'), type: 'directory', hidden: false }])
  })

  it('rejects a name containing a path separator with invalid-name, never reaching the filesystem', async () => {
    const { controller, root } = await harness()
    const created = await controller.create({ path: root })
    await expect(rejection(() => controller.createFile(
      { workspaceId: created.workspace.workspaceId, parentPath: root, name: 'nested/notes.txt' },
      new AbortController().signal,
    ))).resolves.toMatchObject({ failure: { code: 'invalid-name' } })
  })

  it('rejects a blank name with invalid-name', async () => {
    const { controller, root } = await harness()
    const created = await controller.create({ path: root })
    await expect(rejection(() => controller.createDirectory(
      { workspaceId: created.workspace.workspaceId, parentPath: root, name: '   ' },
      new AbortController().signal,
    ))).resolves.toMatchObject({ failure: { code: 'invalid-name' } })
  })

  it('rejects a parentPath outside the workspace root with directory-unreadable', async () => {
    const { controller, root } = await harness()
    const created = await controller.create({ path: root })
    const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
    await expect(rejection(() => controller.createFile(
      { workspaceId: created.workspace.workspaceId, parentPath: outside, name: 'notes.txt' },
      new AbortController().signal,
    ))).resolves.toMatchObject({ failure: { code: 'directory-unreadable' } })
  })

  it('rejects an unknown workspaceId with workspace-not-found', async () => {
    const { controller, root } = await harness()
    await expect(rejection(() => controller.createFile(
      { workspaceId: 'missing' as WorkspaceId, parentPath: root, name: 'notes.txt' },
      new AbortController().signal,
    ))).resolves.toMatchObject({ failure: { code: 'workspace-not-found' } })
  })

  it('rejects a missing parent directory with parent-missing', async () => {
    const { controller, root } = await harness()
    const created = await controller.create({ path: root })
    await expect(controller.createDirectory(
      { workspaceId: created.workspace.workspaceId, parentPath: join(root, 'missing'), name: 'sub' },
      new AbortController().signal,
    )).rejects.toMatchObject({ failure: { code: 'parent-missing' } })
  })
})

describe('WorkspaceController git methods', () => {
  it('reports git status, commits, and discards through the enclosing repository', async () => {
    const { controller, root } = await harness()
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'one')
    commitAll(root, 'initial')
    const created = await controller.create({ path: root })
    const workspaceId = created.workspace.workspaceId

    const clean = await controller.gitStatus({ workspaceId }, new AbortController().signal)
    expect(clean).toMatchObject({ branch: 'main', files: {} })

    writeFileSync(join(root, 'a.txt'), 'two')
    const dirty = await controller.gitStatus({ workspaceId }, new AbortController().signal)
    expect(dirty.files[join(root, 'a.txt')]).toBe('M')

    await expect(controller.gitCommitAll({ workspaceId, message: '  ' }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'bad-request' } })

    await expect(controller.gitCommitAll({ workspaceId, message: 'commit it' }, new AbortController().signal))
      .resolves.toEqual({ committed: true })
    expect(execFileSync('git', ['-C', root, 'log', '-1', '--format=%s']).toString().trim()).toBe('commit it')

    writeFileSync(join(root, 'a.txt'), 'three')
    await expect(controller.gitDiscardAll({ workspaceId }, new AbortController().signal))
      .resolves.toEqual({ discarded: true })
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain']).toString()).toBe('')
  })

  it('pulls and pushes against a configured remote, and diffs a file against HEAD', async () => {
    const { controller, root } = await harness()
    const bare = mkdtempSync(join(tmpdir(), 'dsh-bare-'))
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    const seed = mkdtempSync(join(tmpdir(), 'dsh-seed-'))
    initRepo(seed)
    writeFileSync(join(seed, 'a.txt'), 'one')
    commitAll(seed, 'initial')
    execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', bare])
    execFileSync('git', ['-C', seed, 'push', '-q', '-u', 'origin', 'main'])

    execFileSync('git', ['clone', '-q', bare, root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    const created = await controller.create({ path: root })
    const workspaceId = created.workspace.workspaceId

    writeFileSync(join(seed, 'a.txt'), 'two')
    commitAll(seed, 'upstream change')
    execFileSync('git', ['-C', seed, 'push', '-q'])
    await expect(controller.gitPullRebase({ workspaceId }, new AbortController().signal)).resolves.toEqual({ pulled: true })
    expect(execFileSync('git', ['-C', root, 'log', '-1', '--format=%s']).toString().trim()).toBe('upstream change')

    writeFileSync(join(root, 'a.txt'), 'three')
    const path = join(root, 'a.txt')
    const diff = await controller.gitFileDiff({ workspaceId, path }, new AbortController().signal)
    expect(diff).toEqual({ oldText: 'two', newText: 'three' })
    commitAll(root, 'local change')
    await expect(controller.gitPush({ workspaceId }, new AbortController().signal)).resolves.toEqual({ pushed: true })
    expect(execFileSync('git', ['-C', bare, 'log', 'main', '-1', '--format=%s']).toString().trim()).toBe('local change')
  })

  it('reports isRepo: false (not a failure) from gitStatus outside any git working tree', async () => {
    const { controller, root } = await harness()
    const created = await controller.create({ path: root })
    await expect(controller.gitStatus({ workspaceId: created.workspace.workspaceId }, new AbortController().signal))
      .resolves.toEqual({ isRepo: false, branch: null, files: {} })
  })

  it('maps a write action outside any git working tree to git-not-a-repository', async () => {
    const { controller, root } = await harness()
    const created = await controller.create({ path: root })
    await expect(controller.gitCommitAll({ workspaceId: created.workspace.workspaceId, message: 'x' }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'git-not-a-repository' } })
  })

  it('propagates a non-git-error failure (an aborted signal) from a write action unwrapped', async () => {
    const { controller, root } = await harness()
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'one')
    commitAll(root, 'initial')
    const created = await controller.create({ path: root })
    const aborter = new AbortController()
    aborter.abort(new Error('caller cancelled'))
    const rejected = await controller.gitCommitAll({ workspaceId: created.workspace.workspaceId, message: 'x' }, aborter.signal)
      .then(() => null, (error: unknown) => error)
    expect(rejected).not.toMatchObject({ name: 'TypertRemoteFailure' })
    expect(rejected).toMatchObject({ code: 'ABORT_ERR' })
  })

  it('reports a deleted working-tree file in gitFileDiff as an absent new side', async () => {
    const { controller, root } = await harness()
    initRepo(root)
    const path = join(root, 'gone.txt')
    writeFileSync(path, 'still here')
    commitAll(root, 'add gone.txt')
    const created = await controller.create({ path: root })
    execFileSync('node', ['-e', `require('node:fs').unlinkSync(${JSON.stringify(path)})`])
    const diff = await controller.gitFileDiff(
      { workspaceId: created.workspace.workspaceId, path },
      new AbortController().signal,
    )
    expect(diff).toEqual({ oldText: 'still here', newText: null })
  })

  it('reports a binary working-tree file in gitFileDiff as a null new side', async () => {
    const { controller, root } = await harness()
    initRepo(root)
    const path = join(root, 'bin.dat')
    writeFileSync(path, 'text at HEAD')
    commitAll(root, 'add bin.dat')
    const created = await controller.create({ path: root })
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00, 0x01]))
    const diff = await controller.gitFileDiff(
      { workspaceId: created.workspace.workspaceId, path },
      new AbortController().signal,
    )
    expect(diff).toEqual({ oldText: 'text at HEAD', newText: null })
  })

  it('maps a non-directory-unreadable working-tree read failure in gitFileDiff through mapFileError', async () => {
    const { controller, root } = await harness({ workspaceFilesMaxReadBytes: 4 })
    initRepo(root)
    const path = join(root, 'small.txt')
    writeFileSync(path, 'ok')
    commitAll(root, 'add small.txt')
    const created = await controller.create({ path: root })
    writeFileSync(path, 'now far too large for the bound')
    await expect(controller.gitFileDiff(
      { workspaceId: created.workspace.workspaceId, path },
      new AbortController().signal,
    )).rejects.toMatchObject({ failure: { code: 'file-too-large' } })
  })

  it('maps an ordinary git command failure (push with no remote) to git-command-failed', async () => {
    const { controller, root } = await harness()
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'one')
    commitAll(root, 'initial')
    const created = await controller.create({ path: root })
    await expect(controller.gitPush({ workspaceId: created.workspace.workspaceId }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'git-command-failed' } })
  })
})
