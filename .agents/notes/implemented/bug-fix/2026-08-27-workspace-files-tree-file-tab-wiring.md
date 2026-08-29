# Agent Note: Wire the Workspace Files tree to the in-app File tab

Status: implemented

English | [中文](2026-08-27-workspace-files-tree-file-tab-wiring.zh.md)

## Problem

`ui-conversation` exposes an optional `conversationFileOpener` service (`ctx.get('conversationFileOpener')`) whose `openFile(sessionId, path)` docks a Workspace file into the current session's File tab, with its own module doc naming "the Workspace Files tree" as the intended first caller. `ui-workspace`'s Files tree (`FilesNode.tsx`) never gained that call: its file-row handler was hard-wired to local `setPreviewPath` state, which always renders the `FileViewer` modal. Every file click in the sidebar therefore opened a floating preview window instead of docking into the main tab area, regardless of whether a session was current.

## Decision

`WorkspaceBrowserInjected` gains `openFileInSession(sessionId, workspaceId, path): boolean`. `ui-workspace`'s `apply` implements it as `ctx.get('conversationFileOpener')?.openFile(sessionId, path, workspaceId) ?? false`, the same optional-service shape as `chatFileMentions`. `SessionTree` already resolves the current session id (`useSessions(s => s).current`) for its own grouping logic; that id and the new callback are threaded through the existing `WorkspaceBrowser` → `SessionTree` → `FilesNode` prop chain alongside `listWorkspaceEntries`/`readWorkspaceFile`/`openPath`. `workspaceId` is `FilesNode`'s own prop — the exact workspace whose tree is being browsed — passed straight through rather than re-derived on the File view's side; see [Fix File view workspace resolution after the upstream port](2026-08-29-file-view-workspace-resolution-fixes.md) for why that direct id matters (this file's own signature above already reflects that fix).

`FilesNode`'s file-open handler now tries the session route first: when a session is current and `openFileInSession` returns `true`, it returns without touching local state. It falls back to `setPreviewPath` (the `FileViewer` modal) only when there is no current session or the service declines — the no-session New Session view, and any composition without `ui-conversation`, keep their existing behavior unchanged.

## Alternatives considered

**Resolve the current session id inside `FilesNode` via a new hook.** Rejected: `SessionTree` already computes `current` from the standard `useSessions` framework hook for its own group-expansion logic: reusing that prop needs no new hook or duplicate subscription.

**Make `conversationFileOpener` a required `inject` dependency.** Rejected: the service is deliberately optional (a composition without `ui-conversation` must still preview files), and `ui-workspace` already depends on `@deepseek-ai/dsh-client-ui-conversation` for its types without a hard runtime edge.

## Verification

`FilesNode.client.spec.tsx` adds cases for the accepted session route (asserts `openFileInSession` receives the path and the modal never mounts) and the declined route (falls back to the modal); the existing no-session cases pass `currentSessionId={undefined}` unchanged. `apply.client.spec.ts` adds a case asserting `openFileInSession` returns `false` before `conversationFileOpener` is provided and delegates once it is.

## Consequences

Clicking a Workspace file while a session is current docks it into that session's File tab instead of a floating preview. The `FileViewer` modal remains reachable — and is the only route — when no session is current or the service isn't composed in.
