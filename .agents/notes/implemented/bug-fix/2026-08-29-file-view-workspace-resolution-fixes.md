# Agent Note: Fix File view workspace resolution after the upstream port

Status: implemented

English | [中文](2026-08-29-file-view-workspace-resolution-fixes.zh.md)

## Problem

Porting the Files-tree/File-tab feature onto the post-refactor `dsh-client-connection`/`dsh-api-gateway` architecture (which deleted `packages/host/apiproxy` in favor of per-domain `@Remote`-decorated services, `packages/api/workspace-controller` among them) landed `packages/client/ui-conversation-files` as its own package (see [Wire the Workspace Files tree to the in-app File tab](2026-08-27-workspace-files-tree-file-tab-wiring.md)), but running the actual app surfaced two independent defects in how it resolves the Workspace a file belongs to, neither caught by the port's otherwise-green typecheck/lint/test/coverage run:

1. `apply.ts` read `ctx.get('workspaces')` once at plugin-mount time and closed over the result. `workspaces` is an optional cross-package service, never declared in this plugin's `inject` array, so nothing guarantees `ui-workspace`'s client service has registered yet when `ui-conversation-files` mounts. Whenever it hadn't, the closed-over value stayed `undefined` for the plugin's entire lifetime: every `readFile`/`gitStatus`/`getFileDiff`/`writeFile` call rejected before any RPC left the browser, with no console error (a handled rejection) and no server log (the request never arrived) — the File tab just showed "Couldn't read this file" for every file, permanently.
2. Even once `workspaces` resolved, the owning Workspace was derived by scanning `workspaces.list.getSnapshot().items` for one whose `sessionIds` includes the current session — a reverse lookup that fails whenever that session isn't (yet) reflected in the target Workspace's roster. The Workspace Files tree (`FilesNode.tsx`) already holds its own `workspaceId` prop — the exact Workspace whose tree is being browsed — and never needed this derivation at all; only a caller with no Workspace of its own (a chat-message file mention, which only has a sessionId and a `cwd`) genuinely needs it.

## Decision

For (1): fetch `ctx.get('workspaces')` fresh inside the resolver on every call instead of once at `apply()` time, matching the pattern this codebase already uses for other optional cross-package services (`ui-chat`'s and `ui-workspace`'s own `conversationFileOpener` lookups both call `ctx.get(...)` inline, never cached).

For (2): thread the requester's own `workspaceId` explicitly end-to-end, using it directly wherever present and falling back to session-membership derivation only when absent:

- `ConversationFileOpener.openFile(sessionId, path, workspaceId?)` gains the optional third parameter.
- `FileOpenRegistry.request`/`PendingFileOpen` (`file-opener.ts`) carry `workspaceId` alongside `path` and `seq`.
- `ConversationSessionInjected.openFile(path, workspaceId?)` JSON-encodes `{ path, workspaceId }` into the `conversation.view` framework's single opaque `focus` string (`ConvViewOwnerProps.openView(view, focus)` — deliberately an opaque per-view identity, so this stays entirely inside the File view's own registration and needs no framework change).
- `FileView.tsx` decodes that payload (`OpenFileFocus`) and keeps the pair in local `openedPath`/`openedWorkspaceId` state so it survives across re-renders and background repo changes, the same way `openedPath` already did.
- `FileViewInjected`'s four methods (`readFile`/`getGitStatus`/`getFileDiff`/`writeFile`) each take `workspaceId: WorkspaceId | undefined` as their first argument; `ui-conversation-files/apply.ts`'s resolver uses it directly when present, and only derives from session membership when it's `undefined`.
- `ui-workspace`'s `openFileInSession(sessionId, workspaceId, path)` and `FilesNode.tsx`'s call site pass the tree's own `workspaceId` prop straight through, so the Files-tree path — the common case — never depends on session-roster timing at all.

## Alternatives considered

**Make `workspaces` a required `inject` dependency of `ui-conversation-files`.** Rejected: the same reasoning as the wiring note's rejection of a required `conversationFileOpener` dependency — a composition without `ui-workspace` must still load this package harmlessly, just with every file operation failing gracefully instead of the plugin refusing to mount.

**Keep session-membership derivation as the only resolution path, and instead fix its timing/data gap.** Rejected: there's no reliable way to guarantee a session is already reflected in the right Workspace's roster at open time from `ui-conversation-files`'s vantage point, and the Files tree already has the unambiguous answer — passing it through is strictly more correct, not just a timing patch.

**Broaden `ConvViewOwnerProps.openView`'s `focus` parameter into a structured `{ view, focus: unknown }` shape for every view.** Rejected: every other `conversation.view` entry treats `focus` as a plain opaque string; broadening the framework type to accommodate one view's richer payload would ripple through every existing view's registration for no shared benefit. JSON-encoding inside the File view's own `apply.ts`/`FileView.tsx` pair keeps the change local to the one view that needs it.

## Verification

`packages/client/ui-conversation-files/tests/apply.client.spec.ts` adds a case asserting an explicit `workspaceId` bypasses session-membership derivation entirely (including for a session absent from any Workspace's roster), alongside the existing derivation-success and derivation-failure cases. `packages/client/ui-conversation-files/tests/FileView.client.spec.tsx` adds a case asserting the focus payload's own `workspaceId` reaches every injected call, not a session-derived one. `packages/client/ui-workspace/tests/FilesNode.client.spec.tsx` and `apply.client.spec.ts` update their `openFileInSession`/`conversationFileOpener.openFile` call assertions to the three-argument shape. A full `pnpm run test:coverage` run (17,370 passed, 1 pre-existing unrelated failure in `scripts/oxlint-contract.spec.ts` caused by this sandbox's `FORCE_COLOR=3`, not this change) shows no coverage-threshold regressions.

## Consequences

The File tab reliably reads, writes, and diffs files opened from the Workspace Files tree regardless of plugin mount order or whether the open session is yet reflected in that Workspace's roster. A chat-message file mention (the one caller with no Workspace of its own) keeps its prior, weaker session-derivation fallback unchanged — it can still fail to resolve a Workspace for a session not yet in any roster, a narrower and pre-existing limitation this change does not extend to the Files-tree path.
