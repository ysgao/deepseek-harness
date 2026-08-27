/** Real-git branch and porcelain-status coverage of workspace-git.ts. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workspaceGitStatus } from '../src/workspace-git.ts'

function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

/** Initializes a git repository at `root` with a deterministic branch name and committer identity. */
function initRepo(root: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
}

function commitAll(root: string, message: string): void {
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', message])
}

describe('workspaceGitStatus', () => {
  it('reports isRepo: false for a directory outside any git working tree', async () => {
    const root = tempDir('dsh-workspace-git-none-')
    const status = await workspaceGitStatus(root)
    expect(status).toEqual({ isRepo: false, branch: null, files: {} })
  })

  it('reports the current branch and no pending changes for a clean repository', async () => {
    const root = tempDir('dsh-workspace-git-clean-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')

    const status = await workspaceGitStatus(root)
    expect(status).toEqual({ isRepo: true, branch: 'main', files: {} })
  })

  it('classifies a modified tracked file as M', async () => {
    const root = tempDir('dsh-workspace-git-modified-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')
    writeFileSync(join(root, 'a.txt'), 'changed')

    const status = await workspaceGitStatus(root)
    expect(status.files).toEqual({ [join(root, 'a.txt')]: 'M' })
  })

  it('classifies an untracked file (including one nested with a space in its name) as U', async () => {
    const root = tempDir('dsh-workspace-git-untracked-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'new file.txt'), 'x')

    const status = await workspaceGitStatus(root)
    expect(status.files).toEqual({ [join(root, 'sub', 'new file.txt')]: 'U' })
  })

  it('classifies a deleted tracked file as D', async () => {
    const root = tempDir('dsh-workspace-git-deleted-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')
    rmSync(join(root, 'a.txt'))

    const status = await workspaceGitStatus(root)
    expect(status.files).toEqual({ [join(root, 'a.txt')]: 'D' })
  })

  it('classifies a renamed tracked file as R, reported only under its new path', async () => {
    const root = tempDir('dsh-workspace-git-renamed-')
    initRepo(root)
    writeFileSync(join(root, 'old.txt'), 'hello')
    commitAll(root, 'init')
    execFileSync('git', ['-C', root, 'mv', 'old.txt', 'new.txt'])

    const status = await workspaceGitStatus(root)
    expect(status.files).toEqual({ [join(root, 'new.txt')]: 'R' })
  })

  it('resolves a non-ASCII filename to its correct absolute path without corrupting it', async () => {
    const root = tempDir('dsh-workspace-git-unicode-')
    initRepo(root)
    writeFileSync(join(root, '你好.txt'), 'hi')
    execFileSync('git', ['-C', root, 'add', '你好.txt'])

    const status = await workspaceGitStatus(root)
    expect(status.files).toEqual({ [join(root, '你好.txt')]: 'A' })
  })

  it('scans from the enclosing repository root when given a subdirectory of it', async () => {
    const root = tempDir('dsh-workspace-git-subdir-')
    initRepo(root)
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'a.txt'), 'hello')
    commitAll(root, 'init')
    writeFileSync(join(root, 'sub', 'a.txt'), 'changed')

    const status = await workspaceGitStatus(join(root, 'sub'))
    expect(status).toEqual({ isRepo: true, branch: 'main', files: { [join(root, 'sub', 'a.txt')]: 'M' } })
  })

  it('reports the literal branch "HEAD" for a detached checkout', async () => {
    const root = tempDir('dsh-workspace-git-detached-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')
    execFileSync('git', ['-C', root, 'checkout', '-q', 'HEAD~0'])

    const status = await workspaceGitStatus(root)
    expect(status.branch).toBe('HEAD')
  })

  it('propagates an abort instead of reporting isRepo: false', async () => {
    const root = tempDir('dsh-workspace-git-abort-')
    initRepo(root)
    const controller = new AbortController()
    controller.abort()
    await expect(workspaceGitStatus(root, controller.signal)).rejects.toThrow()
  })
})
