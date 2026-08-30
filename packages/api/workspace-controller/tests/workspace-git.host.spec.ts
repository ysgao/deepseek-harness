/** Real-git branch and porcelain-status coverage of workspace-git.ts. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  commitAllChanges, discardAllChanges, GitCommandError, GitNotARepositoryError, pullRebase, push, workspaceFileAtHead,
  workspaceGitStatus,
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

/** Initializes a bare repository at `root`, usable as a `pullRebase`/`push` remote. */
function initBareRemote(root: string): void {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', root])
}

/** Clones `remote` into a fresh working copy at `dest`, with a deterministic committer identity. */
function cloneRepo(remote: string, dest: string): void {
  execFileSync('git', ['clone', '-q', remote, dest])
  execFileSync('git', ['-C', dest, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', dest, 'config', 'user.name', 'Test'])
}

describe('workspaceGitStatus', () => {
  it('reports isRepo: false for a directory outside any git working tree', async () => {
    const root = tempDir('dsh-workspace-git-none-')
    const status = await workspaceGitStatus(root)
    expect(status).toEqual({ isRepo: false, branch: null, files: {}, ahead: 0, behind: 0 })
  })

  it('reports the current branch and no pending changes for a clean repository', async () => {
    const root = tempDir('dsh-workspace-git-clean-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')

    const status = await workspaceGitStatus(root)
    expect(status).toEqual({ isRepo: true, branch: 'main', files: {}, ahead: 0, behind: 0 })
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
    expect(status).toEqual({ isRepo: true, branch: 'main', files: { [join(root, 'sub', 'a.txt')]: 'M' }, ahead: 0, behind: 0 })
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

  it('classifies an unmerged (conflicted) path as X, distinct from untracked', async () => {
    const root = tempDir('dsh-workspace-git-conflict-')
    initRepo(root)
    writeFileSync(join(root, 'f.txt'), 'base')
    commitAll(root, 'base')
    execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feature'])
    writeFileSync(join(root, 'f.txt'), 'feature change')
    commitAll(root, 'feature change')
    execFileSync('git', ['-C', root, 'checkout', '-q', 'main'])
    writeFileSync(join(root, 'f.txt'), 'main change')
    commitAll(root, 'main change')
    try {
      execFileSync('git', ['-C', root, 'merge', '-q', 'feature'])
    } catch {
      // Expected: the merge conflicts, leaving 'f.txt' unmerged.
    }

    const status = await workspaceGitStatus(root)
    expect(status.files).toEqual({ [join(root, 'f.txt')]: 'X' })
  })

  it('reports ahead/behind as 0 when the current branch has no configured upstream', async () => {
    const root = tempDir('dsh-workspace-git-no-upstream-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')

    const status = await workspaceGitStatus(root)
    expect(status).toMatchObject({ ahead: 0, behind: 0 })
  })

  it('reports ahead/behind relative to the upstream after fetching diverged commits', async () => {
    const remote = tempDir('dsh-workspace-git-remote-')
    initBareRemote(remote)
    const a = tempDir('dsh-workspace-git-ahead-behind-a-')
    cloneRepo(remote, a)
    writeFileSync(join(a, 'base.txt'), 'base')
    commitAll(a, 'base')
    execFileSync('git', ['-C', a, 'push', '-q', '-u', 'origin', 'main'])

    const b = tempDir('dsh-workspace-git-ahead-behind-b-')
    cloneRepo(remote, b)
    writeFileSync(join(b, 'local.txt'), 'local')
    commitAll(b, 'local change')

    writeFileSync(join(a, 'remote.txt'), 'remote')
    commitAll(a, 'remote change')
    execFileSync('git', ['-C', a, 'push', '-q'])
    execFileSync('git', ['-C', b, 'fetch', '-q'])

    const status = await workspaceGitStatus(b)
    expect(status).toMatchObject({ ahead: 1, behind: 1 })
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

describe('pullRebase', () => {
  it('fetches from the remote and rebases local commits on top', async () => {
    const remote = tempDir('dsh-workspace-git-remote-')
    initBareRemote(remote)
    const a = tempDir('dsh-workspace-git-pull-a-')
    cloneRepo(remote, a)
    writeFileSync(join(a, 'base.txt'), 'base')
    commitAll(a, 'base')
    execFileSync('git', ['-C', a, 'push', '-q'])

    const b = tempDir('dsh-workspace-git-pull-b-')
    cloneRepo(remote, b)
    writeFileSync(join(b, 'local.txt'), 'local')
    commitAll(b, 'local change')

    // A commit lands on the remote that b has not fetched yet.
    writeFileSync(join(a, 'remote.txt'), 'remote')
    commitAll(a, 'remote change')
    execFileSync('git', ['-C', a, 'push', '-q'])

    await pullRebase(b)

    expect(execFileSync('git', ['-C', b, 'log', '--format=%s']).toString().trim().split('\n')).toEqual([
      'local change', 'remote change', 'base',
    ])
    expect(existsSync(join(b, 'remote.txt'))).toBe(true)
  })

  it('rejects a directory outside any git working tree with GitNotARepositoryError', async () => {
    const root = tempDir('dsh-workspace-git-pull-none-')
    await expect(pullRebase(root)).rejects.toThrow(GitNotARepositoryError)
  })

  it('rejects with GitCommandError on a rebase conflict', async () => {
    const remote = tempDir('dsh-workspace-git-remote-')
    initBareRemote(remote)
    const a = tempDir('dsh-workspace-git-pull-conflict-a-')
    cloneRepo(remote, a)
    writeFileSync(join(a, 'f.txt'), 'base')
    commitAll(a, 'base')
    execFileSync('git', ['-C', a, 'push', '-q'])

    const b = tempDir('dsh-workspace-git-pull-conflict-b-')
    cloneRepo(remote, b)
    writeFileSync(join(b, 'f.txt'), 'local change')
    commitAll(b, 'local change')

    writeFileSync(join(a, 'f.txt'), 'remote change')
    commitAll(a, 'remote change')
    execFileSync('git', ['-C', a, 'push', '-q'])

    await expect(pullRebase(b)).rejects.toThrow(GitCommandError)
  })

  it('propagates an abort instead of collapsing into a GitCommandError', async () => {
    const root = tempDir('dsh-workspace-git-pull-abort-')
    initRepo(root)
    const controller = new AbortController()
    controller.abort()
    const error = await pullRebase(root, controller.signal).catch((reason: unknown) => reason)
    expect(error).not.toBeInstanceOf(GitCommandError)
    expect(error).not.toBeInstanceOf(GitNotARepositoryError)
  })
})

describe('push', () => {
  it('falls back to a bare push when the branch has no configured remote', async () => {
    const root = tempDir('dsh-workspace-git-push-no-remote-')
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'hello')
    commitAll(root, 'init')

    await expect(push(root)).rejects.toThrow(GitCommandError)
  })

  it('falls back to a bare push on a detached HEAD, skipping remote resolution', async () => {
    const remote = tempDir('dsh-workspace-git-remote-')
    initBareRemote(remote)
    const local = tempDir('dsh-workspace-git-push-detached-')
    cloneRepo(remote, local)
    writeFileSync(join(local, 'a.txt'), 'hello')
    commitAll(local, 'init')
    execFileSync('git', ['-C', local, 'checkout', '-q', 'HEAD~0'])

    await expect(push(local)).rejects.toThrow(GitCommandError)
  })

  it('pushes local commits to the configured remote', async () => {
    const remote = tempDir('dsh-workspace-git-remote-')
    initBareRemote(remote)
    const local = tempDir('dsh-workspace-git-push-')
    cloneRepo(remote, local)
    writeFileSync(join(local, 'a.txt'), 'hello')
    commitAll(local, 'init')

    await push(local)

    const check = tempDir('dsh-workspace-git-push-check-')
    cloneRepo(remote, check)
    expect(readFileSync(join(check, 'a.txt'), 'utf8')).toBe('hello')
  })

  it('rejects a directory outside any git working tree with GitNotARepositoryError', async () => {
    const root = tempDir('dsh-workspace-git-push-none-')
    await expect(push(root)).rejects.toThrow(GitNotARepositoryError)
  })

  it('rejects with GitCommandError on a non-fast-forward push', async () => {
    const remote = tempDir('dsh-workspace-git-remote-')
    initBareRemote(remote)
    const a = tempDir('dsh-workspace-git-push-nff-a-')
    cloneRepo(remote, a)
    writeFileSync(join(a, 'f.txt'), 'base')
    commitAll(a, 'base')
    execFileSync('git', ['-C', a, 'push', '-q'])

    const b = tempDir('dsh-workspace-git-push-nff-b-')
    cloneRepo(remote, b)
    writeFileSync(join(b, 'g.txt'), 'b change')
    commitAll(b, 'b change')

    // a diverges the remote from under b before b ever pushes.
    writeFileSync(join(a, 'h.txt'), 'a change')
    commitAll(a, 'a change')
    execFileSync('git', ['-C', a, 'push', '-q'])

    await expect(push(b)).rejects.toThrow(GitCommandError)
  })

  it('pushes only the current branch when the host has push.default set to "matching"', async () => {
    const remote = tempDir('dsh-workspace-git-remote-')
    initBareRemote(remote)
    const seed = tempDir('dsh-workspace-git-push-refspec-seed-')
    cloneRepo(remote, seed)
    writeFileSync(join(seed, 'a.txt'), 'hello')
    commitAll(seed, 'init')
    execFileSync('git', ['-C', seed, 'push', '-q'])
    execFileSync('git', ['-C', seed, 'checkout', '-q', '-b', 'other'])
    writeFileSync(join(seed, 'b.txt'), 'other init')
    commitAll(seed, 'other init')
    execFileSync('git', ['-C', seed, 'push', '-q', '-u', 'origin', 'other'])

    const local = tempDir('dsh-workspace-git-push-refspec-local-')
    cloneRepo(remote, local)
    // "matching" pushes every local branch with a same-named remote
    // counterpart, not only the current one — a bare `git push` here would
    // also push 'other', proving the fix requires the explicit refspec.
    execFileSync('git', ['-C', local, 'config', 'push.default', 'matching'])
    execFileSync('git', ['-C', local, 'checkout', '-q', '-b', 'other', 'origin/other'])
    writeFileSync(join(local, 'b.txt'), 'other change')
    commitAll(local, 'other change')
    execFileSync('git', ['-C', local, 'checkout', '-q', 'main'])
    writeFileSync(join(local, 'a.txt'), 'main change')
    commitAll(local, 'main change')

    await push(local)

    expect(execFileSync('git', ['-C', remote, 'log', 'main', '--format=%s']).toString()).toContain('main change')
    expect(execFileSync('git', ['-C', remote, 'log', 'other', '--format=%s']).toString()).not.toContain('other change')
  })

  it('propagates an abort instead of collapsing into a GitCommandError', async () => {
    const root = tempDir('dsh-workspace-git-push-abort-')
    initRepo(root)
    const controller = new AbortController()
    controller.abort()
    const error = await push(root, controller.signal).catch((reason: unknown) => reason)
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

  it('aborts an in-progress rebase instead of leaving a detached HEAD with conflict markers', async () => {
    const remote = tempDir('dsh-workspace-git-remote-')
    initBareRemote(remote)
    const a = tempDir('dsh-workspace-git-discard-rebase-a-')
    cloneRepo(remote, a)
    writeFileSync(join(a, 'f.txt'), 'base')
    commitAll(a, 'base')
    execFileSync('git', ['-C', a, 'push', '-q'])

    const b = tempDir('dsh-workspace-git-discard-rebase-b-')
    cloneRepo(remote, b)
    writeFileSync(join(b, 'f.txt'), 'local change')
    commitAll(b, 'local change')

    writeFileSync(join(a, 'f.txt'), 'remote change')
    commitAll(a, 'remote change')
    execFileSync('git', ['-C', a, 'push', '-q'])

    await expect(pullRebase(b)).rejects.toThrow(GitCommandError)

    await discardAllChanges(b)

    // Restored to the branch's own pre-rebase tip, not left detached mid-rebase.
    expect(execFileSync('git', ['-C', b, 'symbolic-ref', '--short', 'HEAD']).toString().trim()).toBe('main')
    expect(readFileSync(join(b, 'f.txt'), 'utf-8')).toBe('local change')
    const status = await workspaceGitStatus(b)
    expect(status.files).toEqual({})
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
