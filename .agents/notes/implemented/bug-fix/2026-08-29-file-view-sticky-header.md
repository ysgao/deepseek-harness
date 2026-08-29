# Agent Note: Made the File view header stay while scrolling content

Status: implemented

English | [中文](2026-08-29-file-view-sticky-header.zh.md)

## Problem

The File tab (the `conversation.view` entry rendered by `ui-conversation-files`'
`FileView`) sits inside `ConversationRoot`'s single resident scrollport
(`.scrollBody`, one axis). Its own root held no scroller and its content body
had `overflow: auto`, so once the file's text ran past the view height that body
became a second, independent scrollport. Wheel over the content moved only the
content; the path banner and View/Edit/Diff toolbar scrolled away with it. With
a long file the header left view before any button or the unsaved indicator was
reachable, so `Save` (and its conflict reload) required scrolling back to the top
to find them.

## Decision

Make `.root` the single scrollport and pin `.header` to its top with
`position: sticky; top: 0`. The root already fills the column's content box
(`flex: 1`, `min-height: 0`) and owns no other scroller (the Edit mode's
CodeMirror buffer and Diff mode's side-by-side pane are in-place, not nested
scrollports), so promoting it to a single-axis scroller (`overflow-y: auto` +
`scrollbar-gutter: stable`, matching `.scrollBody`) makes one surface scroll the
whole tab. The header sticks at `top: 0`; `z-index: 1` keeps its bottom border
above sibling sticky banners (the same ordering rule the active-phase composer
seat uses). Content padding moves from the body to a uniform `padding: 16px` so
the visible text clears the pinned strip's own `padding: 8px 16px`.

## Alternatives considered

**Leave `.body` as its own inner scrollport.** Rejected — this is exactly the
bug; a nested scroller inside a single-axis host hides every sibling, including
the toolbar and the unsaved-draft indicator.

**Scroll from `FileView`'s root without making the header sticky.** Rejected:
a non-sticky header would scroll away with the content (only the footer's
external-open action stays in view), so the Save/Diff controls would still be
unreachable until scrolling back to top.

**A fixed header taller than one row.** Rejected for scope: the request is that
the existing header stay put, not grow it; a multi-row pinned chrome changes the
toolbar's layout and is a separate follow-up.

## Consequences

With content longer than the view, wheel over the body scrolls it while the path
and View/Edit/Diff controls remain pinned at the top — the Save button (and its
conflict-reload link) stay reachable without scrolling back up. Short files are
unchanged: the root has just enough to fill the column and the header sits at
`top: 0` exactly where it did before. The sticky strip carries a `background` so
content below is not revealed behind it while its own border-bottom line reads as
the tab's divider. Nested view scrollers under this host stay suppressed, so any
future view that adds one (e.g. an image viewer) must opt into the same single
scrollport rather than introducing a second hidden one.
