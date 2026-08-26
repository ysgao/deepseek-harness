/**
 * File-extension classification for the Workspace Files tree's in-app
 * preview: which viewer a file opens in, and (for text/code) which shiki
 * grammar hints its highlighting. Intentionally small — common source,
 * config, and markup extensions worth a dedicated in-app view — not an
 * exhaustive registry; unmatched extensions fall back to `openPath` (the
 * host's OS-default-application handoff).
 */

/** Which in-app viewer a file extension opens (or none, meaning `openPath`). */
export type FileViewerKind = 'markdown' | 'image' | 'text' | 'external'

/**
 * shiki grammar hint by extension, duplicated in miniature from the `read`
 * tool's `langFromPath` (`packages/fs/tool-fs`) rather than imported: that
 * package is host/model-tool code, and importing it here would cross the
 * client/host layering boundary for a small pure mapping.
 */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json',
  py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
  cs: 'cs', kt: 'kotlin', swift: 'swift', php: 'php',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', lua: 'lua',
}

/** Image extensions the viewer renders inline through a blob URL. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

/** Markdown extensions rendered through the shared `MarkdownText` component. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])

/**
 * Text/code extensions worth a highlighted in-app preview. A deliberately
 * closed allowlist — not "everything that isn't image/markdown/pdf" — so an
 * unrecognized binary format never gets forced through UTF-8 decoding by the
 * viewer; the host's own read already answers `kind: 'binary'` for genuine
 * non-text bytes, but a closed allowlist here keeps the extension-based
 * decision legible without depending on that fact.
 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'env', 'gitignore', 'gitattributes', 'editorconfig',
  ...Object.keys(LANG_BY_EXTENSION),
])

/**
 * Lowercased extension of a path's base name, or `undefined` for a dotfile
 * (leading-dot-only name) or a name with no extension.
 * @param path - absolute or display path.
 * @returns the extension without its leading dot, lowercased.
 */
export function extensionOf(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  return base.slice(dot + 1).toLowerCase()
}

/**
 * Which in-app viewer a file path's extension selects. `.pdf` and every
 * other unrecognized extension answer `'external'` (the `openPath` OS-default
 * handoff) — PDF in-app preview is a deferred follow-up, not a gap in this
 * classification.
 * @param path - absolute or display path.
 * @returns the viewer kind to open the file in.
 */
export function viewerKindFor(path: string): FileViewerKind {
  const ext = extensionOf(path)
  if (ext === undefined) return 'external'
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'external'
}

/**
 * shiki grammar hint for a text/code preview.
 * @param path - absolute or display path.
 * @returns the language hint, or `undefined` when the extension maps to none (plain monospace).
 */
export function langFromPath(path: string): string | undefined {
  const ext = extensionOf(path)
  if (ext === undefined) return undefined
  return Object.hasOwn(LANG_BY_EXTENSION, ext) ? LANG_BY_EXTENSION[ext] : undefined
}
