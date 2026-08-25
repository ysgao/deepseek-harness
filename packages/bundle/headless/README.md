# `@deepseek-ai/dsh-headless`

English | [中文](README.zh.md)

The dsh one-shot bundle. [`cordis.patch.yml`](cordis.patch.yml) rides directly over [`dsh-base`](../base/README.md): it supplies the coding persona and tool mode, disables HMR, mounts Code Mode's worker as a core execution capability, and inserts this package's `headless-runner` plugin (config `{mode, task?, key?, method?}`, resolved from the injected `headlessStartup` provider). It mounts no Host, HTTP server, Web runtime, or browser plugin.

`dsh --profile headless "<task>"` runs one task. After the Loader settles, the runner reads the shared [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md), creates one fresh persisted Agent through `ctx.agents`, submits the task as an ordinary user message, and waits for quiescence. It flushes the Session before folding the owned durable event interval, writes the last non-empty assistant text to stdout, and requests exit through the launcher-provided `ctx.appExit` host hook ([`dsh-cmdline`](../../boot/cmdline/README.md)) (final `turn/end` completed → 0, otherwise 1). A terminal `error` reason also writes its code and message to stderr; successful runs keep stderr empty. The process opens no listening port. The task text is this app's command line: the ordinary `headless-startup` provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)), reads the positional argument of `dsh --profile headless "task"`, prints the app's `--help`, and provides `headlessStartup`; the runner injects that service and reads its task from lazy config. A missing or whitespace-only task is rejected before the runner activates.

`dsh --profile headless login <key> [--method <id>]` authorizes a credential instead of running a task — `<key>` is a `<scope>/<id>` [`ctx.credentials`](../../credentials/credentials/README.md) key naming a flow registered on [`ctx.authorization`](../../credentials/authorization/README.md), for example `llm-pi-ai/anthropic` (Claude Pro/Max subscription sign-in, registered by [`dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.md) for every installed pi-ai catalog provider). The runner renders the flow's notices and prompts on the terminal: each notice's message prints to stdout, followed by its `url` and `code` on their own lines when present; each prompt's message prints and one line is read from stdin, an empty answer reading as the human declining. It requests exit 0 once the flow's credential record is committed, exit 1 when the human declines or the flow fails. Signing in makes the credential available; it does not by itself add a route for it — a dormant adapter such as `llm-pi-ai` still needs its own settings section configured (the web Models page, or `$DSH_HOME/settings.yaml`) before a model on that route is selectable.

## Model Experience

None, as the runner submits the task as an ordinary user message; prompts and tools belong to the base and headless bundle rows.

#### KV Cache effect

None; the runner adds nothing to the request prefix.

## Known Limitations and Deferred Work

- **One submitted task only** — the runner has no interactive follow-up surface; it waits through any work the Agent completes before returning to idle and prints the last non-empty assistant message in that interval.
- **`ctx.appExit` is launcher-owned** — booting the headless profile outside the `dsh` launcher fails loud at activation until the host provides the exit request.
- **`login`'s terminal prompt has no secret masking** — a flow's `secret`-kind prompt (a typed API key, for instance) reads and echoes the line like any other; it is suitable for pasted codes and authorization URLs, not for a value that must stay off the terminal scrollback.
- **`login` never writes the authorized route's own configuration** — it commits the credential record only; making a dormant adapter's route live (`providers.<id>` under its settings section) stays a separate, explicit step.
