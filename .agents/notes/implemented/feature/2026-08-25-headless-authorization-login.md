# Agent Note: `dsh --profile headless login` — a terminal caller for `ctx.authorization`

Status: implemented

English | [中文](2026-08-25-headless-authorization-login.zh.md)

## Problem

`dsh-authorization` (`ctx.authorization`) and the OAuth flows `dsh-llm-pi-ai` registers per installed pi-ai catalog provider (`registerPiAiFlows`, keyed `llm-pi-ai/<providerId>`) already existed, but nothing in the repository mounted the seam or ever called `begin()` outside that package's own tests. A human with a Claude Pro/Max (or any other pi-ai OAuth) subscription had no way to authenticate a dsh model route to it: the only working path was `ANTHROPIC_API_KEY` metered billing, or shelling out to a real Claude Code CLI as a subagent (a different mechanism serving a different purpose). The backend for subscription sign-in was fully implemented and entirely unreachable.

## Decision

**Mount `dsh-authorization` in the base bundle**, next to `credentials`/`settings` (`packages/bundle/base/cordis.patch.yml`). It is dormant until a caller invokes `begin()`, so this alone changes nothing observable — it only lets `dsh-llm-pi-ai`'s existing scoped `ctx.inject(['authorization'], ...)` fire and register its flows in every profile.

**`dsh --profile headless` is the caller**, not a new package or a Web UI surface. It is already the one-shot, no-Host/no-webserver/no-browser CLI surface with its own commander parsing (`packages/bundle/headless/src/startup.ts`); pi-ai's Anthropic OAuth flow itself opens a local HTTP callback server and/or accepts a manually pasted code — a terminal-native shape, not a browser-hosted one. `headless-startup`'s `[task...]` root action and its new `login <key> [--method <id>]` subcommand both publish `HeadlessStartupValues`, now a discriminated union (`{mode: 'task', task} | {mode: 'login', key: CredentialKey, method?}`); `<key>` is parsed with `dsh-credentials`' `parseCredentialKey` at parse time, so a malformed key is a usage error, not a runtime one.

**One plugin, one row, branching on `config.mode`** (`packages/bundle/headless/src/index.ts`), not two rows with one disabled via a dynamic `!!js` expression keyed on a sibling's injected service value — that pattern has no precedent in this repository and its Loader-evaluation-order guarantees are unverified, while branching inside one `apply()` mirrors the shape `apps/cli/src/bin.ts` already uses for its own `switch (invocation.mode)`. `Config`'s schemastery shape is a flat object (`mode` required, `task`/`key`/`method` all optional) rather than a schema-level discriminated union: no existing schemastery usage in this repository validates a discriminated union of `z.object` branches, and this repository's `!!js`/schema-validation layer is a real config boundary the codebase's own conventions say to validate rather than assume. `apply()` re-establishes the discriminant in TypeScript and throws on the internal-invariant case where `headless-startup` (the config's sole writer) failed to pair `mode` with its field — a defect in this package, not a usage error.

**The terminal `AuthorizationInteraction`** renders every `notify()` as `message` plus `url`/`code` on their own lines, and answers every `prompt()` by reading one line from stdin (`node:readline/promises`); an empty answer rejects with `AuthorizationDeclinedError`, matching a closed browser tab. A prompt's own `signal` (an OAuth flow retiring the losing side of a local-server-vs-pasted-code race) is left to reject on its own rather than being folded into a decline, per the seam's documented distinction between the two. `select`-kind prompts render as a numbered list; the chosen option's `id` is returned.

**Success prints the one remaining step, not silence.** A committed credential does not by itself make an adapter's route live — `dsh-llm-pi-ai` stays dormant until its own `providers.<id>` settings entry exists — so `runLogin` names that step (edit `$DSH_HOME/settings.yaml` or use the web Models page) rather than leaving the human to discover it from the README.

## Alternatives considered

- **A Web UI "Sign in" flow** (a settings-page button driving `ctx.authorization.begin()` over the RPC gateway) — matches the long-term intended UX per `dsh-llm-pi-ai`'s README ("Supplying those profiles is exactly what the web Models page does"), but requires new gateway RPC surface, client UI, and browser-side handling of a flow whose OAuth mechanics (a local callback server on `127.0.0.1`) are designed for the machine running the CLI, not necessarily the machine running the browser tab. Deferred; the CLI path needed none of that surface and directly fits pi-ai's own flow shape.
- **A new dedicated package for the terminal interaction** — the interaction has exactly one real implementation (an actual terminal) and no other current consumer; a capability seam is for multiple providers of one contract, and inventing one here would be seam-without-need. Kept as a plain function inside `dsh-headless`.
- **Two composed rows (`headless-runner` + a sibling `headless-login`), each `disabled: !!js` on the other's mode** — rejected because no existing row in this repository disables itself based on another row's *injected service value* (only static `process.platform` precedent exists), and getting the Loader's evaluation/injection ordering wrong here would fail silently rather than loudly. One plugin branching in TypeScript needed no such assumption.
- **A schemastery discriminated union for `Config`** (`z.union([z.object({mode: z.const('task')...}), z.object({mode: z.const('login')...})])`) — no example in this repository exercises schemastery unioning `z.object` branches by a `z.const` discriminant; without a precedent to confirm correct branch selection, a flat optional-fields schema plus explicit TypeScript discrimination in `apply()` was the honest, verifiable choice.
- **Auto-writing the adapter's `providers.<id>` settings entry on successful login** — would make `dsh login` a silent settings mutation for a deployment-specific choice (which provider route to enable, and under what shape) that the codebase's conventions treat as explicit configuration, not something a credential-obtaining command should infer. Printing the next step was preferred.

## Consequences

`dsh --profile headless login llm-pi-ai/anthropic` authorizes a Claude Pro/Max subscription grant end to end, using the flow `dsh-llm-pi-ai` already registered; no changes were needed inside that package. The same command works for any other registered flow (any installed pi-ai catalog provider's OAuth or interactive-api-key login, addressed by its own `llm-pi-ai/<providerId>` key), and for any future non-pi-ai flow that registers on the same seam, since the CLI is generic over `CredentialKey` rather than Anthropic-specific.

`dsh-authorization` is now mounted, and therefore load-bearing, in every profile derived from `dsh-base` (web, headless, tui, and any custom profile), not only headless — a profile author who never uses `login` pays only the cost of one dormant plugin row.

Signing in does not, on its own, make a model selectable: the adapter's route configuration remains a separate step the command documents but does not perform.

## Testing

`packages/bundle/headless/tests/headless.spec.ts` boots the real Loader composition with a test-only `AuthorizationFlow` (no network call to any real OAuth issuer) and drives `login <key>` with scripted stdin, asserting the rendered notice, the committed credential record, and both the authorized and declined exit paths; the pre-existing task-mode coverage is unchanged.
