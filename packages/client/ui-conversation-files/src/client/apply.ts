/** Registers the File conversation-view tab. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
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
  //
  // `requestedWorkspaceId` comes from the opener (e.g. the Workspace Files
  // tree, which always knows its own workspace) and is used as-is when
  // present. Only a requester with no workspace of its own (e.g. a chat
  // message's file mention, which only has a sessionId) falls back to
  // deriving it from the session's membership in a workspace's roster — a
  // derivation that misses for a session not yet reflected there, unlike the
  // direct id.
  const resolveWorkspace = (targetSessionId: SessionId, requestedWorkspaceId: WorkspaceId | undefined) => {
    const workspaces = ctx.get('workspaces')
    if (workspaces === undefined) return undefined
    const workspaceId = requestedWorkspaceId ?? workspaces.list.getSnapshot().items
      .find(item => item.sessionIds.includes(targetSessionId))?.workspaceId
    return workspaceId === undefined ? undefined : { workspaceId, workspaces }
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'file',
    order: 5,
    label: () => t('view.file'),
    locale: 'conversation',
    inject: (sessionId: SessionId): FileViewInjected => ({
      readFile: (workspaceId, path, signal) => {
        const owner = resolveWorkspace(sessionId, workspaceId)
        if (owner === undefined) {
          return Promise.reject(new Error(`ui-conversation-files: session "${sessionId}" has no owning workspace`))
        }
        return owner.workspaces.readFile(owner.workspaceId, path, signal)
      },
      openPath: async (path) => {
        const result = await sessions.openWorkspacePath(path, new AbortController().signal)
        if (!result.ok) throw new Error(`ui-conversation-files: path open failed: ${result.error.message}`)
      },
      getGitStatus: (workspaceId, signal) => {
        const owner = resolveWorkspace(sessionId, workspaceId)
        if (owner === undefined) {
          return Promise.reject(new Error(`ui-conversation-files: session "${sessionId}" has no owning workspace`))
        }
        return owner.workspaces.gitStatus(owner.workspaceId, signal)
      },
      getFileDiff: (workspaceId, path, signal) => {
        const owner = resolveWorkspace(sessionId, workspaceId)
        if (owner === undefined) {
          return Promise.reject(new Error(`ui-conversation-files: session "${sessionId}" has no owning workspace`))
        }
        return owner.workspaces.gitFileDiff(owner.workspaceId, path, signal)
      },
      writeFile: (workspaceId, path, content, expectedVersion, signal) => {
        const owner = resolveWorkspace(sessionId, workspaceId)
        if (owner === undefined) {
          return Promise.reject(new Error(`ui-conversation-files: session "${sessionId}" has no owning workspace`))
        }
        return owner.workspaces.writeFile(owner.workspaceId, path, content, expectedVersion, signal)
      },
    }),
  }, FileView))
}
