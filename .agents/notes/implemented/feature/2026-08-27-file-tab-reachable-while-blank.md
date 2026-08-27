# Agent Note: File tab reachable before a session's first turn

Status: implemented

English | [中文](2026-08-27-file-tab-reachable-while-blank.zh.md)

## Problem

`ConversationSession` hides the whole view ring — Chat, File, and Trajectory alike — for any session that hasn't sent its first message yet (`blank && composerPhase === 'blank'` → render `null`; the sibling header hides its title/tab row the same way), replaced by a full-takeover Hero welcome screen (`ConversationRoot.tsx`). This predates the File tab entirely: it was written when the only view was Chat, for which hiding an empty transcript behind a welcome screen makes sense. The File tab's own design note claimed it is "always present... not conditionally shown," but that claim was never checked against a blank session — clicking a file in the Files tree while a session was still blank set the active view to `'file'` and opened the path exactly as designed, but the entire view area stayed hidden behind Hero regardless, so nothing appeared. A workspace file needs no turn to have run to be worth browsing or editing, so this was a real gap, not intended scope.

## Decision

**Exempt only the File tab, gated on the persisted active-view id, not the one-shot `openFilePath` handoff.** Both gates (`ConversationSession`'s early return and `ConversationSessionHeader`'s `hideChrome`) now read `active?.id !== 'file'` alongside the existing blank/composerPhase check. `active.id` comes from the store's persisted `view` field (`setView('file')`, written once by the existing file-open drain effect and never reset elsewhere) — not `openFilePath`, which is a one-shot signal `FileView` clears the instant it acknowledges the handoff, and would have made the tab flash open and immediately re-hide. Chat and Trajectory keep the existing Hero-only behavior: a blank session genuinely has no chat history or tool calls to show, so hiding them behind Hero remains correct there.

The Hero composer coexists with the visible File tab rather than being replaced by it: `ConversationRoot`'s own `hero` computation is untouched, so the welcome card, workspace picker, and textarea still render below the now-visible view area — a user can browse or edit a file and still see the same prompt-to-start affordance.

## Alternatives considered

- **Show the whole view ring whenever the active tab isn't Chat** (also exempting Trajectory). Rejected per explicit product direction: Trajectory has nothing to show for a session with no tool calls yet, so keeping it Hero-hidden avoids an empty-state tab with no real content, unlike File which always has a real workspace path to render.
- **Gate on the one-shot `openFilePath` field directly.** Rejected: it clears to `null` the instant `FileView`'s own effect acknowledges the handoff (its one-shot, re-open-same-path design), so the tab would open and immediately hide again on the very next render.
- **Promote the session out of "blank" on first file open.** Rejected: blank/composerPhase are server-authoritative facts about whether a turn has run; a file open is a client-only, no-turn interaction and must not fabricate a turn having happened.

## Consequences

- `ConversationSessionHeader`/`ConversationSession` (`packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx`) both gained the `active?.id !== 'file'` clause; no other view or component changed.
- `tests/skeleton.client.spec.tsx` gained a case asserting the File tab renders (header visible, tab list includes it, `File` tab selected, content present) once `setView('file')` fires on a blank session, while the pre-existing "hero phase" test (Chat active, blank) is unaffected — confirmed by the full suite still passing.
- Verified end-to-end in a real running instance: a brand-new session with zero messages sent can open a file from the Files tree, view and edit it, while the Hero welcome/composer remains visible underneath.
