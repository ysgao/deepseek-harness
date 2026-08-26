import { describe, expect, it } from 'vitest'
import { extensionOf, langFromPath, viewerKindFor } from '../src/client/files/classify.ts'

describe('extensionOf', () => {
  it('lowercases a real extension', () => {
    expect(extensionOf('/a/b/Photo.PNG')).toBe('png')
  })

  it('returns undefined for a dotfile with no extension', () => {
    expect(extensionOf('/a/.gitignore')).toBeUndefined()
  })

  it('returns undefined for a name with no dot at all', () => {
    expect(extensionOf('/a/Makefile')).toBeUndefined()
  })

  it('accepts a backslash-separated path', () => {
    expect(extensionOf('C:\\a\\b\\file.ts')).toBe('ts')
  })
})

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

  it('falls back to external for a dotfile with no extension', () => {
    expect(viewerKindFor('/a/.gitignore')).toBe('external')
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
})
