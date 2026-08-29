/** Direct one-shot Agent driving, durable aggregation, flushing, and exit mapping. */

import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationFlow } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { apply, Config, internals } from '../src/index.ts'

const originalInternals = { ...internals }
afterEach(() => { Object.assign(internals, originalInternals) })

interface Script {
  before?(session: Session): void
  afterPrompt(session: Session, message: UserMessage): Promise<void> | void
}

function appendTurn(
  session: Session,
  turn: number,
  message: UserMessage,
  text: string | undefined,
  completed: boolean,
): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  if (text !== undefined) {
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', {
    turn,
    reason: completed
      ? { kind: 'completed' }
      : { kind: 'aborted', reason: { kind: 'user' } },
  })
}

/** Mount the real registries around a small scripted Agent factory. */
async function bench(script: Script): Promise<{
  ctx: Context
  output(): { out: string; err: string; order: string[] }
  run(): Promise<{ code: number; out: string; err: string; order: string[] }>
}> {
  const ctx = new Context()
  let out = ''
  let err = ''
  const order: string[] = []
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      let idle = Promise.resolve()
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, {
        id: session.id,
        options: options.agentOptions ?? {},
        session,
        inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
        status: 'idle',
        ctx: agentCtx,
        cancel: () => {},
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (message: UserMessage) => {
          agent.inbox.append('next-turn', message)
          idle = Promise.resolve().then(() => script.afterPrompt(session, message))
        },
        steer: () => {},
        inject: () => {},
        whenIdle: () => idle,
      } satisfies Partial<Agent>)
      await options.setup?.(agentCtx)
      script.before?.(session)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('not used')),
  })
  return {
    ctx,
    output: () => ({ out, err, order: [...order] }),
    run: async () => {
      ctx.on('session/flush', () => { order.push('flush') })
      internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
      internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
      const exited = new Promise<number>((resolve) => {
        ctx.provide('appExit', (code: number) => { order.push('exit'); resolve(code) })
      })
      apply(ctx, { mode: 'task', task: 'do the thing' })
      return { code: await exited, out, err, order }
    },
  }
}

