/**
 * File-extension classification for the File view's in-app preview: which
 * {@link FilePreviewKind} a file opens as, and (for text/code) which shiki
 * grammar hints its highlighting. Duplicated in miniature from
 * `ui-workspace`'s own `classify.ts` (itself duplicated from the `read`
 * tool's `langFromPath`) rather than imported: cross-package imports of
 * another plugin's symbols are forbidden (packages/client/AGENTS.md), and
 * this is a small pure mapping, not a shared business concept.
 */
import type { FilePreviewKind } from '@deepseek-ai/dsh-client-ui-primitives'

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

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
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
function extensionOf(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  return base.slice(dot + 1).toLowerCase()
}

/**
 * Which {@link FilePreviewKind} a file path's extension selects. `.pdf` and
 * every other unrecognized extension answer `'external'` (the `openPath`
 * OS-default handoff).
 * @param path - absolute or display path.
 * @returns the preview kind to open the file as.
 */
export function viewerKindFor(path: string): FilePreviewKind {
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
