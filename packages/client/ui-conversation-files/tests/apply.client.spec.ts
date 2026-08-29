// @vitest-environment jsdom
/** File conversation-view inject factory exercised over independently mounted Conversation and File plugins. */
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, stubSettingsScope, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import {
  apply as applyConversation, inject as injectConversation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyFile, inject as injectFile, type FileViewInjected } from '@deepseek-ai/dsh-client-ui-conversation-files/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

usePinnedBrowserLanguages('en')

const ROOT = 'root-1' as SessionId
const ORPHAN = 'orphan-1' as SessionId
const WORKSPACE = 'ws-1' as WorkspaceId

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  runtime.ctx.provide('uiWorkspace', { connectWorkspace: vi.fn(async () => WORKSPACE) } as never)
  runtime.workspaces.list.update((draft) => {
    draft.items = [...draft.items, {
      workspaceId: WORKSPACE,
      path: '/proj',
      title: 'proj',
      sessionIds: [ROOT],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }]
  })
  await runtime.sessions.add({
    id: ROOT,
    summary: { title: 'R', displayTitle: 'R', cwd: '/proj' },
    session: {},
  }, { current: false })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({
    'conversation': { kind: 'single', scope: 'session-maybe' },
  }, (_props: { renderSlot?: unknown }) => null)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  await runtime.mount({ inject: [...injectFile], apply: applyFile })
  runtime.renderRoot()

  const injectedFor = (sessionId: SessionId): FileViewInjected => {
    const entry = runtime.slots.entries('conversation.view')[0]!
    return (entry.inject as unknown as (id: SessionId) => FileViewInjected)(sessionId)
  }
  return { runtime, injectedFor }
}

describe('File view inject API', () => {
  it('resolves workspace file/git RPCs against the session\'s owning Workspace', async () => {
    const b = await bench()
    const injected = b.injectedFor(ROOT)

    await injected.readFile('src/a.ts')
    expect(b.runtime.workspaces.calls).toContainEqual({ method: 'readFile', args: [WORKSPACE, 'src/a.ts', undefined] })

    await injected.getGitStatus()
    expect(b.runtime.workspaces.calls).toContainEqual({ method: 'gitStatus', args: [WORKSPACE, undefined] })

    await injected.getFileDiff('src/a.ts')
    expect(b.runtime.workspaces.calls).toContainEqual({ method: 'gitFileDiff', args: [WORKSPACE, 'src/a.ts', undefined] })

    await injected.writeFile('src/a.ts', 'content', 1 as never)
    expect(b.runtime.workspaces.calls).toContainEqual({
      method: 'writeFile', args: [WORKSPACE, 'src/a.ts', 'content', 1, undefined],
    })
    await b.runtime.dispose()
  })

  it('rejects file/git RPCs for a session with no owning Workspace', async () => {
    const b = await bench()
    const injected = b.injectedFor(ORPHAN)

    await expect(injected.readFile('src/a.ts')).rejects.toThrow(/no owning workspace/)
    await expect(injected.getGitStatus()).rejects.toThrow(/no owning workspace/)
    await expect(injected.getFileDiff('src/a.ts')).rejects.toThrow(/no owning workspace/)
    await expect(injected.writeFile('src/a.ts', 'content', 1 as never)).rejects.toThrow(/no owning workspace/)
    await b.runtime.dispose()
  })

  it('opens a path through the Session Controller and surfaces a failed open', async () => {
    const b = await bench()
    const injected = b.injectedFor(ROOT)

    await injected.openPath('src/a.ts')
    expect(b.runtime.sessions.calls).toContainEqual(
      expect.objectContaining({ method: 'openWorkspacePath', args: ['src/a.ts', expect.any(AbortSignal)] }),
    )

    vi.spyOn(b.runtime.sessions, 'openWorkspacePath').mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal', message: 'xdg-open is not available', details: {} },
    })
    await expect(injected.openPath('src/b.ts')).rejects.toThrow('path open failed: xdg-open is not available')
    await b.runtime.dispose()
  })
})
