# Agent Note: `bash` rejects an escaping absolute `workdir` before dispatch

Status: implemented

English | [中文](2026-08-30-bash-workdir-escape-preflight.zh.md)

## Problem

[The sandbox Agent Note](2026-07-06-sandbox.md) documents that `workdir` resolution and confinement share one `SandboxExecutionPolicy`, but `dsh-tool-bash`'s `resolveWorkdir` only makes a RELATIVE `workdir` session-workspace-relative; an absolute `workdir` was passed straight to the executor regardless of the resolved `workspaceRoot`. Under `workspace-write`/`read-only`, an absolute `workdir` outside that root still reached the confining executor, which then rejected the confined spawn (or a `cd`-equivalent) with an opaque runner-failure or sandbox-denial result — real containment held, but the model saw a late, confusing failure instead of a clear reason naming the expected root. A model that mis-guesses the session's absolute path (a stale prior `pwd`, a different container mount, a copied example) had no earlier, legible signal.

## Decision

`dsh-tool-bash` adds a synchronous preflight, `rejectWorkdirEscape`, run right after the call's effective `SandboxExecutionPolicy` is resolved (post-escalation) and before `resolveWorkdir`/dispatch: when a confining executor makes `workspaceRoot` known and the effective mode is not `danger-full-access`, an absolute `workdir` lexically outside that root throws `invalid workdir: "<path>" is outside the session workspace "<root>"; use a relative path instead of an absolute one`. The check is a lexical prefix comparison against the already-canonical `workspaceRoot` (the cheap fast path `fs-sandbox`'s `isPathUnder` also takes for ordinary spellings) — no stat, no symlink walk: the executor's own OS-level confinement (Landlock/bwrap/Seatbelt) remains the actual security boundary regardless of this preflight, so this call site does not need the async ancestor-identity fallback that boundary owns.

An absolute `workdir` already INSIDE `workspaceRoot`, any `workdir` under `danger-full-access`, and any `workdir` when no confining executor is mounted (`dsh-bash-local`, most tests) are all unaffected — the existing "an explicit absolute workdir overrides the session cwd" contract holds everywhere it has no workspace root to violate. The `workdir` parameter description gains one sentence naming the restriction so the model learns the rule at the decision point, not only from a rejected call.

## Alternatives considered

**Reject every absolute `workdir` unconditionally (relative-only).** Rejected: breaks the documented, tested contract that an absolute `workdir` overrides the session cwd (`tools/tools.spec.ts` — `'an explicit absolute workdir overrides the session cwd'`), and an absolute path already inside the workspace is not a mistake worth failing.

**Full async containment via `fs-sandbox`'s `isPathUnder` (ancestor filesystem-identity walk).** Rejected: that fallback exists to recognize alias-equivalent roots (Windows 8.3/long names, casing) for a real containment boundary enforced against a mutation. Here the boundary is still the executor's own confinement; this preflight only turns a late, opaque denial into an early, legible one, so the synchronous lexical fast path is the right cost for every call, including unconfined compositions that skip the check entirely.

**Enforce in the shell Service Definition (`dsh-shell`) instead of the tool.** Rejected: the Service Definition is deliberately session-free ([capability-seam rationale](../architecture/2026-06-13-capability-seams.md)); `workspaceRoot` only exists per-call after `ctx.sandboxPolicy.resolve()`, which the tool layer already owns for escalation and `workdir` resolution.

## Consequences

A confined session given a stale or mistaken absolute `workdir` now fails synchronously with the expected root named in the message, before any process is spawned, instead of surfacing through the executor's runner-failure or denial channel. Unconfined compositions and in-workspace absolute paths are unaffected; the existing `workdir` test matrix (`tools.spec.ts`) gained four cases covering the confined-outside rejection, confined-inside acceptance, escalated-outside acceptance, and unconfined pass-through.
