/**
 * Authorization RPC domain over the proxy: `list`/`begin`/`cancel` unary
 * shape, the notice/prompt-requested/prompt-resolved host frames (the
 * prompt-requested frame answerable exactly like approval/question — stable
 * rpcId, replayed on a later host open), `respond` routing an answer or a
 * decline, and `authorization/settled` riding the generic forwarded-event
 * allowlist (`host/remote-event`).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { CredentialProvider, credentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo, CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import AuthorizationService, { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationFlow, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { ApiProxy, HostFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId as mintRpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

const KEY = credentialKey('llm-pi-ai', 'anthropic')

/**
 * In-memory credentials provider exercising only the record half (the
 * seam's whole interest is whether a flow left a record behind).
 * TODO: near-duplicate of packages/credentials/authorization/tests/memory.ts's
 * MemoryCredentials — fold into a shared test-support double if a fourth
 * suite needs one (that file's own TODO already anticipates a third).
 */
class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<CredentialKey, CredentialRecord>()

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.resolve()
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.resolve()
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const stored = this.records.get(key)
    return Promise.resolve(stored === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: stored.kind, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(key)
    const next = await mutate(current)
    if (next === undefined) return current
    this.records.set(key, next)
    this.ctx.emit('credentials/record-updated', key)
    return next
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    if (this.records.delete(key)) this.ctx.emit('credentials/record-updated', key)
    return Promise.resolve()
  }
}

/** A flow that commits `key` through the record store once `run` resolves. */
function committingFlow(
  ctx: Context,
  key: CredentialKey = KEY,
  run?: (session: AuthorizationSession) => Promise<void>,
): AuthorizationFlow {
  return {
    key,
    label: 'Anthropic (Claude Pro/Max)',
    methods: [{ id: 'oauth', label: 'Sign in with Anthropic' }],
    async run(session) {
      await run?.(session)
      await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { token: 'granted' } }))
    },
  }
}

async function harness(): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return { ctx, api }
}

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: mintRpcId(`req-${String(Math.floor(Math.random() * 1e9))}`), payload }
}

/** Open a host stream and capture frames into an array (returns an on-demand waiter). */
function openHost(api: ApiProxy, abort: AbortController): {
  frames: HostFrame[]
  envelopes: RpcRequest<HostFrame>[]
  waitFor(type: HostFrame['type']): Promise<HostFrame>
} {
  const frames: HostFrame[] = []
  const envelopes: RpcRequest<HostFrame>[] = []
  const waiters: { type: HostFrame['type']; resolve: (frame: HostFrame) => void }[] = []
  void (async () => {
    for await (const envelope of api.events.host(request({}), abort.signal)) {
      frames.push(envelope.payload)
      envelopes.push(envelope)
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i] as (typeof waiters)[number]
        if (waiter.type === envelope.payload.type) {
          waiters.splice(i, 1)
          waiter.resolve(envelope.payload)
        }
      }
    }
  })()
  return {
    frames,
    envelopes,
    waitFor: (type) => {
      const found = frames.find(frame => frame.type === type)
      if (found !== undefined) return Promise.resolve(found)
      return new Promise((resolve) => { waiters.push({ type, resolve }) })
    },
  }
}

function requestedOf(frame: HostFrame): Extract<HostFrame, { type: 'authorization/prompt-requested' }> {
  if (frame.type !== 'authorization/prompt-requested') throw new Error(`expected authorization/prompt-requested, got ${frame.type}`)
  return frame
}

