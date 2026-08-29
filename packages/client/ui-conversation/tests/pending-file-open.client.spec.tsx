// @vitest-environment jsdom
// ConversationSession's cross-plugin file-open drain: the pendingFileOpen
// hook (fed by the conversationFileOpener service's registry, see
// files/file-opener.ts) calls the injected openFile callback, which the real
// wiring backs with conversationStore's openView('file', path) action — the
// active view ring then receives the resulting viewRequest as its one-shot
// owner prop (mirrors the existing inspect/onInspectDone handoff).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector, sessionSnapshot as sessionFixture } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionSnapshot, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { ConversationSessionSlotProps } from '../src/client/contract/slots.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { EMPTY_CONVERSATION_SNAPSHOT } from '../src/client/contract/snapshot.ts'
import { createConversationStore } from '../src/client/stores.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { ConversationSession } from '../src/client/skeleton/ConversationSession.tsx'
import type { ConvViewOwnerProps } from '../src/client/contract/slots.ts'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const SID = sid('s1')

const workspaces: WorkspaceSnapshot = { items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null }

/** Minimal fixture: only what ConversationSession's own runtime share needs. */
function fixture() {
  const session = createSnapshotStore<SessionSnapshot>(sessionFixture(SID))
  const conversation = createSnapshotStore(EMPTY_CONVERSATION_SNAPSHOT)
  const store = createConversationStore().create()
  const sink = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
  const wiring = new SessionInputShell({
    actx: {} as never, defaultSink: sink,
    commandImages: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: (token: string) => `${token.trim()} images-unsupported` },
  })
  const sessionsState = createSnapshotStore<SessionListState>({
    ids: [SID], byId: { [SID]: { id: SID, displayTitle: 'S', running: false, blank: false, updatedAt: 1 } },
    current: SID, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const owners: ConvViewOwnerProps[] = []
  const renderSlot = ((_key: string, owner: ConvViewOwnerProps) => {
    owners.push(owner)
    return null
  }) as never
  const useChat: ConversationSessionSlotProps['useChat'] = () => { throw new Error('unused') }
  const useTrajectory: ConversationSessionSlotProps['useTrajectory'] = () => { throw new Error('unused') }
  const element = (pending: { path: string; seq: number } | undefined) => (
    <ConversationSession
      sessionId={SID}
      SessionProvider={({ children }) => children}
      useSession={bindSnapshotSelector(session)}
      useConversation={bindSnapshotSelector(conversation)}
      useChat={useChat}
      useTrajectory={useTrajectory}
      useConversationViews={selector => selector([{ id: 'chat', label: 'Chat' }])}
      useSessions={bindSnapshotSelector(sessionsState)}
      useSessionPendingInteraction={bindSnapshotSelector(
        createSnapshotStore<SessionPendingInteractionSnapshot>(new Map()),
      )}
      useWorkspaces={bindSnapshotSelector(createSnapshotStore(workspaces))}
      useProjection={(() => undefined)}
      useInput={bindSnapshotSelector(wiring.state)}
      inputActions={wiring.actions}
      useStore={bindSnapshotSelector(store)}
      actions={store.actions}
      renderSlot={renderSlot}
      bindDraftMirror={write => wiring.bindMirror(write)}
      usePendingFileOpen={select => select(pending)}
      openFile={(path) => { store.actions.openView('file', path) }}
    />
  )
  return { store, owners, element }
}

describe('ConversationSession pendingFileOpen drain', () => {
  it('leaves the store untouched while no request is pending', () => {
    const { store, owners, element } = fixture()
    render(element(undefined))
    expect(store.store.getSnapshot().viewRequest).toBeNull()
    expect(store.store.getSnapshot().view).toBeNull()
    expect(owners[0]?.viewRequest).toBeNull()
  })

  it('writes a viewRequest and switches the active view to file on a pending request', () => {
    const { store, owners, element } = fixture()
    render(element({ path: '/ws/notes.txt', seq: 0 }))
    expect(store.store.getSnapshot().viewRequest).toEqual({ view: 'file', focus: '/ws/notes.txt' })
    expect(store.store.getSnapshot().view).toBe('file')
    expect(owners.at(-1)?.viewRequest).toEqual({ view: 'file', focus: '/ws/notes.txt' })
  })

  it('re-applies on a new seq for the same path (re-click while already showing it)', () => {
    const { store, element } = fixture()
    const { rerender } = render(element({ path: '/ws/notes.txt', seq: 0 }))
    expect(store.store.getSnapshot().viewRequest).toEqual({ view: 'file', focus: '/ws/notes.txt' })
    act(() => { store.actions.setView('chat') }) // simulate the user switching away
    rerender(element({ path: '/ws/notes.txt', seq: 1 }))
    expect(store.store.getSnapshot().view).toBe('file')
  })
})
