/**
 * @deepseek-ai/dsh-headless — one-shot direct Agent driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates one Agent through the core registry, drives the task to quiescence,
 * streams provider reasoning to stderr, flushes its Session, prints the final
 * assistant text to stdout, and exits.
 *
 * @module @deepseek-ai/dsh-headless
 */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { AuthorizationInteraction } from '@deepseek-ai/dsh-authorization'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { assertNever, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'headless-runner'

/** Core and authorization services required before either mode can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'authorization']

/**
 * Plugin config, resolved from this app's injected startup service: either a
 * one-shot task, or a credential key to authorize. `task`/`key` are each
 * required only by their own mode — schemastery validates the flat shape;
 * {@link apply} enforces the per-mode requirement its caller cannot violate
 * (`headless-startup` is this config's sole writer).
 */
export interface Config {
  /** Which startup request this run resolves. */
  mode: 'task' | 'login'
  /** The prompt text for the single run, in task mode. */
  task?: string
  /** The credential key to authorize, in login mode. */
  key?: string
  /** Which of the flow's methods to run, in login mode. */
  method?: string
}

export const Config: z<Config> = z.object({
  mode: z.union(['task', 'login']).required(),
  task: z.string(),
  key: z.string(),
  method: z.string(),
})

/** Outcome of one owned run interval. */
interface RunOutcome {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
}

/** Process-facing effects of one run: output streams plus the launcher's bounded exit request. */
interface HeadlessIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** {@link HeadlessIo} plus the input stream login mode reads prompts from. */
interface LoginIo extends HeadlessIo {
  stdin: NodeJS.ReadableStream
}

/** The process streams the runner reads and writes; tests substitute captures. */
export const internals: { stdin: LoginIo['stdin']; stdout: HeadlessIo['stdout']; stderr: HeadlessIo['stderr'] } = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(events: readonly SessionEvent[], firstSeq: number): RunOutcome {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/**
 * Project provider-reported reasoning from one owned run to stderr as it is
 * appended, while keeping final outcome derivation on the durable log.
 * @param ctx - plugin context carrying the Session event feed.
 * @param agent - the exact Agent whose reasoning belongs to this invocation.
 * @param stderr - progress output sink.
 * @returns a disposer that also terminates an unterminated reasoning line.
 */
function streamReasoning(
  ctx: Context,
  agent: Agent,
  stderr: HeadlessIo['stderr'],
): () => void {
  let started = false
  let open = false
  let endsWithNewline = true
  const close = (): void => {
    if (!open) return
    if (!endsWithNewline) stderr.write('\n')
    open = false
    endsWithNewline = true
  }
  const dispose = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'turn/start') {
      close()
      started = true
      return
    }
    if (!started || event.type !== 'assistant/chunk') return
    const chunk = event.data.chunk
    switch (chunk.type) {
      case 'reasoning-delta':
        if (chunk.text === '') return
        if (!open) {
          stderr.write('dsh: reasoning:\n')
          open = true
        }
        stderr.write(chunk.text)
        endsWithNewline = chunk.text.endsWith('\n')
        return
      case 'block-start':
        if (chunk.blockType !== 'reasoning') close()
        return
      case 'block-end':
        if (chunk.block.type !== 'reasoning') close()
        return
      case 'usage':
        return
      case 'text-delta':
      case 'tool-call-delta':
      case 'finish':
        close()
        return
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(chunk, 'headless reasoning stream')
    }
  })
  return () => {
    dispose()
    close()
  }
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: HeadlessIo, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Run one task through a freshly created Agent and request process exit.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param task - one-shot task text.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, task: string, io: HeadlessIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  // This bundle composes no preset roster, so the model-facing rows sit in the
  // host plane and the agent reads them from the global layer. A deployment
  // that DOES configure one has to join it here first
  // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  const stopReasoning = streamReasoning(ctx, agent, io.stderr)
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: task }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
  } finally {
    stopReasoning()
  }
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session.events, firstSeq)
  io.stdout.write(outcome.text + '\n')
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

