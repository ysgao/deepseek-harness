/**
 * Host-side workspace file browsing: one-level directory-and-file listing and
 * bounded single-file reads rooted under a workspace's own directory, for the
 * Web GUI's in-app Files tree (sibling to a workspace's session list). This is
 * a distinct primitive from `host.listDirectory`/`ctx.directoryPicker`, which
 * is the directory-ONLY workspace-root picker; nothing here touches that seam.
 * Root containment (`path` must be the workspace's own path or a descendant of
 * it) is the caller's job — this module lists and reads whatever absolute
 * path it is given.
 * @module
 */

import { opendir, readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { WorkspaceEntry, WorkspaceEntryListing, WorkspaceFileContent } from './api/workspace.ts'

/** Typed failure so the RPC layer can map business codes without string matching. */
export class WorkspaceFileError extends Error {
  /**
   * @param code - closed business code of the failure.
   * @param path - the absolute path the failure is about.
   * @param message - operator-facing description.
   * @param maxBytes - the enforced read bound, present only for `file-too-large`.
   */
  constructor(
    readonly code: 'directory-unreadable' | 'file-too-large',
    readonly path: string,
    message: string,
    readonly maxBytes?: number,
  ) {
    super(message)
    this.name = 'WorkspaceFileError'
  }
}

/** Complete-result bound of one `listEntries` level (entries beyond this many are cut, name-sorted tail). */
export const DEFAULT_MAX_ENTRIES = 1000

/** Byte bound of one `readFile` call; a larger file fails with `file-too-large` before any content leaves the host. */
export const DEFAULT_MAX_READ_BYTES = 20 * 1024 * 1024

/**
 * True when `path` is the workspace root itself or a filesystem descendant of
 * it. `node:path.relative` already answers containment by path segments, not
 * string prefix, so a sibling directory sharing a name prefix (`/ws` vs
 * `/ws-2`) is correctly rejected (its relative form is `../ws-2`).
 * @param root - the workspace's own canonical absolute path.
 * @param path - the candidate absolute path.
 * @returns whether `path` is inside `root` (root itself counts).
 */
export function isWithinWorkspace(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function messageOf(error: unknown): string {
  /* v8 ignore next -- every catch site rejects with a real node:fs Error; the String() fallback exists only for the `unknown` narrowing. */
  return error instanceof Error ? error.message : String(error)
}

/** Best-effort media type from a file extension; unknown extensions fall back to a generic binary type. */
const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
}

/**
 * Media type for a binary read result, by extension.
 * @param path - absolute file path (only its extension is read).
 * @returns a registered media type, or the generic octet-stream fallback.
 */
export function mediaTypeFor(path: string): string {
  return MEDIA_TYPES_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * List one directory level: subdirectories and regular files together,
 * directories first, then name-sorted within each group. Symlinks to a
 * directory are followed and reported as `type: 'directory'`; symlinks to a
 * file are reported as `type: 'file'`; broken/cyclic symlinks and non-regular
 * entries (sockets, devices, FIFOs) are skipped, matching the browse-picker
 * seam's "list what could actually be opened" stance. Each bucket
 * (directories, files) is independently bounded by `maxEntries`, admitting
 * candidates in `readdir` arrival order — not the sorted-window technique
 * `directory-picker-browse` uses — so a level with more than `maxEntries`
 * directories or files reports a `truncated` cut whose kept rows are sorted
 * but not guaranteed to be the name-sorted head.
 * @param path - absolute directory to list.
 * @param maxEntries - complete-result bound per bucket; a cut level reports `truncated: true`.
 * @param signal - caller lifetime; abort stops the scan and rejects with the abort reason.
 * @returns the level's entries and truncation flag.
 * @throws {WorkspaceFileError} `directory-unreadable` when the target cannot be listed.
 */
export async function listWorkspaceEntries(
  path: string,
  maxEntries: number = DEFAULT_MAX_ENTRIES,
  signal?: AbortSignal,
): Promise<WorkspaceEntryListing> {
  signal?.throwIfAborted()
  const directories: WorkspaceEntry[] = []
  const files: WorkspaceEntry[] = []
  let truncated = false
  let dir: Awaited<ReturnType<typeof opendir>>
  try {
    dir = await opendir(path)
  } catch (error: unknown) {
    throw new WorkspaceFileError('directory-unreadable', path, `cannot list ${path}: ${messageOf(error)}`)
  }
  signal?.throwIfAborted()
  try {
    for await (const dirent of dir) {
      signal?.throwIfAborted()
      const childPath = join(path, dirent.name)
      let isDirectory = dirent.isDirectory()
      const isFile = dirent.isFile()
      if (!isDirectory && !isFile && dirent.isSymbolicLink()) {
        try {
          const target = await stat(childPath)
          isDirectory = target.isDirectory()
          /* v8 ignore next -- needs a symlinked FIFO/socket target, not
             constructible from a portable test. */
          if (!isDirectory && !target.isFile()) continue
        } catch {
          continue // broken/cyclic symlink: not enterable, not readable — skip.
        }
      }
      /* v8 ignore start -- a bare (non-symlink) FIFO/socket/device dirent needs mkfifo, not constructible from a portable test. */
      else if (!isDirectory && !isFile) {
        continue // socket, device, FIFO: neither browsable nor previewable.
      }
      /* v8 ignore stop */
      const bucket = isDirectory ? directories : files
      if (bucket.length === maxEntries) {
        truncated = true
        continue
      }
      const entry: WorkspaceEntry = {
        name: dirent.name,
        path: childPath,
        type: isDirectory ? 'directory' : 'file',
        hidden: dirent.name.startsWith('.'),
      }
      if (!isDirectory) {
        try {
          entry.size = (await stat(childPath)).size
        } catch {
          // A file that disappeared between readdir and stat: report it
          // without a size rather than dropping the row (it existed a moment ago).
        }
      }
      bucket.push(entry)
    }
  /* v8 ignore start -- a mid-scan I/O failure needs an unstable filesystem;
     deleting the directory mid-iteration does not reliably invalidate the
     open handle on this suite's platforms. */
  } catch (error: unknown) {
    signal?.throwIfAborted()
    throw new WorkspaceFileError('directory-unreadable', path, `cannot list ${path}: ${messageOf(error)}`)
  }
  /* v8 ignore stop */
  directories.sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.name.localeCompare(b.name))
  return { path, entries: [...directories, ...files], truncated }
}

/**
 * Read one regular file for in-app preview: valid UTF-8 decodes as text;
 * anything else (binary content, or text with a decoding error) returns as
 * base64 with a best-effort media type.
 * @param path - absolute file path.
 * @param maxBytes - byte bound enforced BEFORE the read completes (a stat probe first).
 * @param signal - caller lifetime; abort stops the read and rejects with the abort reason.
 * @returns the decoded content.
 * @throws {WorkspaceFileError} `directory-unreadable` when the file cannot be
 * read, `file-too-large` when its size exceeds `maxBytes`.
 */
export async function readWorkspaceFile(
  path: string,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
  signal?: AbortSignal,
): Promise<WorkspaceFileContent> {
  signal?.throwIfAborted()
  let size: number
  try {
    size = (await stat(path)).size
  } catch (error: unknown) {
    throw new WorkspaceFileError('directory-unreadable', path, `cannot read ${path}: ${messageOf(error)}`)
  }
  signal?.throwIfAborted()
  if (size > maxBytes) {
    throw new WorkspaceFileError(
      'file-too-large', path, `file "${path}" (${size} bytes) exceeds the ${maxBytes}-byte preview bound`, maxBytes,
    )
  }
  let bytes: Buffer
  try {
    bytes = await readFile(path, { signal })
  } catch (error: unknown) {
    signal?.throwIfAborted()
    throw new WorkspaceFileError('directory-unreadable', path, `cannot read ${path}: ${messageOf(error)}`)
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return { kind: 'text', content: decoder.decode(bytes) }
  } catch {
    return { kind: 'binary', mediaType: mediaTypeFor(path), data: bytes.toString('base64') }
  }
}

/**
 * Resolve a wire path to its absolute canonical form for containment
 * checking; does not require the path to exist.
 * @param path - the wire-supplied path.
 * @returns the absolute, resolved path.
 */
export function resolveWorkspacePath(path: string): string {
  return resolve(path)
}
