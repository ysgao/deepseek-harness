/** Pure-function and real-filesystem branch coverage of workspace-files.ts. */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isWithinWorkspace, listWorkspaceEntries, mediaTypeFor, readWorkspaceFile, resolveWorkspacePath, WorkspaceFileError,
} from '../src/workspace-files.ts'

function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

describe('isWithinWorkspace', () => {
  it('accepts the root itself', () => {
    expect(isWithinWorkspace('/a/ws', '/a/ws')).toBe(true)
  })

  it('accepts a descendant', () => {
    expect(isWithinWorkspace('/a/ws', '/a/ws/sub/deep.txt')).toBe(true)
  })

  it('rejects a sibling directory sharing a name prefix', () => {
    expect(isWithinWorkspace('/a/ws', '/a/ws-2')).toBe(false)
  })

  it('rejects an ancestor of the root', () => {
    expect(isWithinWorkspace('/a/ws', '/a')).toBe(false)
  })

  it('rejects an unrelated path', () => {
    expect(isWithinWorkspace('/a/ws', '/b/other')).toBe(false)
  })
})

describe('mediaTypeFor', () => {
  it('maps known image extensions case-insensitively', () => {
    expect(mediaTypeFor('/a/photo.PNG')).toBe('image/png')
    expect(mediaTypeFor('/a/photo.jpg')).toBe('image/jpeg')
    expect(mediaTypeFor('/a/photo.jpeg')).toBe('image/jpeg')
    expect(mediaTypeFor('/a/photo.gif')).toBe('image/gif')
    expect(mediaTypeFor('/a/photo.webp')).toBe('image/webp')
    expect(mediaTypeFor('/a/icon.svg')).toBe('image/svg+xml')
  })

  it('maps pdf', () => {
    expect(mediaTypeFor('/a/doc.pdf')).toBe('application/pdf')
  })

  it('falls back to octet-stream for an unknown extension', () => {
    expect(mediaTypeFor('/a/archive.bin')).toBe('application/octet-stream')
  })

  it('falls back to octet-stream for a dotfile with no extension', () => {
    expect(mediaTypeFor('/a/.gitignore')).toBe('application/octet-stream')
  })
})

describe('resolveWorkspacePath', () => {
  it('resolves a relative segment against the process cwd to an absolute path', () => {
    expect(resolveWorkspacePath('.')).toBe(process.cwd())
  })
})

describe('listWorkspaceEntries', () => {
  it('rejects a target that cannot be opened', async () => {
    const root = tempDir('dsh-workspace-files-missing-')
    await expect(listWorkspaceEntries(join(root, 'missing'))).rejects.toThrow(WorkspaceFileError)
  })

  it('rejects opening a target that is a regular file, not a directory (a real, non-ENOENT opendir failure)', async () => {
    const root = tempDir('dsh-workspace-files-not-a-dir-')
    const filePath = join(root, 'plain.txt')
    writeFileSync(filePath, 'x')
    await expect(listWorkspaceEntries(filePath)).rejects.toThrow(WorkspaceFileError)
  })

  it('follows a symlink to a regular file, reporting it as type: file', async () => {
    const root = tempDir('dsh-workspace-files-symlink-file-')
    writeFileSync(join(root, 'target.txt'), 'x')
    symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'))
    const listing = await listWorkspaceEntries(root)
    expect(listing.entries.find(e => e.name === 'link.txt')).toMatchObject({ type: 'file' })
  })

  it('skips a symlink whose target neither stats as a directory nor a file (denied stat)', async () => {
    const root = tempDir('dsh-workspace-files-symlink-broken-')
    symlinkSync(join(root, 'does-not-exist'), join(root, 'broken.link'))
    const listing = await listWorkspaceEntries(root)
    expect(listing.entries.map(e => e.name)).not.toContain('broken.link')
  })

  it('cuts the files bucket independently of an unbounded directories bucket', async () => {
    const root = tempDir('dsh-workspace-files-bucket-')
    mkdirSync(join(root, 'onedir'))
    writeFileSync(join(root, 'a.txt'), '')
    writeFileSync(join(root, 'b.txt'), '')
    const listing = await listWorkspaceEntries(root, 1)
    expect(listing.truncated).toBe(true)
    expect(listing.entries.filter(e => e.type === 'directory')).toHaveLength(1)
    expect(listing.entries.filter(e => e.type === 'file')).toHaveLength(1)
  })
})

describe('readWorkspaceFile', () => {
  it('rejects a missing file', async () => {
    const root = tempDir('dsh-workspace-files-read-missing-')
    await expect(readWorkspaceFile(join(root, 'missing.txt'))).rejects.toThrow(WorkspaceFileError)
  })

  it('rejects an already-aborted signal before any I/O', async () => {
    const root = tempDir('dsh-workspace-files-read-preaborted-')
    const path = join(root, 'file.txt')
    writeFileSync(path, 'content')
    const controller = new AbortController()
    controller.abort()
    await expect(readWorkspaceFile(path, undefined, controller.signal)).rejects.toThrow()
  })

  it('rejects a directory path that passes the size probe but fails the actual read', async () => {
    // A directory has a `.size` from stat (so it clears the size-bound
    // check) but node:fs/promises readFile on a directory rejects with a
    // real EISDIR Error: this exercises the second try/catch's non-abort arm
    // deterministically, unlike a genuinely time-dependent vanish-between-
    // steps race.
    const root = tempDir('dsh-workspace-files-read-dir-')
    mkdirSync(join(root, 'not-a-file'))
    await expect(readWorkspaceFile(join(root, 'not-a-file'))).rejects.toThrow(WorkspaceFileError)
  })
})
