import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { CredentialKey, RpcId } from '@deepseek-ai/dsh-api-remotes/client'
import { AuthorizationManager } from '../src/client/authorization/manager.ts'
import { AuthorizationRequestError, AuthorizationRuntime } from '../src/client/authorization/service.ts'
import { FakeApiClient, err, ok } from './fake-api.client.ts'

const KEY = 'llm-pi-ai/anthropic' as CredentialKey
const OTHER = 'llm-pi-ai/openai' as CredentialKey

function entry(over: { key?: CredentialKey; inFlight?: boolean } = {}) {
  return {
    key: over.key ?? KEY, label: 'Anthropic (Claude Pro/Max)',
    methods: [{ id: 'oauth', label: 'Sign in with Anthropic' }],
    inFlight: over.inFlight ?? false,
  }
}

describe('AuthorizationManager', () => {
  it('refreshes the entry list and seeds live per-key state, keeping an existing inFlight bit fresh', async () => {
    const api = new FakeApiClient()
    const manager = new AuthorizationManager(api)
    expect(manager.getSnapshot()).toEqual({ entries: [], state: 'idle', byKey: {} })

    api.onAuthorizationList = () => Promise.resolve(ok({ entries: [entry()] }))
    await manager.refresh()
    expect(manager.getSnapshot().state).toBe('loaded')
    expect(manager.getSnapshot().entries).toEqual([entry()])
    expect(manager.getSnapshot().byKey[KEY]).toEqual({ inFlight: false, notices: [], pendingPrompt: undefined })

    // A live push already marked this key inFlight; a later baseline that
    // still reports it running must not clobber the accumulated notices.
    manager.handleHostEnvelope({
      rpcId: 'n1' as RpcId,
      payload: { type: 'authorization/notice', key: KEY, notice: { message: 'go' } },
    })
    api.onAuthorizationList = () => Promise.resolve(ok({ entries: [entry({ inFlight: true })] }))
    await manager.refresh()
    expect(manager.getSnapshot().byKey[KEY]).toEqual({
      inFlight: true, notices: [{ message: 'go' }], pendingPrompt: undefined,
    })
  })

  it('single-flights refresh and folds a business or transport failure into state:error', async () => {
    const api = new FakeApiClient()
    const manager = new AuthorizationManager(api)
    api.onAuthorizationList = () => Promise.resolve(err({ code: 'internal', message: 'down', details: {} }))
    await manager.refresh()
    expect(manager.getSnapshot().state).toBe('error')
    api.onAuthorizationList = () => Promise.reject(new Error('wire down'))
    await manager.refresh()
    expect(manager.getSnapshot().state).toBe('error')
  })

  it('applies notice, prompt-requested, and prompt-resolved frames to the right key only', () => {
    const api = new FakeApiClient()
    const manager = new AuthorizationManager(api)
    manager.handleHostEnvelope({
      rpcId: 'n1' as RpcId,
      payload: { type: 'authorization/notice', key: KEY, notice: { message: 'open this', url: 'https://x' } },
    })
    expect(manager.getSnapshot().byKey[KEY]).toMatchObject({ inFlight: true, notices: [{ message: 'open this', url: 'https://x' }] })
    expect(manager.getSnapshot().byKey[OTHER]).toBeUndefined()

    manager.handleHostEnvelope({
      rpcId: 'p1' as RpcId,
      payload: { type: 'authorization/prompt-requested', key: KEY, prompt: { kind: 'text', message: 'code?' } },
    })
    expect(manager.getSnapshot().byKey[KEY]?.pendingPrompt).toEqual({ rpcId: 'p1', prompt: { kind: 'text', message: 'code?' } })

    manager.handleHostEnvelope({
      rpcId: 'r1' as RpcId,
      payload: { type: 'authorization/prompt-resolved', key: KEY, outcome: 'answered' },
    })
    expect(manager.getSnapshot().byKey[KEY]?.pendingPrompt).toBeUndefined()
    // Notices persist across a prompt resolving; only settlement clears them.
    expect(manager.getSnapshot().byKey[KEY]?.notices).toHaveLength(1)
  })

  it('begin marks the key inFlight and clears prior notices, or throws AuthorizationRequestError on rejection', async () => {
    const api = new FakeApiClient()
    const manager = new AuthorizationManager(api)
    manager.handleHostEnvelope({
      rpcId: 'n1' as RpcId,
      payload: { type: 'authorization/notice', key: KEY, notice: { message: 'stale' } },
    })
    await manager.begin(KEY, 'oauth')
    expect(api.callsOf('authorization.begin')).toEqual([{ key: KEY, method: 'oauth' }])
    expect(manager.getSnapshot().byKey[KEY]).toEqual({ inFlight: true, notices: [], pendingPrompt: undefined })

    api.onAuthorizationBegin = () => Promise.resolve(err({ code: 'authorization-in-flight', message: 'busy', details: { key: KEY } }))
    await expect(manager.begin(KEY)).rejects.toThrow(AuthorizationRequestError)
  })

  it('cancel and notifySettled forward to the wire / clear live state without touching entries', async () => {
    const api = new FakeApiClient()
    const manager = new AuthorizationManager(api)
    manager.handleHostEnvelope({
      rpcId: 'n1' as RpcId,
      payload: { type: 'authorization/notice', key: KEY, notice: { message: 'go' } },
    })
    await manager.cancel(KEY)
    expect(api.callsOf('authorization.cancel')).toEqual([{ key: KEY }])
    // Cancel alone does not clear push state — only the settled report does,
    // since the attempt has not actually ended from the client's point of
    // view until the seam reports so.
    expect(manager.getSnapshot().byKey[KEY]?.notices).toHaveLength(1)

    manager.handleSettled(KEY)
    expect(manager.getSnapshot().byKey[KEY]).toEqual({ inFlight: false, notices: [], pendingPrompt: undefined })
    // A settled report for a key with no live state is a no-op, not a seed.
    manager.handleSettled(OTHER)
    expect(manager.getSnapshot().byKey[OTHER]).toBeUndefined()
  })

  it('respondPrompt and declinePrompt route the pending rpcId through api.respond with the correlating key', async () => {
    const api = new FakeApiClient()
    const manager = new AuthorizationManager(api)
    manager.handleHostEnvelope({
      rpcId: 'p1' as RpcId,
      payload: { type: 'authorization/prompt-requested', key: KEY, prompt: { kind: 'text', message: 'code?' } },
    })
    await manager.respondPrompt('p1' as RpcId, 'the-code')
    expect(api.callsOf('respond')).toEqual([
      { type: 'client-response', rpcId: 'p1', result: { ok: true, value: { key: KEY, answer: 'the-code' } } },
    ])

    manager.handleHostEnvelope({
      rpcId: 'p2' as RpcId,
      payload: { type: 'authorization/prompt-requested', key: KEY, prompt: { kind: 'select', message: 'pick', options: [] } },
    })
    await manager.declinePrompt('p2' as RpcId)
    expect(api.callsOf('respond')).toEqual([
      { type: 'client-response', rpcId: 'p1', result: { ok: true, value: { key: KEY, answer: 'the-code' } } },
      {
        type: 'client-response', rpcId: 'p2',
        result: { ok: false, error: { code: 'cancelled', message: 'the authorization prompt was declined', details: {} } },
      },
    ])

    // No pending prompt for this rpcId: nothing is sent.
    await manager.respondPrompt('ghost' as RpcId, 'x')
    expect(api.callsOf('respond')).toHaveLength(2)
  })
})

