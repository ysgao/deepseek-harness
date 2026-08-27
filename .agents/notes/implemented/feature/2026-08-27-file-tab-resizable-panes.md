# Agent Note: Draggable resize divider for the File tab's split panes

Status: implemented

English | [中文](2026-08-27-file-tab-resizable-panes.zh.md)

## Problem

The File tab's two split-pane surfaces — `FileEditor`'s Markdown edit/preview split ([in-app file editing](2026-08-27-file-tab-in-app-editing.md)) and `SideBySideDiff`'s old/new diff columns ([side-by-side git diff](2026-08-27-file-tab-git-diff.md)) — both divide their container into two fixed, equal-width tracks (`grid-template-columns: 1fr 1fr` and two `1fr` content tracks respectively) with no way to change the split. A reader who wants more room for one side (a long Markdown source next to a narrow preview, or a diff where one side's lines run long) has no way to get it.

## Decision

**A new shared hook, `useSplitRatio` in `ui-primitives`**, tracks a divider's position as the left/old pane's share of its container width, `[min, max]` clamped (default `[0.2, 0.8]`, `defaultRatio` `0.5`). It exposes `dividerProps` — `onPointerDown`/`onPointerMove`/`onPointerUp`/`onPointerCancel` with pointer capture, `onDoubleClick` resetting to `defaultRatio`, `onKeyDown` nudging by a fixed step on Arrow Left/Right — for a caller to spread onto its own divider element. The pattern (pointer-capture drag, ref-held drag-start snapshot, clamp function, double-click reset, arrow-key step) mirrors the private resize handles already in `AppFrame` (`ui-layout`) and `TrajectoryTable` (`ui-trajectory`); this is the third occurrence in the codebase and the first two consumers living in the same package as each other justified extracting it here rather than duplicating a fourth copy. `onPointerDown` reads the divider's own `parentElement`'s `getBoundingClientRect().width` as the container width, so a caller's only placement requirement is that the divider renders as a direct child of the element whose width the ratio divides.

**Both consumers size their columns with `calc()` against a CSS custom property, not JS-computed inline widths.** `FileEditor.module.css`'s `.splitRoot` becomes a 3-track grid (`calc((100% - 8px) * ratio) 8px calc((100% - 8px) * (1 - ratio))`), the middle track holding a real divider element (a thin line via `::after`, not the old shared-background grid-gap trick). `SideBySideDiff.module.css`'s `.body` becomes a 5-track grid (`gutter, calc(...*ratio), 8px, gutter, calc(...*(1-ratio))`) — the new 8px track sits between the two content columns, and `.row`'s four cells (still `display: contents`) get explicit `grid-column` assignments (1, 2, 4, 5) since CSS Grid auto-placement cannot skip a reserved column on its own. The divider itself spans `grid-row: 1 / -1` as a plain grid item (not `display: contents`) placed in the reserved column, so it renders once and scrolls together with `.body`'s horizontal overflow instead of needing to track scroll position separately.

## Alternatives considered

- **Extract `TrajectoryTable`'s existing private resize handle into a shared component instead of writing a new hook.** Rejected: that implementation carries a paired-column concession solver (`clampDetailsWidth`/`defaultToolRequestWidth`) sized for its own three-panel layout and lives in `ui-trajectory`, a package neither File tab consumer depends on; pulling it in would add a cross-package dependency for logic this simpler two-pane case does not need.
- **An absolute pixel width in component state**, remeasured via `ResizeObserver` on container resize. Rejected: a `calc()`-driven fraction of `100%` stays correct across container resizes (a panel width change, a window resize) with no observer at all; an absolute width would need to re-derive itself on every resize to avoid drifting off-proportion.
- **Persist the ratio across remounts** (session state, `localStorage`). Deferred: `FileEditor` already remounts per open file, by design ([in-app editing Agent Note](2026-08-27-file-tab-in-app-editing.md)), so the ratio resetting per file open is consistent with the rest of that component's already-uncontrolled-after-mount posture; no current consumer asked for persistence across files or sessions.

## Consequences

- `ui-primitives` gains one new export, `useSplitRatio` (plus its `SplitRatioOptions`/`SplitRatioResult`/`SplitDividerProps` types), with no new dependency.
- `FileEditor.module.css` and `SideBySideDiff.module.css` both move from static equal-fraction grids to `calc()`-based tracks keyed by a per-component CSS custom property (`--ds-file-editor-ratio`, `--dsl-sbs-diff-ratio`); `SideBySideDiff`'s row cells gained explicit `grid-column` placement they did not need before the divider claimed its own track.
- `useSplitRatio.ts`, `FileEditor.tsx`, and `SideBySideDiff.tsx` all reach 100% line/branch/function coverage in `ui-primitives`'s own package suite (one `container === null` guard in `useSplitRatio`'s pointer-down handler is `v8 ignore`d: every caller renders the divider as a direct child of the container it divides, so nothing in a portable test can leave a mounted divider parentless); a new `use-split-ratio.client.spec.tsx` covers the hook directly through a minimal harness component, and both existing component specs gained a divider-drag assertion.
- No `apps/web/tests/snapshots/` browser scenario was added, following the same precedent the two prior File tab notes already established for this area: package-level component coverage, not a browser transcript, has been the standing bar for this surface.