describe('authorization RPC domain', () => {
  it('lists every registered flow with its live inFlight bit', async () => {
    const { ctx, api } = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    const listed = await api.authorization.list(request({}))
    expect(listed.result).toEqual({
      ok: true,
      value: {
        entries: [{
          key: KEY, label: 'Anthropic (Claude Pro/Max)', methods: [{ id: 'oauth', label: 'Sign in with Anthropic' }],
          inFlight: false,
        }],
      },
    })
  })

  it('rejects begin for an unregistered key or an unknown method, without starting an attempt', async () => {
    const { ctx, api } = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    const noFlow = await api.authorization.begin(request({ key: credentialKey('llm-pi-ai', 'openai') }))
    expect(noFlow.result.ok).toBe(false)
    if (!noFlow.result.ok) expect(noFlow.result.error.code).toBe('authorization-not-found')
    const badMethod = await api.authorization.begin(request({ key: KEY, method: 'carrier-pigeon' }))
    expect(badMethod.result.ok).toBe(false)
    if (!badMethod.result.ok) expect(badMethod.result.error.code).toBe('authorization-not-found')
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
  })

  it('acks begin immediately, then delivers notice, an answerable prompt, and settlement over the host stream', async () => {
    const { ctx, api } = await harness()
    let capturedSession: AuthorizationSession | undefined
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      capturedSession = session
      session.notify({ message: 'Open this page', url: 'https://claude.ai/oauth/authorize' })
      const answer = await session.prompt({ kind: 'text', message: 'Paste the redirect URL' })
      expect(answer).toBe('https://callback/?code=abc')
    }))
    const abort = new AbortController()
    const host = openHost(api, abort)

    const begun = await api.authorization.begin(request({ key: KEY }))
    expect(begun.result).toEqual({ ok: true, value: { accepted: true } })
    // Rejected synchronously while the first attempt is still running.
    const busy = await api.authorization.begin(request({ key: KEY }))
    expect(busy.result.ok).toBe(false)
    if (!busy.result.ok) expect(busy.result.error.code).toBe('authorization-in-flight')

    const notice = await host.waitFor('authorization/notice')
    expect(notice).toEqual({
      type: 'authorization/notice', key: KEY,
      notice: { message: 'Open this page', url: 'https://claude.ai/oauth/authorize' },
    })
    const requested = requestedOf(await host.waitFor('authorization/prompt-requested'))
    expect(requested.prompt).toEqual({ kind: 'text', message: 'Paste the redirect URL' })
    const envelope = host.envelopes.find(e => e.payload.type === 'authorization/prompt-requested') as RpcRequest<HostFrame>

    const receipt = await api.respond({
      type: 'client-response', rpcId: envelope.rpcId,
      result: { ok: true, value: { key: KEY, answer: 'https://callback/?code=abc' } },
    })
    expect(receipt).toEqual({ accepted: true })

    const resolved = await host.waitFor('authorization/prompt-resolved')
    expect(resolved).toEqual({ type: 'authorization/prompt-resolved', key: KEY, outcome: 'answered' })
    const settled = await host.waitFor('host/remote-event')
    expect(settled).toEqual({ type: 'host/remote-event', event: 'authorization/settled', args: [KEY, 'authorized'] })

    expect(capturedSession).toBeDefined()
    expect((await ctx.credentials.describeRecord(KEY)).configured).toBe(true)
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
    abort.abort()
  })

  it('routes a declined answer to AuthorizationDeclinedError, settling the attempt cancelled', async () => {
    const { ctx, api } = await harness()
    let declinedError: unknown
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      // Unlike the success path, the decline must propagate out of run() —
      // a flow that catches and continues would still commit, same as any
      // other caught rejection; it is the seam's `attempt()`, watching this
      // promise reject with AuthorizationDeclinedError, that turns the whole
      // attempt cancelled rather than failed.
      try {
        await session.prompt({ kind: 'text', message: 'Enter code' })
      } catch (error) {
        declinedError = error
        throw error
      }
    }))
    const abort = new AbortController()
    const host = openHost(api, abort)
    await api.authorization.begin(request({ key: KEY }))
    const requested = requestedOf(await host.waitFor('authorization/prompt-requested'))
    void requested
    const envelope = host.envelopes.find(e => e.payload.type === 'authorization/prompt-requested') as RpcRequest<HostFrame>

    const receipt = await api.respond({
      type: 'client-response', rpcId: envelope.rpcId,
      result: { ok: false, error: { code: 'cancelled', message: 'declined', details: {} } },
    })
    expect(receipt).toEqual({ accepted: true })

    const resolved = await host.waitFor('authorization/prompt-resolved')
    expect(resolved).toEqual({ type: 'authorization/prompt-resolved', key: KEY, outcome: 'declined' })
    const settled = await host.waitFor('host/remote-event')
    expect(settled).toEqual({ type: 'host/remote-event', event: 'authorization/settled', args: [KEY, 'cancelled'] })
    expect(declinedError).toBeInstanceOf(AuthorizationDeclinedError)
    abort.abort()
  })

  it('cancel withdraws the running attempt: settled cancelled, the prompt promise never answered', async () => {
    const { ctx, api } = await harness()
    let promptSettled = false
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      try {
        await session.prompt({ kind: 'text', message: 'Enter code' })
      } finally {
        promptSettled = true
      }
    }))
    const abort = new AbortController()
    const host = openHost(api, abort)
    await api.authorization.begin(request({ key: KEY }))
    await host.waitFor('authorization/prompt-requested')

    const cancelled = await api.authorization.cancel(request({ key: KEY }))
    expect(cancelled.result).toEqual({ ok: true, value: {} })
    // The orphaned run() is abandoned by the seam (nothing awaits it once
    // `withdrawn` wins the race), so its own pending prompt only settles via
    // the RPC handler's own sweep once ctx.authorization.begin() itself
    // returns — after authorization/settled already fired. Wait for the
    // prompt's own resolved frame (pushed in the same synchronous sweep as
    // the reject that flips promptSettled) rather than racing the settled
    // frame's arrival against that sweep.
    const resolved = await host.waitFor('authorization/prompt-resolved')
    expect(resolved).toEqual({ type: 'authorization/prompt-resolved', key: KEY, outcome: 'withdrawn' })
    expect(promptSettled).toBe(true)
    const settled = await host.waitFor('host/remote-event')
    expect(settled).toEqual({ type: 'host/remote-event', event: 'authorization/settled', args: [KEY, 'cancelled'] })
    abort.abort()
  })

  it('replays a still-pending prompt-requested frame (same rpcId) on a later host open', async () => {
    const { ctx, api } = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      await session.prompt({ kind: 'text', message: 'Enter code' })
    }))
    const first = new AbortController()
    const firstHost = openHost(api, first)
    await api.authorization.begin(request({ key: KEY }))
    await firstHost.waitFor('authorization/prompt-requested')
    const firstEnvelope = firstHost.envelopes.find(e => e.payload.type === 'authorization/prompt-requested') as RpcRequest<HostFrame>
    first.abort()

    const second = new AbortController()
    const secondHost = openHost(api, second)
    const replayed = requestedOf(await secondHost.waitFor('authorization/prompt-requested'))
    const secondEnvelope = secondHost.envelopes.find(e => e.payload.type === 'authorization/prompt-requested') as RpcRequest<HostFrame>
    expect(secondEnvelope.rpcId).toBe(firstEnvelope.rpcId)
    expect(replayed.key).toBe(KEY)

    const receipt = await api.respond({
      type: 'client-response', rpcId: secondEnvelope.rpcId,
      result: { ok: true, value: { key: KEY, answer: 'typed-code' } },
    })
    expect(receipt).toEqual({ accepted: true })
    const settled = await secondHost.waitFor('host/remote-event')
    expect(settled).toEqual({ type: 'host/remote-event', event: 'authorization/settled', args: [KEY, 'authorized'] })
    second.abort()
    void ctx
  })

  it('rejects a malformed or mismatched-key answer as bad-response, an unknown rpcId as not-pending', async () => {
    const { ctx, api } = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      await session.prompt({ kind: 'text', message: 'Enter code' })
    }))
    const abort = new AbortController()
    const host = openHost(api, abort)
    await api.authorization.begin(request({ key: KEY }))
    await host.waitFor('authorization/prompt-requested')
    const envelope = host.envelopes.find(e => e.payload.type === 'authorization/prompt-requested') as RpcRequest<HostFrame>

    expect(await api.respond({
      type: 'client-response', rpcId: mintRpcId('ghost'), result: { ok: true, value: { key: KEY, answer: 'x' } },
    })).toEqual({ accepted: false, reason: 'not-pending' })
    expect(await api.respond({
      type: 'client-response', rpcId: envelope.rpcId,
      result: { ok: true, value: { key: credentialKey('llm-pi-ai', 'openai'), answer: 'x' } },
    })).toEqual({ accepted: false, reason: 'bad-response' })
    expect(await api.respond({
      type: 'client-response', rpcId: envelope.rpcId, result: { ok: true, value: { nonsense: 1 } },
    })).toEqual({ accepted: false, reason: 'bad-response' })
    await api.authorization.cancel(request({ key: KEY }))
    abort.abort()
    void ctx
  })

  it('acts as absent-service (authorization-not-found, no attempt) when dsh-authorization is not mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    expect((await api.authorization.list(request({}))).result).toEqual({ ok: true, value: { entries: [] } })
    const begun = await api.authorization.begin(request({ key: KEY }))
    expect(begun.result.ok).toBe(false)
    if (!begun.result.ok) expect(begun.result.error.code).toBe('authorization-not-found')
    // Idempotent no-op, not an error.
    expect((await api.authorization.cancel(request({ key: KEY }))).result).toEqual({ ok: true, value: {} })
  })
})
