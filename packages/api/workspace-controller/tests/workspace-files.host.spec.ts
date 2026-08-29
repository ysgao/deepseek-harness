/** Pure-function and real-filesystem branch coverage of workspace-files.ts. */
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkspaceFileVersion } from '../src/types.ts'
import {
  createWorkspaceDirectory, createWorkspaceFile, isWithinWorkspace, listWorkspaceEntries, mediaTypeFor,
  readWorkspaceFile, resolveWorkspacePath, WorkspaceFileError, writeWorkspaceFile,
} from '../src/files.ts'

/** `hashContent` isn't exported (an implementation detail); tests derive the expected version independently the same way it would. */
function versionOf(content: string): WorkspaceFileVersion {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex') as WorkspaceFileVersion
}

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

  it('returns the content hash as version for a text read', async () => {
    const root = tempDir('dsh-workspace-files-read-version-')
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'hello')
    const content = await readWorkspaceFile(path)
    expect(content).toEqual({ kind: 'text', content: 'hello', version: versionOf('hello') })
  })
})

describe('writeWorkspaceFile', () => {
  it('overwrites an existing file and returns the new content\'s version', async () => {
    const root = tempDir('dsh-workspace-files-write-ok-')
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'old')
    const version = await writeWorkspaceFile(path, 'new content', versionOf('old'))
    expect(version).toBe(versionOf('new content'))
    expect(readFileSync(path, 'utf-8')).toBe('new content')
  })

  it('rejects a stale expectedVersion with file-changed, leaving the file untouched', async () => {
    const root = tempDir('dsh-workspace-files-write-stale-')
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'current')
    await expect(writeWorkspaceFile(path, 'new', versionOf('a different past content')))
      .rejects.toMatchObject({ code: 'file-changed' })
    expect(readFileSync(path, 'utf-8')).toBe('current')
  })

  it('rejects content exceeding maxBytes with file-too-large before touching the file', async () => {
    const root = tempDir('dsh-workspace-files-write-too-large-')
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'small')
    await expect(writeWorkspaceFile(path, 'this is too long', versionOf('small'), 4))
      .rejects.toMatchObject({ code: 'file-too-large', maxBytes: 4 })
    expect(readFileSync(path, 'utf-8')).toBe('small')
  })

  it('rejects a missing target file (never creates a new file)', async () => {
    const root = tempDir('dsh-workspace-files-write-missing-')
    await expect(writeWorkspaceFile(join(root, 'missing.txt'), 'x', versionOf('')))
      .rejects.toMatchObject({ code: 'directory-unreadable' })
  })

  it('rejects an already-aborted signal before any I/O', async () => {
    const root = tempDir('dsh-workspace-files-write-preaborted-')
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'current')
    const controller = new AbortController()
    controller.abort()
    await expect(writeWorkspaceFile(path, 'new', versionOf('current'), undefined, controller.signal)).rejects.toThrow()
  })

  it('leaves no temp file behind after a successful write', async () => {
    const root = tempDir('dsh-workspace-files-write-notemp-')
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'old')
    await writeWorkspaceFile(path, 'new', versionOf('old'))
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toHaveLength(0)
  })
})

describe('createWorkspaceFile', () => {
  it('creates a new empty file and returns the empty-content version', async () => {
    const root = tempDir('dsh-workspace-files-create-file-ok-')
    const path = join(root, 'notes.txt')
    const version = await createWorkspaceFile(path)
    expect(version).toBe(versionOf(''))
    expect(readFileSync(path, 'utf-8')).toBe('')
  })

  it('rejects an already-existing target with already-exists, leaving its content untouched', async () => {
    const root = tempDir('dsh-workspace-files-create-file-exists-')
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'existing content')
    await expect(createWorkspaceFile(path)).rejects.toMatchObject({ code: 'already-exists', path })
    expect(readFileSync(path, 'utf-8')).toBe('existing content')
  })

  it('rejects a missing parent directory with parent-missing', async () => {
    const root = tempDir('dsh-workspace-files-create-file-noparent-')
    const path = join(root, 'missing-dir', 'notes.txt')
    await expect(createWorkspaceFile(path)).rejects.toMatchObject({ code: 'parent-missing', path })
  })

  it('rejects an already-aborted signal before any I/O', async () => {
    const root = tempDir('dsh-workspace-files-create-file-preaborted-')
    const path = join(root, 'notes.txt')
    const controller = new AbortController()
    controller.abort()
    await expect(createWorkspaceFile(path, controller.signal)).rejects.toThrow()
    expect(existsSync(path)).toBe(false)
  })
})

describe('createWorkspaceDirectory', () => {
  it('creates a new empty directory', async () => {
    const root = tempDir('dsh-workspace-files-create-dir-ok-')
    const path = join(root, 'sub')
    await createWorkspaceDirectory(path)
    expect(readdirSync(root)).toContain('sub')
  })

  it('rejects an already-existing directory target with already-exists', async () => {
    const root = tempDir('dsh-workspace-files-create-dir-exists-')
    const path = join(root, 'sub')
    mkdirSync(path)
    await expect(createWorkspaceDirectory(path)).rejects.toMatchObject({ code: 'already-exists', path })
  })

  it('rejects an already-existing file target with already-exists', async () => {
    const root = tempDir('dsh-workspace-files-create-dir-file-exists-')
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'x')
    await expect(createWorkspaceDirectory(path)).rejects.toMatchObject({ code: 'already-exists', path })
  })

  it('rejects a missing parent directory with parent-missing (never creates a chain of parents)', async () => {
    const root = tempDir('dsh-workspace-files-create-dir-noparent-')
    const path = join(root, 'missing-dir', 'sub')
    await expect(createWorkspaceDirectory(path)).rejects.toMatchObject({ code: 'parent-missing', path })
  })

  it('rejects an already-aborted signal before any I/O', async () => {
    const root = tempDir('dsh-workspace-files-create-dir-preaborted-')
    const path = join(root, 'sub')
    const controller = new AbortController()
    controller.abort()
    await expect(createWorkspaceDirectory(path, controller.signal)).rejects.toThrow()
    expect(existsSync(path)).toBe(false)
  })
})