describe('AuthorizationRuntime', () => {
  it('projects the manager snapshot and provides itself as ctx.authorization', async () => {
    const api = new FakeApiClient()
    const ctx = new Context()
    const runtime = new AuthorizationRuntime(ctx, api)
    expect((ctx as unknown as { authorization: AuthorizationRuntime }).authorization).toBe(runtime)
    expect(runtime.list.getSnapshot()).toEqual({ entries: [], state: 'idle', byKey: {} })

    api.onAuthorizationList = () => Promise.resolve(ok({ entries: [entry()] }))
    await runtime.refreshEntries()
    expect(runtime.list.getSnapshot().entries).toEqual([entry()])

    await runtime.begin(KEY, 'oauth')
    expect(runtime.list.getSnapshot().byKey[KEY]?.inFlight).toBe(true)
    runtime.handleHostEnvelope({
      rpcId: 'p1' as RpcId,
      payload: { type: 'authorization/prompt-requested', key: KEY, prompt: { kind: 'text', message: 'code?' } },
    })
    // The manager->runtime projection is Notifier-batched (a microtask
    // flush), unlike the manager's own getSnapshot(), which rebuilds
    // synchronously on read.
    await Promise.resolve()
    expect(runtime.list.getSnapshot().byKey[KEY]?.pendingPrompt?.rpcId).toBe('p1')
    await runtime.respondPrompt('p1' as RpcId, 'x')
    expect(api.callsOf('respond')).toHaveLength(1)
    await runtime.cancel(KEY)
    expect(api.callsOf('authorization.cancel')).toEqual([{ key: KEY }])
    runtime.notifySettled(KEY)
    await Promise.resolve()
    expect(runtime.list.getSnapshot().byKey[KEY]).toEqual({ inFlight: false, notices: [], pendingPrompt: undefined })
    await runtime.declinePrompt('p1' as RpcId)
    expect(api.callsOf('respond')).toHaveLength(1) // no longer pending: no-op
  })
})
