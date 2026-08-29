/** Registers the File conversation-view tab. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only service and declaration merges used by this assembly.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { FileView, type FileViewInjected } from './files/FileView.tsx'

/** Services required by the File view. */
export const inject = ['slots', 'sessions', 'locale']

/**
 * Mount the File conversation-view tab.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('conversation')
  const sessions = ctx.sessions
  // Re-fetched on every call, not cached at apply() time: `workspaces` is an
  // optional cross-package service (see ui-chat's identical `ctx.get(...)`
  // pattern for `conversationFileOpener`) that may not have registered yet
  // when this plugin's own apply() runs — caching it here would freeze it at
  // `undefined` for the plugin's whole lifetime.
  const resolveOwningWorkspace = (targetSessionId: SessionId) => {
    const workspaces = ctx.get('workspaces')
    const workspaceId = workspaces?.list.getSnapshot().items
      .find(item => item.sessionIds.includes(targetSessionId))?.workspaceId
    return workspaceId === undefined || workspaces === undefined ? undefined : { workspaceId, workspaces }
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'file',
    order: 5,
    label: () => t('view.file'),
    locale: 'conversation',
    inject: (sessionId: SessionId): FileViewInjected => ({
      readFile: (path, signal) => {
        const owner = resolveOwningWorkspace(sessionId)
        if (owner === undefined) {
          return Promise.reject(new Error(`ui-conversation-files: session "${sessionId}" has no owning workspace`))
        }
        return owner.workspaces.readFile(owner.workspaceId, path, signal)
      },
      openPath: async (path) => {
        const result = await sessions.openWorkspacePath(path, new AbortController().signal)
        if (!result.ok) throw new Error(`ui-conversation-files: path open failed: ${result.error.message}`)
      },
      getGitStatus: (signal) => {
        const owner = resolveOwningWorkspace(sessionId)
        if (owner === undefined) {
          return Promise.reject(new Error(`ui-conversation-files: session "${sessionId}" has no owning workspace`))
        }
        return owner.workspaces.gitStatus(owner.workspaceId, signal)
      },
      getFileDiff: (path, signal) => {
        const owner = resolveOwningWorkspace(sessionId)
        if (owner === undefined) {
          return Promise.reject(new Error(`ui-conversation-files: session "${sessionId}" has no owning workspace`))
        }
        return owner.workspaces.gitFileDiff(owner.workspaceId, path, signal)
      },
      writeFile: (path, content, expectedVersion, signal) => {
        const owner = resolveOwningWorkspace(sessionId)
        if (owner === undefined) {
          return Promise.reject(new Error(`ui-conversation-files: session "${sessionId}" has no owning workspace`))
        }
        return owner.workspaces.writeFile(owner.workspaceId, path, content, expectedVersion, signal)
      },
    }),
  }, FileView))
}
