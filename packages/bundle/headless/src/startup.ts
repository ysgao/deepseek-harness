/**
 * The one-shot app's command-line provider: it parses the task positional and
 * `--help`, then publishes {@link HEADLESS_STARTUP_SERVICE}. The runner is an
 * ordinary consumer whose lazy config waits for that service.
 * @module @deepseek-ai/dsh-headless/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'

/** Stable Cordis plugin name. */
export const name = 'headless-startup'

/** Services required before the task or login request can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the one-shot runner. */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/**
 * What the runner row reads from {@link HEADLESS_STARTUP_SERVICE}: either a
 * one-shot task, or a request to authorize a credential through its
 * registered `ctx.authorization` flow.
 */
export type HeadlessStartupValues =
  | { mode: 'task'; task: string }
  | { mode: 'login'; key: CredentialKey; method?: string }

/**
 * This app's command: the task positional, the `login` subcommand, their
 * descriptions, and their help text.
 * @param ctx - plugin context the resolved action publishes the startup value to.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function headlessCommand(ctx: Context): Command {
  const program = new Command()
    .name('dsh --profile headless')
    .description('Answer one task, print the final assistant message, and exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    .addHelpText('after', `
Examples:
  dsh --profile headless "run the tests"                answer one task and exit
  dsh --profile headless login llm-pi-ai/anthropic       authorize a credential and exit
`)
  program.action(() => {
    const task = program.args.join(' ')
    if (task.trim() === '') program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
    ctx.provide(HEADLESS_STARTUP_SERVICE, { mode: 'task', task } satisfies HeadlessStartupValues)
  })

  const login = program.command('login')
    .description('authorize a credential through its registered flow, then exit')
    .argument('<key>', 'the credential key to authorize, e.g. llm-pi-ai/anthropic')
    .option('--method <id>', 'which of the flow\'s methods to run (defaults to its first)')
  login.action((rawKey: string, options: { method?: string }) => {
    let key: CredentialKey
    try {
      key = parseCredentialKey(rawKey)
    } catch {
      login.error(`error: "${rawKey}" is not a valid credential key; expected "<scope>/<id>", for example: llm-pi-ai/anthropic`)
      return
    }
    ctx.provide(HEADLESS_STARTUP_SERVICE, {
      mode: 'login',
      key,
      ...options.method === undefined ? {} : { method: options.method },
    } satisfies HeadlessStartupValues)
  })

  return program
}

/**
 * Parse the invocation and provide its resolved intent as an ordinary Cordis
 * service. The command's action publishes it; a missing or whitespace-only
 * task, or a malformed credential key, is a usage error, so on rejection (and
 * on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  parseCmdline(ctx, headlessCommand(ctx))
}