/**
 * Build the terminal half of one authorization attempt: notices print to
 * stdout, and each prompt reads one line from stdin. An empty answer reads as
 * the human declining, mirroring a closed browser tab; a prompt's own
 * `signal` firing (a flow retiring the losing side of a race) is left to
 * reject on its own, since that is not a decline.
 * @param io - the streams to render notices to and read answers from.
 * @returns the interaction {@link runLogin} hands to `ctx.authorization.begin()`.
 */
function buildTerminalInteraction(io: LoginIo): AuthorizationInteraction {
  return {
    notify(notice) {
      io.stdout.write(`${notice.message}\n`)
      if (notice.url !== undefined) io.stdout.write(`  ${notice.url}\n`)
      if (notice.code !== undefined) io.stdout.write(`  Code: ${notice.code}\n`)
    },
    async prompt(prompt) {
      // No `output` given: this module renders every line itself through
      // `io.stdout`, so the interface never touches the real process streams
      // when a test substitutes captures. `readline.createInterface` would
      // otherwise default `output` to the actual `process.stdout`.
      const question = prompt.kind === 'select'
        ? `${prompt.message}\n${prompt.options.map((option, index) =>
          `  ${index + 1}. ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`).join('\n')}\n> `
        : `${prompt.message}${prompt.placeholder === undefined ? '' : ` (${prompt.placeholder})`} `
      io.stdout.write(question)
      const rl = createInterface({ input: io.stdin })
      try {
        // readline's 'line' event always carries exactly one string argument.
        const [answer] = await once(rl, 'line', prompt.signal === undefined ? {} : { signal: prompt.signal }) as [string]
        if (answer.trim() === '') throw new AuthorizationDeclinedError()
        if (prompt.kind !== 'select') return answer
        const chosen = prompt.options[Number.parseInt(answer, 10) - 1]
        if (chosen === undefined) throw new AuthorizationDeclinedError(`"${answer}" is not one of the offered options`)
        return chosen.id
      } finally {
        rl.close()
      }
    },
  }
}

/**
 * Run one credential authorization through its registered flow, over a
 * terminal interaction, and request process exit.
 * @param ctx - plugin context carrying `ctx.authorization` and launcher IO services.
 * @param key - the credential key to authorize.
 * @param method - which of the flow's methods to run; `undefined` defers to its first.
 * @param io - process-facing effects.
 */
async function runLogin(ctx: Context, key: CredentialKey, method: string | undefined, io: LoginIo): Promise<void> {
  await ctx.get('loader')?.await()
  const authorization = ctx.get('authorization')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (authorization === undefined) return
  const outcome = await authorization.begin({
    key,
    interaction: buildTerminalInteraction(io),
    ...method === undefined ? {} : { method },
  })
  if (outcome.status === 'cancelled') {
    io.stderr.write(`dsh: sign-in for "${key}" was declined\n`)
    io.exit(1)
    return
  }
  io.stdout.write(`Signed in for "${key}".\n`)
  io.stdout.write('If its route is not already configured, add it under the owning adapter\'s settings section (for example, `providers.anthropic: {}` under `llm-pi-ai:` in $DSH_HOME/settings.yaml, or the web Models page) to make it selectable.\n')
  io.exit(0)
}

/**
 * Mount the one-shot direct driver: a task run, or a credential sign-in.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated task or login config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('headless-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: LoginIo = { stdin: internals.stdin, stdout: internals.stdout, stderr: internals.stderr, exit }
  if (config.mode === 'task') {
    // headless-startup is this config's sole writer and always pairs mode
    // 'task' with a task string; a missing one here is an internal invariant
    // violation, not a usage error a human caused.
    if (config.task === undefined) throw new Error('headless-runner: task mode requires "task"')
    void run(ctx, config.task, io).catch((error: unknown) => { fail(io, error) })
    return
  }
  if (config.key === undefined) throw new Error('headless-runner: login mode requires "key"')
  void runLogin(ctx, parseCredentialKey(config.key), config.method, io).catch((error: unknown) => { fail(io, error) })
}
