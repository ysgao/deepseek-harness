/**
 * Real-composition coverage of `AuthorizationController` (the `ctx.remote.authorization`
 * namespace owner): `list`/`begin`/`respond`/`cancel` against a real
 * `AuthorizationService` and registered flows, the shared `follow()` stream's
 * baseline-then-notice/prompt frames across two connected generations, a
 * declined prompt settling `begin()` as `cancelled`, and `begin`'s mapping
 * from `AuthorizationError`/an arbitrary thrown value to the wire's
 * `authorization-not-found`/`authorization-in-flight`/`authorization-rejected`/
 * `internal` failure codes.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import AuthorizationService, {
  type AuthorizationFlow, type AuthorizationSession,
} from '@deepseek-ai/dsh-authorization'
import AuthorizationController from '../src/authorization.ts'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')

async function harness(): Promise<{ ctx: Context; controller: AuthorizationController }> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  const controller = new AuthorizationController(ctx)
  return { ctx, controller }
}

/** A flow that commits `key` through the record store and then resolves. */
function committingFlow(ctx: Context, key = KEY, run?: (session: AuthorizationSession) => Promise<void>): AuthorizationFlow {
  return {
    key,
    label: 'ChatGPT (Codex)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }],
    async run(session) {
      await run?.(session)
      await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { token: 'granted' } }))
    },
  }
}

async function collect<T>(iterable: AsyncIterable<T>, count: number): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) {
    out.push(item)
    if (out.length === count) return out
  }
  return out
}

describe('AuthorizationController', () => {
  it('lists every registered flow', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    expect(controller.list()).toEqual([
      { key: KEY, label: 'ChatGPT (Codex)', methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }], inFlight: false },
    ])
  })

  it('runs a flow to a committed outcome and reports it authorized', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    await expect(controller.begin(KEY, undefined, new AbortController().signal))
      .resolves.toMatchObject({ status: 'authorized' })
  })

  it('carries a notice and a prompt/response round trip over the shared follow stream', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      session.notify({ message: 'starting' })
      const answer = await session.prompt({ kind: 'text', message: 'code?' })
      expect(answer).toBe('typed by a page')
    }))

    const abort = new AbortController()
    const frames = collect(controller.follow(abort.signal), 3)
    const begun = controller.begin(KEY, undefined, new AbortController().signal)
    // Let the flow reach its prompt before answering it.
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.respond(KEY, 'typed by a page')

    await expect(begun).resolves.toMatchObject({ status: 'authorized' })
    expect(await frames).toEqual([
      { type: 'notice', key: KEY, notice: { message: 'starting' } },
      { type: 'prompt-requested', key: KEY, prompt: { kind: 'text', message: 'code?' } },
      { type: 'prompt-resolved', key: KEY },
    ])
    abort.abort()
  })

  it('replays every still-pending prompt as a late follower\'s baseline', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session => session.prompt({ kind: 'text', message: 'code?' }).then(() => {})))
    const begun = controller.begin(KEY, undefined, new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 0))

    const abort = new AbortController()
    const baseline = await collect(controller.follow(abort.signal), 1)
    expect(baseline).toEqual([{ type: 'prompt-requested', key: KEY, prompt: { kind: 'text', message: 'code?' } }])
    abort.abort()

    controller.respond(KEY, 'typed')
    await expect(begun).resolves.toMatchObject({ status: 'authorized' })
  })

  it('rejects respond() for a key with no pending prompt', async () => {
    const { controller } = await harness()
    let thrown: unknown
    try {
      controller.respond(KEY, 'anything')
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toMatchObject({ failure: { code: 'authorization-not-found' } })
  })

  it('withdraws a running attempt through cancel()', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session => new Promise((_resolve, reject) => {
      session.signal.addEventListener('abort', () => { reject(new Error('withdrawn')) })
    })))
    const begun = controller.begin(KEY, undefined, new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.cancel(KEY)
    await expect(begun).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('maps begin() failures to the wire\'s authorization- failure codes', async () => {
    const { ctx, controller } = await harness()

    await expect(controller.begin(KEY, undefined, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'authorization-not-found' } })

    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => new Promise(() => {})))
    void controller.begin(KEY, undefined, new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(controller.begin(KEY, undefined, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'authorization-in-flight' } })
    controller.cancel(KEY)
  })

  it('settles begin() as cancelled when the human declines a prompt', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session => session.prompt({ kind: 'text', message: 'code?' }).then(() => {})))
    const begun = controller.begin(KEY, undefined, new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.respond(KEY, undefined)
    await expect(begun).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('maps a flow that never commits a record to authorization-rejected', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Forgetful',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: () => Promise.resolve(),
    })
    await expect(controller.begin(KEY, undefined, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'authorization-rejected' } })
  })

  it('maps an arbitrary thrown flow failure to internal', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => Promise.reject(new Error('the token endpoint said no'))))
    await expect(controller.begin(KEY, undefined, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'internal', message: 'the token endpoint said no' } })
  })

  it('stringifies a non-Error thrown flow failure for the internal message', async () => {
    const { ctx, controller } = await harness()
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the scenario under test.
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => Promise.reject('token endpoint offline')))
    await expect(controller.begin(KEY, undefined, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'internal', message: 'token endpoint offline' } })
  })

  it('runs the flow\'s chosen method when begin() is given one', async () => {
    const { ctx, controller } = await harness()
    let seenMethod: string | undefined
    ctx.authorization.registerFlow({
      ...committingFlow(ctx),
      run: async (session) => {
        seenMethod = session.method
        await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { token: 'granted' } }))
      },
    })
    await expect(controller.begin(KEY, 'api-key', new AbortController().signal))
      .resolves.toMatchObject({ status: 'authorized' })
    expect(seenMethod).toBe('api-key')
  })

  it('fails begin() when a flow prompts the same key twice before either resolves', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session => Promise.allSettled([
      session.prompt({ kind: 'text', message: 'first?' }),
      session.prompt({ kind: 'text', message: 'second?' }),
    ]).then(() => {})))
    await expect(controller.begin(KEY, undefined, new AbortController().signal))
      .rejects.toMatchObject({ failure: { message: expect.stringContaining('already pending') as string } })
  })
})
