---
description: "Shared React UI atoms for the dsh web client: controls, icons, markdown and math rendering, and the terminal/read/diff/search/web output cards (zero cordis)."
kind: "package-library"
---

# @deepseek-ai/dsh-client-ui-primitives

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-primitives` is the web client's shared React component library: every feature plugin composes its UI from these atoms, and nothing here depends on Cordis or the slot system. It provides the control set (buttons, pills, inputs, menus, modals, toast banners, disclosure rows, hover cards, connection banners), the icon glyphs and brand marks, positioning hooks for anchored overlays, and the content renderers for agent output: markdown with TeX math, terminal output, file reads, diffs, search results, web retrieval, and JSON inspection. The renderers are built for untrusted model output — raw HTML is dropped, links are neutralized or opened safely, and ANSI escape sequences are parsed rather than passed through. User-facing copy is supplied through label props; the feature plugin that composes an atom owns localization.

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

Compose feature UI from these atoms whenever the web client needs a standard control or an agent-output renderer. They render through React only and take `--dsw-*` design tokens from the theme, so they fit any plugin without importing the theme or the slot system.

### Controls and icons

`Button`, `Pill`, `Input`, `Menu`, `Modal`, `Tooltip`, `DisclosureRow`, `StateDot`, `HoverCard`, `Toast`, `ConnectionBanner`, `RiskConfirmation`, and the `OnboardingSurface` first-run takeover cover the common interaction shapes. The `ic_ds_*` icon set and the `FishLogo`/`BrandWordmark` marks fill brand and inline-icon slots. `useAnchoredPosition` and `useAnchoredMaxHeight` keep floating panels and bottom-anchored overlays clamped to the viewport and following their anchor. `HoverCard` keeps its portaled preview reachable across the anchor gap and can expose a copy button through the `copyText` prop. `Toast` holds for the window its owner names through `holdMs`, because how long a banner has to stay depends on how much there is to read; the same value drives its unmount timer and the stylesheet's fade delay, so the two cannot disagree.

### Rendering agent output

`MarkdownText` renders untrusted GFM and TeX math, blocks unsafe links and images, and can turn resolved file mentions into explicit controls. While a reply streams, it freezes completed blocks and highlights a growing fence from saved Shiki grammar state; the final render uses the same span tree ([incremental renderer](../../../.agents/notes/implemented/architecture/2026-08-06-web-markdown-incremental-ast-renderer.md), [streaming fence highlighting](../../../.agents/notes/implemented/feature/2026-08-20-web-streaming-fence-highlight.md)). `TerminalBlock`, `ReadBlock`, `DiffBlock`, `SearchBlock`, and `WebBlock` render the matching tool-result intent with copy controls, overflow handling, and ANSI processing where applicable. `JsonTree` and `JsonBlock` inspect JSON values read-only, while `MessageText` remains the literal-text primitive for user-authored content.

### File preview

`FilePreview` renders a caller-resolved file body for in-app preview: Markdown through `MarkdownText`, text/code through `ReadBlock` (line-numbered, shiki-highlighted), an image from a caller-supplied blob URL, or a one-line notice for every other case — external (unrecognized extension or a kind the caller never fetches), too-large, error, or a binary read whose classified kind expected text. The component is pure and carries no host or wire vocabulary: the caller resolves its own fetch/classify concepts (a Workspace file read, a tool read result, or any other file source) into the plain `FilePreviewState`/`FilePreviewKind` union before rendering, so the same body composes both a `Modal`-shelled file dialog and a full-pane tab view. `imageAlt` defaults to `path` and `className` defaults to the component's own scroll-capped wrapper; a caller with different chrome overrides either. Two current consumers: `ui-workspace`'s `FileViewer` (a `Modal` around it) and `ui-conversation`'s `FileView` (a `conversation.view` tab pane around it) — see [the File tab Agent Note](../../../.agents/notes/implemented/feature/2026-08-26-file-preview-conversation-tab.md).

### File editing

`FileEditor` is the in-app text editor behind `ui-conversation`'s File tab Edit mode: a CodeMirror 6 buffer (`@codemirror/state`/`view`/`commands`, plus `@codemirror/lang-markdown` for Markdown's list/blockquote continuation), themed entirely through the same `--dsw-*`/`--dsw-font-markdown-code-block` tokens `ReadBlock`/`SideBySideDiff` already use. For `kind: 'markdown'` it splits into two columns — the editor pane and a live preview pane that re-renders the buffer through `MarkdownText` on a 150ms debounce — giving Markdown a genuine live-preview editing surface built from a component this package already has, not a new WYSIWYG dependency. For `kind: 'text'` it is a single undecorated-monospace pane. The component is deliberately uncontrolled after mount: `path`/`text`/`kind` seed the initial buffer once, then CodeMirror owns the document, undo history, and cursor for that file's lifetime; a caller wanting a fresh buffer for a different file remounts by keying on the path (`ui-conversation`'s `FileView` does this). Every edit reports the full buffer through `onChange`; `onSaveRequested` binds Cmd/Ctrl+S while the editor has focus, suppressing the browser's own save-page dialog. Rationale (CodeMirror over Monaco, no per-language syntax highlighting while editing, the uncontrolled-after-mount contract): [the in-app file editing Agent Note](../../../.agents/notes/implemented/feature/2026-08-27-file-tab-in-app-editing.md).

### Localizing copy

The atoms cannot read the application locale, so every piece of user-facing copy arrives through required label props. `HoverCard`, `TerminalBlock`, `JsonTree`, `CodeBlock`, `MarkdownText`, `JsonBlock`, `ConnectionBanner`, `Modal`, `DiffBlock`, `ReadBlock`, `SearchBlock`, and `WebBlock` accept complete localized labels. The package owns no language fallback; omission fails typechecking, and each feature maps its typed `t` seat into the primitive's label interface.

`SideBySideDiff` renders one file's `HEAD`-vs-working-tree text as a two-column diff, old on the left and new on the right, each with its own line-number gutter — the git-style counterpart to `DiffBlock`'s stacked chat card, for `ui-conversation`'s File tab diff view. It aligns `diffLines` (the `diff` package) output into rows: a removed block immediately followed by an added block (a replacement) pairs their lines row for row, the longer side's excess lines standing alone with the other column blank; any other removed-only or added-only block leaves the other side blank for those rows; unchanged lines stay in step on both sides. `oldText`/`newText` are independently nullable (no `HEAD` blob, or the file is gone from the working tree) and treated as empty. Unlike `DiffBlock`/`ReadBlock` it shows the whole file with no height cap — it is already a dedicated full-file view — and carries no syntax highlighting, the same choice `DiffBlock` makes. The banner always renders (an empty label when `path` is omitted) and always carries the copy control, which writes the unified `-`/`+`/` `-prefixed text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is one separation: presentational React atoms with zero Cordis and zero slot knowledge, styled only through `--dsw-*` tokens, while every feature-specific concern (locale, session data, composition) stays in the composing plugin.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Public atom exports |
| [`src/markdown/`](src/markdown/) | Markdown and math pipeline: micromark parsing, KaTeX typesetting, incremental streaming renderer, `CodeBlock`/`JsonBlock` |
| [`src/TerminalBlock.tsx`](src/TerminalBlock.tsx) | ANSI escape parsing (`anser`) and terminal card rendering |
| [`src/ReadBlock.tsx`](src/ReadBlock.tsx) / [`src/DiffBlock.tsx`](src/DiffBlock.tsx) | Read and diff cards |
| [`src/SearchBlock.tsx`](src/SearchBlock.tsx) / [`src/WebBlock.tsx`](src/WebBlock.tsx) | Search and web-retrieval cards |
| [`src/icons/`](src/icons/) | `ic_ds_*` glyph components and brand marks |
| [`src/useAnchoredPosition.ts`](src/useAnchoredPosition.ts) / [`src/useAnchoredMaxHeight.ts`](src/useAnchoredMaxHeight.ts) | Floating-panel and overlay geometry hooks |

### Streaming markdown

While a reply streams, `MarkdownText` parses incrementally: all but the trailing two blocks freeze as cached React elements and only the source tail re-parses per chunk, so per-chunk work tracks the tail instead of the whole reply. A growing fenced block tokenizes completed text from saved Shiki grammar state plus the unfinished last line; completed lines retain their DOM, and the settled render uses the same span tree. The settled full parse at finalize also resolves references that crossed the freeze boundary ([incremental renderer](../../../.agents/notes/implemented/architecture/2026-08-06-web-markdown-incremental-ast-renderer.md), [streaming fence highlighting](../../../.agents/notes/implemented/feature/2026-08-20-web-streaming-fence-highlight.md)).

### Geometry and overflow

The output cards share one geometry model: `white-space: pre` with horizontal scrolling so column-aligned content keeps its alignment, and a head-plus-tail slice behind an expand button past `maxLines` (default 16) so a long body never stretches the card. `TerminalBlock` parses ANSI into React spans with a per-line column buffer for cursor movement, honoring erase-in-line, tab stops, and character width.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages place the atoms in the client stack and the design system.

- [ui-renderer](../ui-renderer/README.md) — the React renderer that mounts the assembled application and binds slot data.
- [ui-tool](../ui-tool/README.md) — the tool-call presentation layer that composes these output cards.
- [ui-conversation](../ui-conversation/README.md) — the chat surface that renders markdown replies and tool cards.
- [ui-theme](../ui-theme/README.md) — the `--dsw-*` token system these atoms style through.
- [Web styling](../../../docs/web-styling.md) — the authoritative styling rules for web client components.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how the atoms behave at the edges; they are current package constraints, not a component roadmap.

- **Streaming defers cross-boundary reference resolution** — a reference-style link or footnote whose definition sits on the other side of the incremental freeze boundary renders as literal text while the reply streams; the settled full parse at finalize resolves it.
- **Glyph-level icons are redrawn approximations** — the fish logo and the sparkle mark come from font glyphs whose vector geometry is not exportable from the local design data; hand-authored recreations stand in until an exact export path exists.
- **`IconFilePlaceholder16` is not a figma extract** — every other icon in the set is a real design-source export; this one is a plain drawn placeholder for the Workspace Files tree's file rows, pending a real asset.
- **`Pill` and `Input` have no design source** — both atoms are self-defined; the sidebar search field and view-tab strip that resemble them are consumer-owned compositions, not these atoms.
- **No `Active` `StateDot` variant** — the supported states are done, warning, ongoing, and error.
- **User-facing copy is required at the render site** — the atoms are zero-Cordis and cannot reach `ctx.locale`; each feature must supply complete localized labels through the primitive's typed props ([decision](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md)).
- **`TerminalBlock` is not a terminal emulator** — it renders settled or still-running command output, not an interactive session: SGR colors, carriage return, backspace, erase-in-line, tab stops, and character width are honored; absolute cursor positioning, screen clearing, and alternate-screen sequences are stripped.
- **`FileEditor` has no syntax highlighting while editing** — the app's one syntax highlighter (`markdown/highlight.ts`, shiki-based) already covers every `langFromPath` language for the read-only `ReadBlock`/`FilePreview` View mode; duplicating that coverage with a second, CodeMirror-native grammar per language would double the highlighting surface (and its bundle cost) for no reader-facing gain while editing. A deliberate scope line, not an oversight.
- **`FileEditor`'s Markdown split preview has no responsive fallback** — the two-column layout assumes a docked panel wide enough for both; a narrow host (e.g. a phone-width viewport) is not yet addressed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
