---
description: "Target-neutral conversation assembly and browser shell: event and view registries, per-session bindings, input state, slots, and temporary composer takeovers."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-conversation

English | [中文](README.zh.md)

## Summary

`ui-conversation` owns target-neutral Conversation assembly and the shared browser shell. It consumes Session Controller `SessionEventLikeEntry` feeds, exposes React-free registries and per-Session bindings through `ctx.uiConversation`, and contributes the `useConversation`, `useInput`, and `inputActions` standard props through `ctx.uiSession`. It also owns the per-session durable image URL cache: `ctx.uiConversation.imageUrl(sessionId, attachment)` resolves one session-authorized browser URL per attachment and revokes it with the Session binding, so every Conversation target shares one `session.attachment` read. Concrete targets such as Chat are separate packages that register their own Definitions, snapshot builders, Views, and renderers.

## Table of Contents

- [Conversation assembly](#conversation-assembly)
- [Shell and standard props](#shell-and-standard-props)
- [Temporary composer entries](#temporary-composer-entries)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

This package's own second view (`id: 'file'`, order 5) is `FileView`, three modes over a session's currently opened workspace path — always present in the ring, showing an empty-state notice until a path is opened. View renders `dsh-client-ui-primitives`' shared `FilePreview` body (read-only). Diff shows when the path is a text-kind file with a pending git change (per `getGitStatus`): it fetches `getFileDiff` lazily and renders `SideBySideDiff` in its place. Edit shows for any text or Markdown file and renders `dsh-client-ui-primitives`' `FileEditor` (a CodeMirror 6 buffer, with a live Markdown preview pane for `.md`); a Save button and a Cmd/Ctrl+S binding call the injected `writeFile`, guarded by the version `readFile` returned. Unsaved edits live in an in-memory per-path draft cache, not React state, so switching to another file (or to View/Diff) and back never silently loses a draft; a save rejected as `file-changed` (the file changed on disk since it was read) surfaces an inline conflict notice with a discard-and-reload action rather than overwriting it. Any plugin holding a workspace path — the `ui-workspace` Files tree, today — reaches the tab through the optional `ctx.get('conversationFileOpener')` service instead of only ever falling back to the Host OS-default handoff: `openFile(sessionId, path)` writes the request into a per-session registry (`files/file-opener.ts`) that `ConversationSession` drains into the session's own conversation store (`viewRequest`, one-shot and generic across every View) and switches the active tab — the actual cross-session write surface, since `ui-slots` resolves a declared store's bound actions only inside that store's own registered components, never from outside the render tree. `ConversationSession`/`ConversationSessionHeader` render the File tab (and its own header row) even for a session that has not sent its first message yet, unlike Chat and Trajectory, which stay hidden behind the Hero welcome screen until then — a workspace file needs no turn to have run to be worth browsing or editing; see [the blank-session Agent Note](../../../.agents/notes/implemented/feature/2026-08-27-file-tab-reachable-while-blank.md). Rationale for the editor's own design choices: [the in-app file editing Agent Note](../../../.agents/notes/implemented/feature/2026-08-27-file-tab-in-app-editing.md).

<a id="conversation-assembly"></a>
## Conversation assembly

`UiConversation.events` is the single registry for event Definitions, and `UiConversation.views` is the single registry for target snapshot builders. Both registries reject duplicate keys, preserve registration order, return idempotent disposers, and rebuild existing bindings when their contribution roster changes. `UiConversation.binding(bindingOrSessionId)` returns one identity-stable Conversation binding for the current Session Controller binding. It does not open another event source.

The adapter passes each `SessionEventLikeEntry` directly to the assembler. Its outer `type` distinguishes scalar and packed records, while its inner `event` always exposes `type`, `seq`, `time`, and `data`; Definitions receive that inner `SessionEventLike`. Historical replace and prepend accept both entry variants, while live append accepts only `SessionLiveEventEntry`. Every Definition uses the same `match` and `update` methods for both event forms, while `start` receives only a standard event and the assembler rejects a packed start. Definitions that do not consume Assistant deltas return `null` for the packed tags. Replacement windows and revision gaps rebuild from the complete loaded window; contiguous append and prepend revisions use incremental assembly without expanding packed members. The assembler owns Context matching, Turn/Step locations, target node materialization, target activity, and stable target sources. `ConversationSnapshot` contains only target-neutral views and active-target facts; Session lifecycle state remains in `SessionSnapshot`.

Target packages declaration-merge their snapshot and Location data maps, then register with `ctx.uiConversation.events.register(...)` and `ctx.uiConversation.views.register(...)`. A target reads its Session-owned source with `ctx.uiConversation.binding(binding).target(targetId)`. Registrations are Cordis effects and their returned disposers remove the contribution from the same registry.

<a id="shell-and-standard-props"></a>
## Shell and standard props

The package registers the optional-Session `conversation` shell, strict Session header/body entries, View list, composer chain and bar, input regions, Hero regions, queue dock, draft persistence, and phase calculation. `ctx.uiSession.provide()` materializes the Conversation and input sources from the same Session binding and supplies `inputActions` as a stable standard prop.

View selection is deterministic: a registered persisted selection wins, otherwise registered `chat` wins, otherwise no View renders. It never chooses the first registered View. Shell phase combines Session lifecycle with the active-target set; no target-specific snapshot is read by the shell.

The resident composer survives no-Session and Session transitions. The no-Session state keeps the same composer surface mounted but inert while the Workspace picker connects a blank Session. The surface is a shell-owned Lexical editor: reference chips are atomic decorator nodes carrying the owner's serialization identity (submission expands them through the owner codec), claimed slash commands stay styled leading text, folder text references carry the folder glyph as an icon prefix, and the draft's clipboard projection is mirrored into the per-Session Conversation store. Queue operations address exact queue occurrences through the scoped `ctx.conversation` service; queue previews render sent text through the shared inline reference projection from `ui-primitives` (wire session forms fold to their label), while an edit exposes the literal sent text. Busy Enter behavior is stored in the Host-backed `ui-conversation` settings namespace.

Default sends commit optimistically: Enter clears the draft, occurrence table, and undo history in the same transaction, keeps the composer in `plain`, and runs the send as a detached attempt, so typing and further sends continue during the flight. `sendSession` registers a Session submission echo (`session.beginSubmission`) before serializing, yields one paint so the echo renders on the click's own frame, and encodes images through the browser's native `FileReader` data-URL path. Concurrent failures are restored together in submission order until the user edits the restored content; command submissions keep the frozen `submitting` phase. Detached attempts retain their image ids through admission and Session scope disposal. When an echo retires as observed, the durable image cache exposes its preview immediately, fetches the admitted attachment, replaces the preview with the canonical URL, and revokes each URL after its use ends. Direct subagent continuations skip local echoes because their transport does not preserve the browser request id.

While a normal composer is running, its primary pointer action remains Stop when the draft is empty or input is unavailable. Actionable text or attachments switch the same seat to Queue Send; clearing or successfully submitting the draft restores Stop. The busy-Enter setting continues to select the Queue or Steer keyboard action. Continuable subagents keep separate Send and Stop actions ([decision](../../../.agents/notes/implemented/bug-fix/2026-08-20-running-draft-primary-send.md)).

<a id="temporary-composer-entries"></a>
## Temporary composer entries

`conversation.composer` is a generic chain. Its complete owner currency is:

```ts type-equiv
/** Owner values used to elect a composer takeover. */
interface ComposerChainProps {
  /** Current Session identity used by temporary business-owned entries. */
  sessionId: SessionId | undefined
  /** Current Session lifecycle state, absent without a selected Session. */
  session: SessionSnapshot | undefined
  /** Effective business-owned interaction awaiting the user in this Session. */
  pendingInteraction: SessionPendingInteraction | undefined
}
```

A business package may install one entry only while a Remote waterfall request is pending:

```tsx
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChainSelect, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

interface Request {
  readonly sessionId: SessionId
}

type RequestComposerProps =
  PropsRuntime<'conversation.composer'> & { matched: Request }

const select: ChainSelect<ComposerChainProps, Request> = owner =>
  owner.sessionId === request.sessionId ? request : null

const dispose = ctx.slots.register(
  { name: 'conversation.composer', select },
  RequestComposer,
)

try {
  return await request.result
} finally {
  dispose()
}
```

The selector must be a pure function of the owner currency. Its non-null return is delivered to the component as `matched`; `PropsRuntime<'conversation.composer'>` supplies the standard Session and global props. Chain order remains ascending `priority`, then registration order, and the first non-null selector wins. The shell keeps the default composer mounted beneath a takeover. Request state, listeners, response encoding, and any request-specific child slots belong to the business package; they are not carried by `SessionSnapshot` or declared by this core package.

<a id="model-experience"></a>
## Model Experience

None, as this package renders browser state and sends user-admitted inputs through Session Controller APIs without constructing model requests.

#### KV Cache effect

None; Conversation assembly and browser input state do not alter provider-side prompt caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only registered targets can render** — the shell deliberately has no implicit fallback target beyond the registered `chat` preference.
- **The File tab's Edit mode is scoped to text and Markdown** — binary and image files offer no Edit toggle in v1, the same scope line the Diff toggle already draws.
- **An unsaved draft is discarded, not merged, on `file-changed`** — the conflict notice's only recovery is discard-and-reload; there is no three-way merge or diff-against-disk view offered from inside the conflict state.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
