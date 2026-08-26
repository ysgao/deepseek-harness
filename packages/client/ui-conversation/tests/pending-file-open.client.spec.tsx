// @vitest-environment jsdom
// ConversationSession's cross-plugin file-open drain: the pendingFileOpen
// hook (fed by the conversationFileOpener service's registry, see
// files/file-opener.ts) writes chatStore's openFilePath/view fields, and the
// active view ring receives them as the one-shot openFilePath/onFileOpened
// owner props (mirrors the existing inspect/onInspectDone handoff).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import {
  createSnapshotStore, EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot, SessionId, SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createChatStore } from '../src/client/stores.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { ConversationSession } from '../src/client/skeleton/ConversationSession.tsx'
import type { ConvViewOwnerProps } from '../src/client/contract/slots.ts'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const SID = sid('s1')

function snapshot(): ConversationSnapshot {
  return {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false,
    promptError: null, blank: false, subagent: null, lastAgentError: null,
  }
}

/** Minimal fixture: only what ConversationSession's own runtime share needs. */
function fixture() {
  const session = createSnapshotStore<ConversationSnapshot>(snapshot())
  const chat = createChatStore().create()
  const sink = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
  const wiring = new SessionInputShell({
    actx: {} as ClientContext, defaultSink: sink,
    commandImages: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: (token: string) => `${token.trim()} images-unsupported` },
  })
  const sessionsState = createSnapshotStore<SessionListState>({
    ids: [SID], byId: { [SID]: { id: SID, displayTitle: 'S', running: false, blank: false, updatedAt: 1 } },
    current: SID, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const workspacesState = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  const owners: ConvViewOwnerProps[] = []
  const renderSlot = ((_key: string, owner: ConvViewOwnerProps) => {
    owners.push(owner)
    return null as ReactNode
  }) as never
  const element = (pending: { path: string; seq: number } | undefined) => (
    <ConversationSession
      sessionId={SID}
      SessionProvider={({ children }) => children(SID)}
      useSession={bindSnapshotSelector(session)}
      useSessions={bindSnapshotSelector(sessionsState)}
      useWorkspaces={bindSnapshotSelector(workspacesState)}
      useProjection={(() => undefined)}
      useInput={bindSnapshotSelector(wiring.state)}
      inputActions={wiring.actions}
      useStore={bindSnapshotSelector(chat)}
      actions={chat.actions}
      renderSlot={renderSlot}
      views={{ list: () => [{ id: 'chat', label: 'Chat' }], subscribe: () => () => {}, version: () => 1 }}
      releaseSessionImages={vi.fn()}
      bindDraftMirror={write => wiring.bindMirror(write)}
      usePendingFileOpen={select => select(pending)}
    />
  )
  return { chat, owners, element }
}

describe('ConversationSession pendingFileOpen drain', () => {
  it('leaves the store untouched while no request is pending', () => {
    const { chat, owners, element } = fixture()
    render(element(undefined))
    expect(chat.store.getSnapshot().openFilePath).toBeNull()
    expect(chat.store.getSnapshot().view).toBeNull()
    expect(owners[0]?.openFilePath).toBeNull()
  })

  it('writes openFilePath and switches the active view to file on a pending request', () => {
    const { chat, owners, element } = fixture()
    render(element({ path: '/ws/notes.txt', seq: 0 }))
    expect(chat.store.getSnapshot().openFilePath).toBe('/ws/notes.txt')
    expect(chat.store.getSnapshot().view).toBe('file')
    expect(owners.at(-1)?.openFilePath).toBe('/ws/notes.txt')
  })

  it('re-applies on a new seq for the same path (re-click while already showing it)', () => {
    const { chat, element } = fixture()
    const { rerender } = render(element({ path: '/ws/notes.txt', seq: 0 }))
    expect(chat.store.getSnapshot().openFilePath).toBe('/ws/notes.txt')
    act(() => { chat.actions.setView('chat') }) // simulate the user switching away
    rerender(element({ path: '/ws/notes.txt', seq: 1 }))
    expect(chat.store.getSnapshot().view).toBe('file')
  })
})