describe('headless runner', () => {
  it('aggregates the final text across the complete idle-to-idle interval and flushes before exit', async () => {
    const test = await bench({
      before(session) {
        const setupMessage = {
          role: 'user', content: [{ type: 'text', text: 'setup' }], source: { kind: 'user' }, id: 'setup',
        } as UserMessage
        appendTurn(session, 0, setupMessage, 'pre-task noise', true)
      },
      async afterPrompt(session, message) {
        await Promise.resolve()
        appendTurn(session, 1, message, '', true)
        appendTurn(session, 2, message, 'final answer', true)
      },
    })
    const result = await test.run()
    expect(result).toEqual({
      code: 0,
      out: 'final answer\n',
      err: '',
      order: ['flush', 'exit'],
    })
    await test.ctx.fiber.dispose()
  })

  it('waits for asynchronously appended events instead of racing Agent idleness', async () => {
    const test = await bench({
      afterPrompt: async (session, message) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        appendTurn(session, 1, message, 'race-free answer', true)
      },
    })
    expect(await test.run()).toMatchObject({ code: 0, out: 'race-free answer\n', err: '' })
    await test.ctx.fiber.dispose()
  })

  it('streams reasoning before the Agent becomes idle and terminates its stderr line', async () => {
    const reasoningAppended = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const test = await bench({
      async afterPrompt(session, message) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
        })
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'reasoning-delta', index: 0, text: '' },
        })
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'reasoning-delta', index: 0, text: 'checking the workspace' },
        })
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'reasoning-delta', index: 0, text: ' safely\n' },
        })
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'checking the workspace safely\n' } },
        })
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 2 } },
        })
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'block-start', index: 1, blockType: 'reasoning' },
        })
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'reasoning-delta', index: 1, text: 'second pass\n' },
        })
        reasoningAppended.resolve(undefined)
        await release.promise
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'block-start', index: 2, blockType: 'text' },
        })
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 2, text: 'done' },
        })
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'block-end', index: 2, block: { type: 'text', text: 'done' } },
        })
        session.append('assistant/message', {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'done' }],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    })
    const running = test.run()
    await reasoningAppended.promise
    const other = test.ctx.sessions.create()
    other.append('turn/start', { turn: 1 })
    other.append('step/start', { turn: 1, step: 1 })
    other.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: 'other session' },
    })
    const streamed = test.output()
    release.resolve(undefined)
    const result = await running
    expect(streamed).toEqual({
      out: '',
      err: 'dsh: reasoning:\nchecking the workspace safely\nsecond pass\n',
      order: [],
    })
    expect(result).toEqual({
      code: 0,
      out: 'done\n',
      err: 'dsh: reasoning:\nchecking the workspace safely\nsecond pass\n',
      order: ['flush', 'exit'],
    })
    await test.ctx.fiber.dispose()
  })

  it('exits 1 when the final turn does not complete', async () => {
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, undefined, false) },
    })
    expect(await test.run()).toMatchObject({ code: 1, out: '\n', err: '' })
    await test.ctx.fiber.dispose()
  })

  it('prints the durable model failure when the final turn ends in error', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', {
          turn: 1,
          reason: { kind: 'error', error: { code: 'SERVER', message: 'provider unavailable' } },
        })
      },
    })
    expect(await test.run()).toMatchObject({
      code: 1,
      out: '\n',
      err: 'dsh: SERVER: provider unavailable\n',
    })
    await test.ctx.fiber.dispose()
  })

  it('separates an unterminated reasoning prefix from the terminal model failure', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'reasoning-delta', index: 0, text: 'trying recovery' },
        })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', {
          turn: 1,
          reason: { kind: 'error', error: { code: 'SERVER', message: 'provider unavailable' } },
        })
      },
    })
    expect(await test.run()).toMatchObject({
      code: 1,
      out: '\n',
      err: 'dsh: reasoning:\ntrying recovery\ndsh: SERVER: provider unavailable\n',
    })
    await test.ctx.fiber.dispose()
  })

  it('exits 1 when the owned interval contains no turn', async () => {
    const test = await bench({ afterPrompt: () => {} })
    expect(await test.run()).toMatchObject({ code: 1, out: '\n', err: '' })
    await test.ctx.fiber.dispose()
  })

  it('reports a direct Agent creation failure', async () => {
    const ctx = new Context()
    let err = ''
    internals.stdout = { write: () => true }
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agents', { create: () => Promise.reject(new Error('factory exploded')) } as never)
    apply(ctx, { mode: 'task', task: 't' })
    expect(await exited).toBe(1)
    expect(err).toBe('dsh: factory exploded\n')
    await ctx.fiber.dispose()
  })

  it('stringifies a non-Error Agent creation failure', async () => {
    const ctx = new Context()
    let err = ''
    internals.stdout = { write: () => true }
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    const rejected = {
      then(_resolve: (value: never) => void, reject: (reason: unknown) => void): void {
        reject('factory exploded')
      },
    }
    ctx.provide('agents', { create: () => rejected } as never)
    apply(ctx, { mode: 'task', task: 't' })
    expect(await exited).toBe(1)
    expect(err).toBe('dsh: factory exploded\n')
    await ctx.fiber.dispose()
  })

  it('abandons a run when the tree is disposed during Loader settlement', async () => {
    const ctx = new Context()
    let exited = false
    internals.stdout = { write: () => true }
    internals.stderr = { write: () => true }
    ctx.provide('appExit', () => { exited = true })
    const services = ctx.plugin((child: Context) => {
      child.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
      child.provide('sessions', {} as never)
      child.provide('agents', {} as never)
    })
    await services
    let release: () => void
    const settlement = new Promise<void>((resolve) => { release = resolve })
    ctx.provide('loader', { await: () => settlement } as never)
    apply(ctx, { mode: 'task', task: 't' })
    await services.dispose()
    release!()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(exited).toBe(false)
    await ctx.fiber.dispose()
  })

  it('fails loud without the launcher-provided exit request', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, { mode: 'task', task: 't' }) }).toThrow('must provide ctx.appExit')
  })

  it('validates config: mode is required', () => {
    expect(() => new Config({} as never)).toThrow()
    expect(new Config({ mode: 'task', task: 'x' })).toEqual({ mode: 'task', task: 'x' })
    expect(new Config({ mode: 'login', key: 'llm-pi-ai/anthropic' })).toEqual({ mode: 'login', key: 'llm-pi-ai/anthropic' })
  })

  it('fails loud when task mode config carries no task', () => {
    const ctx = new Context()
    ctx.provide('appExit', () => {})
    expect(() => { apply(ctx, { mode: 'task' }) }).toThrow('task mode requires "task"')
  })

  it('fails loud when login mode config carries no key', () => {
    const ctx = new Context()
    ctx.provide('appExit', () => {})
    expect(() => { apply(ctx, { mode: 'login' }) }).toThrow('login mode requires "key"')
  })
})

