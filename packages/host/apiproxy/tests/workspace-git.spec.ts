/** Real-git branch and porcelain-status coverage of workspace-git.ts. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  commitAllChanges, discardAllChanges, GitCommandError, GitNotARepositoryError, workspaceFileAtHead, workspaceGitStatus,
} from '../src/workspace-git.ts'

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

describe('commitAllChanges', () => {
  it('stages tracked and untracked changes and commits them with the given message', async () => {
    const root = tempDir('dsh-workspace-git-commit-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')
    writeFileSync(join(root, 'a.txt'), 'changed')
    writeFileSync(join(root, 'new.txt'), 'new file')

    await commitAllChanges(root, 'commit everything')

    expect(execFileSync('git', ['-C', root, 'log', '-1', '--format=%s']).toString().trim()).toBe('commit everything')
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain']).toString()).toBe('')
  })

  it('rejects a directory outside any git working tree with GitNotARepositoryError', async () => {
    const root = tempDir('dsh-workspace-git-commit-none-')
    await expect(commitAllChanges(root, 'msg')).rejects.toThrow(GitNotARepositoryError)
  })

  it('rejects with GitCommandError when there is nothing to commit', async () => {
    const root = tempDir('dsh-workspace-git-commit-empty-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')

    await expect(commitAllChanges(root, 'nothing pending')).rejects.toThrow(GitCommandError)
  })

  it('propagates an abort instead of collapsing into a GitCommandError', async () => {
    const root = tempDir('dsh-workspace-git-commit-abort-')
    initRepo(root)
    const controller = new AbortController()
    controller.abort()
    const error = await commitAllChanges(root, 'msg', controller.signal).catch((reason: unknown) => reason)
    expect(error).not.toBeInstanceOf(GitCommandError)
    expect(error).not.toBeInstanceOf(GitNotARepositoryError)
  })
})

describe('workspaceFileAtHead', () => {
  it('reads a tracked file\'s committed content, independent of later working-tree edits', async () => {
    const root = tempDir('dsh-workspace-git-head-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')
    writeFileSync(join(root, 'a.txt'), 'changed')

    const content = await workspaceFileAtHead(root, join(root, 'a.txt'))
    expect(content).toBe('hello')
  })

  it('resolves to null for an untracked file (no HEAD blob at this path)', async () => {
    const root = tempDir('dsh-workspace-git-head-untracked-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')
    writeFileSync(join(root, 'new.txt'), 'brand new')

    const content = await workspaceFileAtHead(root, join(root, 'new.txt'))
    expect(content).toBeNull()
  })

  it('resolves to null on an unborn branch (no commits yet)', async () => {
    const root = tempDir('dsh-workspace-git-head-unborn-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'staged before any commit')
    execFileSync('git', ['-C', root, 'add', 'a.txt'])

    const content = await workspaceFileAtHead(root, join(root, 'a.txt'))
    expect(content).toBeNull()
  })

  it('rejects a directory outside any git working tree with GitNotARepositoryError', async () => {
    const root = tempDir('dsh-workspace-git-head-none-')
    await expect(workspaceFileAtHead(root, join(root, 'a.txt'))).rejects.toThrow(GitNotARepositoryError)
  })

  it('propagates an abort instead of collapsing into GitNotARepositoryError', async () => {
    const root = tempDir('dsh-workspace-git-head-abort-')
    initRepo(root)
    const controller = new AbortController()
    controller.abort()
    const error = await workspaceFileAtHead(root, join(root, 'a.txt'), controller.signal).catch((reason: unknown) => reason)
    expect(error).not.toBeInstanceOf(GitNotARepositoryError)
  })
})

describe('discardAllChanges', () => {
  it('reverts every tracked file to HEAD and leaves an untracked file alone', async () => {
    const root = tempDir('dsh-workspace-git-discard-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')
    writeFileSync(join(root, 'a.txt'), 'changed')
    execFileSync('git', ['-C', root, 'add', 'a.txt']) // staged modification
    writeFileSync(join(root, 'staged-new.txt'), 'staged new')
    execFileSync('git', ['-C', root, 'add', 'staged-new.txt']) // staged addition, no HEAD version
    writeFileSync(join(root, 'plain-untracked.txt'), 'never added')

    await discardAllChanges(root)

    expect(readFileSync(join(root, 'a.txt'), 'utf-8')).toBe('hello')
    // A staged-new file is unstaged back to untracked, not deleted.
    expect(existsSync(join(root, 'staged-new.txt'))).toBe(true)
    expect(existsSync(join(root, 'plain-untracked.txt'))).toBe(true)
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain']).toString()
    expect(status).toContain('?? staged-new.txt')
    expect(status).toContain('?? plain-untracked.txt')
    expect(status).not.toContain('a.txt')
  })

  it('rejects a directory outside any git working tree with GitNotARepositoryError', async () => {
    const root = tempDir('dsh-workspace-git-discard-none-')
    await expect(discardAllChanges(root)).rejects.toThrow(GitNotARepositoryError)
  })

  it('rejects with GitCommandError when the repository has no commits yet (unborn HEAD)', async () => {
    const root = tempDir('dsh-workspace-git-discard-unborn-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'staged before any commit')
    execFileSync('git', ['-C', root, 'add', 'a.txt'])

    await expect(discardAllChanges(root)).rejects.toThrow(GitCommandError)
  })

  it('propagates an abort instead of collapsing into a GitCommandError', async () => {
    const root = tempDir('dsh-workspace-git-discard-abort-')
    initRepo(root)
    const controller = new AbortController()
    controller.abort()
    const error = await discardAllChanges(root, controller.signal).catch((reason: unknown) => reason)
    expect(error).not.toBeInstanceOf(GitCommandError)
    expect(error).not.toBeInstanceOf(GitNotARepositoryError)
  })
})
