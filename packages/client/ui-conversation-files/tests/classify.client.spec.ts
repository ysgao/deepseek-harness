import { describe, expect, it } from 'vitest'
import { langFromPath, viewerKindFor } from '../src/client/files/classify.ts'

describe('viewerKindFor', () => {
  it('classifies markdown', () => {
    expect(viewerKindFor('/a/README.md')).toBe('markdown')
    expect(viewerKindFor('/a/notes.MARKDOWN')).toBe('markdown')
  })

  it('classifies images', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']) {
      expect(viewerKindFor(`/a/pic.${ext}`)).toBe('image')
    }
  })

  it('classifies known text/code extensions', () => {
    expect(viewerKindFor('/a/index.ts')).toBe('text')
    expect(viewerKindFor('/a/notes.txt')).toBe('text')
    expect(viewerKindFor('/a/config.log')).toBe('text')
  })

  it('falls back to external for pdf', () => {
    expect(viewerKindFor('/a/doc.pdf')).toBe('external')
  })

  it('falls back to external for an unrecognized extension', () => {
    expect(viewerKindFor('/a/archive.bin')).toBe('external')
  })

  it('falls back to external for a dotfile with no extension (undefined extension)', () => {
    expect(viewerKindFor('/a/.gitignore')).toBe('external')
  })

  it('falls back to external for a name with no dot at all', () => {
    expect(viewerKindFor('/a/Makefile')).toBe('external')
  })

  it('accepts a backslash-separated path', () => {
    expect(viewerKindFor('C:\\a\\b\\file.ts')).toBe('text')
  })
})

describe('langFromPath', () => {
  it('maps a known extension', () => {
    expect(langFromPath('/a/index.tsx')).toBe('tsx')
  })

  it('returns undefined for an extension with no grammar hint', () => {
    expect(langFromPath('/a/notes.txt')).toBeUndefined()
  })

  it('returns undefined for a dotfile with no extension', () => {
    expect(langFromPath('/a/.gitignore')).toBeUndefined()
  })

  it('lowercases the extension before matching', () => {
    expect(langFromPath('/a/Photo.PNG')).toBeUndefined()
    expect(langFromPath('/a/App.TSX')).toBe('tsx')
  })
})