describe('headless login', () => {
  const KEY = 'test-flow/demo' as CredentialKey

  /** A minimal in-memory `ctx.credentials` stand-in: only the record half the seam reads. */
  function fakeCredentials(ctx: Context): void {
    const records = new Map<CredentialKey, CredentialRecord>()
    type Mutate = (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>
    ctx.provide('credentials', {
      modifyRecord: async (key: CredentialKey, mutate: Mutate) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) {
          records.set(key, next)
          ctx.emit('credentials/record-updated', key)
        }
        return next
      },
      describeRecord: async (key: CredentialKey) => {
        const stored = records.get(key)
        return stored === undefined
          ? { configured: false, writable: true }
          : { configured: true, kind: stored.kind, writable: true }
      },
      readRecord: async (key: CredentialKey) => records.get(key),
    } as never)
  }

  /**
   * Mount the real authorization seam over the fake credential store, plus a
   * test-only flow built from the mounted `ctx` (so it can commit through
   * `ctx.credentials` itself, like a real flow does).
   */
  async function loginBench(buildFlow: (ctx: Context) => AuthorizationFlow): Promise<{
    ctx: Context
    stdin: PassThrough
    run(key?: string, method?: string): Promise<{ code: number; out: string; err: string }>
  }> {
    const ctx = new Context()
    fakeCredentials(ctx)
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow(buildFlow(ctx))
    const stdin = new PassThrough()
    internals.stdin = stdin
    return {
      ctx,
      stdin,
      run: async (key = KEY, method?: string) => {
        let out = ''
        let err = ''
        internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
        internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
        const exited = new Promise<number>((resolve) => {
          ctx.provide('appExit', (code: number) => { resolve(code) })
        })
        apply(ctx, { mode: 'login', key, ...method === undefined ? {} : { method } })
        const code = await exited
        return { code, out, err }
      },
    }
  }

  /** A flow that notifies once, prompts once, and commits whatever it read as the answer. */
  function committingFlow(ctx: Context): AuthorizationFlow {
    return {
      key: KEY,
      label: 'Test Flow',
      methods: [{ id: 'oauth', label: 'Sign in' }, { id: 'api-key', label: 'Paste a key' }],
      async run(session) {
        session.notify({ message: 'Continue in your browser', url: 'https://example.test/authorize', code: 'ABCD' })
        const answer = await session.prompt({ kind: 'text', message: 'Paste the code' })
        await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { token: answer } }))
      },
    }
  }

  /** A flow whose notice carries no url or code, only a message. */
  function bareNoticeFlow(ctx: Context): AuthorizationFlow {
    return {
      key: KEY,
      label: 'Test Flow',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        session.notify({ message: 'just a message' })
        const answer = await session.prompt({ kind: 'text', message: 'Paste the code' })
        await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { token: answer } }))
      },
    }
  }

  /** A flow that asks the human to pick one of two options, one of them described. */
  function selectFlow(ctx: Context): AuthorizationFlow {
    return {
      key: KEY,
      label: 'Test Flow',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        const chosen = await session.prompt({
          kind: 'select',
          message: 'Pick one',
          options: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B', description: 'the better one' }],
        })
        await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { token: chosen } }))
      },
    }
  }

  /** A flow whose text prompt carries a placeholder and its own (never-firing) signal. */
  function placeholderFlow(ctx: Context): AuthorizationFlow {
    return {
      key: KEY,
      label: 'Test Flow',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        const answer = await session.prompt({
          kind: 'text',
          message: 'Paste the code',
          placeholder: 'e.g. abc123',
          signal: new AbortController().signal,
        })
        await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { token: answer } }))
      },
    }
  }

  it('authorizes a flow that commits its record, prints its notice, and exits 0', async () => {
    const test = await loginBench(committingFlow)
    test.stdin.write('pasted-code\n')
    const result = await test.run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('Continue in your browser')
    expect(result.out).toContain('https://example.test/authorize')
    expect(result.out).toContain('Code: ABCD')
    expect(result.out).toContain('Signed in for "test-flow/demo"')
    await expect(test.ctx.credentials.describeRecord(KEY)).resolves.toMatchObject({ configured: true })
    await test.ctx.fiber.dispose()
  })

  it('declines on an empty answer, prints nothing committed, and exits 1', async () => {
    const test = await loginBench(committingFlow)
    test.stdin.write('\n')
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('was declined')
    await expect(test.ctx.credentials.describeRecord(KEY)).resolves.toMatchObject({ configured: false })
    await test.ctx.fiber.dispose()
  })

  it('fails loud on an unregistered key', async () => {
    const test = await loginBench(committingFlow)
    const result = await test.run('test-flow/no-such-key')
    expect(result.code).toBe(1)
    expect(result.err).toContain('no authorization flow is registered')
    await test.ctx.fiber.dispose()
  })

  it('runs the named method when --method is given', async () => {
    const test = await loginBench(committingFlow)
    test.stdin.write('pasted-code\n')
    const result = await test.run(KEY, 'api-key')
    expect(result.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('prints only the message when a notice carries no url or code', async () => {
    const test = await loginBench(bareNoticeFlow)
    test.stdin.write('pasted-code\n')
    const result = await test.run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('just a message\n')
    expect(result.out).not.toContain('  https://')
    expect(result.out).not.toContain('Code:')
    await test.ctx.fiber.dispose()
  })

  it('answers a select prompt by its numbered option and commits the chosen id', async () => {
    const test = await loginBench(selectFlow)
    test.stdin.write('2\n')
    const result = await test.run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('1. Option A')
    expect(result.out).toContain('2. Option B')
    await expect(test.ctx.credentials.readRecord(KEY)).resolves.toEqual({ kind: 'grant', payload: { token: 'b' } })
    await test.ctx.fiber.dispose()
  })

  it('declines a select prompt answered with an out-of-range option', async () => {
    const test = await loginBench(selectFlow)
    test.stdin.write('9\n')
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('was declined')
    await test.ctx.fiber.dispose()
  })

  it('renders a text prompt placeholder and answers it under its own signal', async () => {
    const test = await loginBench(placeholderFlow)
    test.stdin.write('pasted-code\n')
    const result = await test.run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('(e.g. abc123)')
    await test.ctx.fiber.dispose()
  })

  it('abandons a login when authorization is unavailable', async () => {
    const ctx = new Context()
    let exited = false
    internals.stdin = new PassThrough()
    internals.stdout = { write: () => true }
    internals.stderr = { write: () => true }
    ctx.provide('appExit', () => { exited = true })
    apply(ctx, { mode: 'login', key: KEY })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(exited).toBe(false)
    await ctx.fiber.dispose()
  })
})
