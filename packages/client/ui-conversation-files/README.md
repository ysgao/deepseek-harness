---
description: "The File conversation-view plugin for the dsh web client: in-app preview, edit, and side-by-side git diff for a session's opened workspace paths."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-conversation-files

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-conversation-files` is the File conversation-view plugin of the dsh web client: it registers the "file" entry in `ui-conversation`'s `conversation.view` ring, alongside Chat and Trajectory. Any other plugin holding a workspace path — the Workspace Files tree is the first caller — hands it to `ui-conversation`'s `conversationFileOpener` service, which this package's tab then renders: a shared preview body, an optional View/Diff toggle when the path has a pending git change, and an in-app editor for text and Markdown files. Like every other `conversation.view` entry, the tab is mounted only when this package is installed; `ui-conversation` itself registers none by default.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Users open a workspace path (from the Workspace Files tree, or a Chat message's file reference) and see it appear as a File tab beside Chat. A text file with an on-disk git change offers a View/Diff toggle; text and Markdown files also offer an Edit mode with an in-memory per-path draft, guarded on save by the file's read version so a concurrent on-disk change surfaces as an inline conflict rather than a silent overwrite. Binary, image, and unrecognized files fall back to opening with the Host's default application.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`apply.ts` lazily registers the `conversation.view` "file" entry the first time any plugin reads that slot, resolving the session's owning workspace through `ctx.get('workspaces')` for every RPC call (`readFile`, `gitStatus`, `gitFileDiff`, `writeFile`) so a session with no owning workspace fails loud instead of silently no-opping. `FileView.tsx` owns the tab's own view/edit/diff mode state, an in-memory draft cache keyed by path, and a lazy git-status/diff fetch (only once the Diff toggle is actually shown). `classify.ts` maps a path's extension to a preview kind and shiki language hint — duplicated in miniature from `ui-workspace`'s own `classify.ts` rather than imported, since it is a small pure mapping, not a shared business concept.

This package does not own the cross-plugin file-open registry itself: `ui-conversation`'s `file-opener.ts` and `conversationFileOpener` service are generic infrastructure that exists whether or not this package is mounted, so a caller's `ctx.get('conversationFileOpener')?.openFile(...)` degrades to a no-op fallback (the Host OS-default handoff) when this package is absent, rather than throwing.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-conversation](../ui-conversation/README.md) — the Conversation shell, the `conversation.view` ring, and the generic `conversationFileOpener` cross-plugin handoff.
- [ui-workspace](../ui-workspace/README.md) — the Workspace Files tree, the first caller of `conversationFileOpener`.
- [dsh-api-workspace-controller](../../api/workspace-controller/README.md) — the Remote methods (`readFile`, `writeFile`, `gitStatus`, `gitFileDiff`) this package's tab calls.
- [ui-primitives](../ui-primitives/README.md) — `FilePreview`, `FileEditor`, and `SideBySideDiff`, the presentation atoms this package composes.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side file presentation layer that renders workspace content a user opened; it does not change model context.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **File-view copy reuses the `ui-conversation` locale namespace** — the tab's own `files.*`/`view.file` keys and the shared `copy`/`copied`/`collapse`/`read.*`/`markdown.footnotes` keys it borrows from Chat and Tool cards both live in that dictionary, following the same convention `ui-tool` already uses for those shared keys.
- **The Diff toggle is text-only** — binary and image files stay out of scope for View/Diff, same as `FilePreview`'s own PDF-preview posture; this is a deferred follow-up, not a gap in the current feature.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Extracted from `ui-conversation` during the upstream merge that introduced `ui-conversation`'s zero-default-views architecture (every `conversation.view` entry, including Chat, is its own separately-mounted package); see the port's Agent Note for the full rationale.

</details>
