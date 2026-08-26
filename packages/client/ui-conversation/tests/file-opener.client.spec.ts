import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { FileOpenRegistryImpl } from '../src/client/files/file-opener.ts'

const s1 = 's1' as SessionId
const s2 = 's2' as SessionId

describe('FileOpenRegistryImpl', () => {
  it('starts with no pending request for an unread session', () => {
    const registry = new FileOpenRegistryImpl()
    expect(registry.storeFor(s1).getSnapshot()).toBeUndefined()
  })

  it('publishes a request through that session\'s store', () => {
    const registry = new FileOpenRegistryImpl()
    registry.request(s1, '/ws/notes.txt')
    expect(registry.storeFor(s1).getSnapshot()).toEqual({ path: '/ws/notes.txt', seq: 0 })
  })

  it('keeps sessions isolated: a request for one never reaches another', () => {
    const registry = new FileOpenRegistryImpl()
    registry.request(s1, '/ws/notes.txt')
    expect(registry.storeFor(s2).getSnapshot()).toBeUndefined()
  })

  it('assigns an increasing seq across requests, even repeats of the same path', () => {
    const registry = new FileOpenRegistryImpl()
    registry.request(s1, '/ws/a.txt')
    registry.request(s1, '/ws/a.txt')
    const second = registry.storeFor(s1).getSnapshot()
    expect(second?.seq).toBe(1)
  })

  it('notifies subscribers of a new request', () => {
    const registry = new FileOpenRegistryImpl()
    const listener = vi.fn()
    registry.storeFor(s1).subscribe(listener)
    registry.request(s1, '/ws/notes.txt')
    expect(listener).toHaveBeenCalled()
  })

  it('returns the same store instance across repeated storeFor calls for one session', () => {
    const registry = new FileOpenRegistryImpl()
    expect(registry.storeFor(s1)).toBe(registry.storeFor(s1))
  })

  it('forget drops the session\'s store; a later storeFor mints a fresh, empty one', () => {
    const registry = new FileOpenRegistryImpl()
    registry.request(s1, '/ws/notes.txt')
    const before = registry.storeFor(s1)
    registry.forget(s1)
    const after = registry.storeFor(s1)
    expect(after).not.toBe(before)
    expect(after.getSnapshot()).toBeUndefined()
  })
})
