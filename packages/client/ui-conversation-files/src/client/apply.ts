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
  const workspaces = ctx.get('workspaces')
  const resolveOwningWorkspaceId = (targetSessionId: SessionId) =>
    workspaces?.list.getSnapshot().items.find(item => item.sessionIds.includes(targetSessionId))?.workspaceId

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'file',
    order: 5,
    label: () => t('view.file'),
    locale: 'conversation',
    inject: (sessionId: SessionId): FileViewInjected => ({
      readFile: (path, signal) => {
        const workspaceId = resolveOwningWorkspaceId(sessionId)
        if (workspaceId === undefined || workspaces === undefined) {
          return Promise.reject(new Error(`ui-conversation-files: session "${sessionId}" has no owning workspace`))
        }
        return workspaces.readFile(workspaceId, path, signal)
      },
      openPath: async (path) => {
        const result = await sessions.openWorkspacePath(path, new AbortController().signal)
        if (!result.ok) throw new Error(`ui-conversation-files: path open failed: ${result.error.message}`)
      },
      getGitStatus: (signal) => {
        const workspaceId = resolveOwningWorkspaceId(sessionId)
        if (workspaceId === undefined || workspaces === undefined) {
          return Promise.reject(new Error(`ui-conversation-files: session "${sessionId}" has no owning workspace`))
        }
        return workspaces.gitStatus(workspaceId, signal)
      },
      getFileDiff: (path, signal) => {
        const workspaceId = resolveOwningWorkspaceId(sessionId)
        if (workspaceId === undefined || workspaces === undefined) {
          return Promise.reject(new Error(`ui-conversation-files: session "${sessionId}" has no owning workspace`))
        }
        return workspaces.gitFileDiff(workspaceId, path, signal)
      },
      writeFile: (path, content, expectedVersion, signal) => {
        const workspaceId = resolveOwningWorkspaceId(sessionId)
        if (workspaceId === undefined || workspaces === undefined) {
          return Promise.reject(new Error(`ui-conversation-files: session "${sessionId}" has no owning workspace`))
        }
        return workspaces.writeFile(workspaceId, path, content, expectedVersion, signal)
      },
    }),
  }, FileView))
}
