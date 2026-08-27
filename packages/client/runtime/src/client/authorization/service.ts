/** AuthorizationRuntime projects the authorization object manager for UI consumers. */

import type { Context } from '@deepseek-ai/cordis'
import type { HostFrame, IApiClient, RpcId, RpcRequest } from '@deepseek-ai/dsh-api-remotes/client'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import type { SnapshotStore } from '../contract/store.ts'
import { createSnapshotStore } from '../contract/store.ts'
import type { AuthorizationListState, IAuthorization } from '../contract/authorization.ts'
import { AuthorizationManager } from './manager.ts'

export { AuthorizationRequestError } from './manager.ts'

/** Real authorization object layer. */
export class AuthorizationRuntime implements IAuthorization {
  /** UI-facing immutable projection; the manager remains wire truth. */
  readonly list: SnapshotStore<AuthorizationListState>
  private readonly manager: AuthorizationManager

  /**
   * @param ctx - client root context.
   * @param api - shared wire client.
   */
  constructor(ctx: Context, api: IApiClient) {
    this.manager = new AuthorizationManager(api)
    this.list = createSnapshotStore<AuthorizationListState>({ entries: [], state: 'idle', byKey: {} })
    this.manager.subscribe(() => { this.list.set(this.manager.getSnapshot()) })
    ctx.reflect.provide('authorization', this, undefined)
  }

  refreshEntries(): Promise<void> {
    return this.manager.refresh()
  }

  begin(key: CredentialKey, method?: string): Promise<void> {
    return this.manager.begin(key, method)
  }

  cancel(key: CredentialKey): Promise<void> {
    return this.manager.cancel(key)
  }

  respondPrompt(rpcId: RpcId, answer: string): Promise<void> {
    return this.manager.respondPrompt(rpcId, answer)
  }

  declinePrompt(rpcId: RpcId): Promise<void> {
    return this.manager.declinePrompt(rpcId)
  }

  notifySettled(key: CredentialKey): void {
    this.manager.handleSettled(key)
  }

  /**
   * Host frame entry, wired alongside sessions/workspaces in the runtime's
   * connection loop.
   * @param envelope - the frame with its wire rpcId.
   */
  handleHostEnvelope(envelope: RpcRequest<HostFrame>): void {
    this.manager.handleHostEnvelope(envelope)
  }
}
