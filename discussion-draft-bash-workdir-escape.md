## Suggested title
`bash` tool: absolute `workdir` outside the sandbox workspace root fails late/confusingly instead of being rejected up front

## Suggested category
General (no dedicated "bug report" category exists; Q&A is the alternative if you'd rather route it there)

---

### Problem

In `packages/shell/tool-bash`, `resolveWorkdir` only makes a *relative* `workdir` session-workspace-relative; an absolute `workdir` is passed straight to the executor regardless of the resolved `SandboxExecutionPolicy.workspaceRoot`.

Under `workspace-write`/`read-only`, an absolute `workdir` outside that root still reaches the confining executor (bwrap/Landlock/Seatbelt/Windows ACL), which then rejects the confined spawn with an opaque runner-failure or sandbox-denial result. Real containment holds — nothing escapes — but the model (and the user watching the transcript) sees a late, confusing failure instead of a clear reason naming the expected workspace root. This is most likely to bite when the model has a stale or mis-guessed absolute path for the session (an old `pwd` output, a different container mount, a copied example).

### Fix

Add a synchronous preflight in `dsh-tool-bash`, run right after the call's effective `SandboxExecutionPolicy` is resolved (post-escalation) and before dispatch: when a confining executor makes `workspaceRoot` known and the effective mode isn't `danger-full-access`, an absolute `workdir` lexically outside that root is rejected immediately with:

```
invalid workdir: "<path>" is outside the session workspace "<root>"; use a relative path instead of an absolute one
```

The check is a cheap synchronous lexical prefix comparison against the already-canonical `workspaceRoot` — no stat, no symlink walk — mirroring the fast path `dsh-fs-sandbox`'s `isPathUnder` also takes for ordinary spellings. The executor's own OS-level confinement remains the actual security boundary regardless of this preflight; this only turns a late, opaque denial into an early, legible one.

Unaffected, by design:
- An absolute `workdir` already **inside** `workspaceRoot` — preserves the existing, tested contract that an absolute `workdir` overrides the session cwd.
- Any `workdir` under `danger-full-access` — no containment to violate.
- Any `workdir` when no confining executor is mounted (e.g. `dsh-bash-local`) — no workspace root exists to check against.

The `workdir` parameter's own description gains one sentence stating the restriction, so the model learns the rule at the decision point rather than only from a rejected call.

### Where to look

I can't open a PR (per `CONTRIBUTING.md` and the repo's disabled PR setting), so here's the change on my fork instead — one commit, 5 files (the fix, its tests, and its Agent Note):

https://github.com/ysgao/deepseek-harness/commit/df5080a35750126f05f1a660ad691d642e92b30e

### Testing done

- 4 new unit tests in `packages/shell/tool-bash/tests/tools.spec.ts` covering: confined+outside (rejected), confined+inside (accepted), escalated to `danger-full-access` (accepted), and unconfined composition (unaffected pass-through).
- Full package suite: 90/90 passing.
- Scoped lint (`oxlint`) and scoped `tsc -b` on the package: clean.
- Repo's Agent Note gates (`verify-agent-note-format`, `verify-translation-pairing`, `verify-agent-note-classification`): passing.

Happy to answer questions or adjust the approach if there's a preference for where this check should live instead.
