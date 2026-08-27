/** Authorization-flow registry baseline, pushed live state, and unary-action owner. */

import type {
  AuthorizationEntry, AuthorizationNotice, HostFrame, IApiClient, RpcError, RpcId, RpcRequest, WireAuthorizationPrompt,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import type { AuthorizationKeyState, AuthorizationListState } from '../contract/authorization.ts'
import { Notifier } from '../sessions/notifier.ts'

/** Authorization object cluster driven by one list baseline and pushed host frames. */
export class AuthorizationManager {
  private entries: readonly AuthorizationEntry[] = []
  private state: AuthorizationListState['state'] = 'idle'
  private byKey = new Map<CredentialKey, AuthorizationKeyState>()
  private inflight: Promise<void> | null = null
  private snapshotCache: AuthorizationListState
  private readonly notifier = new Notifier(() => {
    this.snapshotCache = this.buildSnapshot()
  })

  /** @param api - shared wire client. */
  constructor(private readonly api: IApiClient) {
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * uSES subscription entry.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Current immutable snapshot (rebuilds lazily when dirty and unobserved).
   * @returns the current authorization list state.
   */
  getSnapshot(): AuthorizationListState {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  /**
   * Refresh from authorization.list. Shared in-flight across concurrent callers,
   * same posture as WorkspaceManager.refresh.
   * @returns the shared in-flight refresh.
   */
  refresh(): Promise<void> {
    if (this.inflight !== null) return this.inflight
    this.state = 'loading'
    this.notifier.markDirty()
    this.inflight = (async () => {
      try {
        const { result } = await this.api.authorization.list({})
        if (result.ok) {
          this.entries = result.value.entries
          // A fresh baseline is the definitive inFlight bit for every key it
          // names; a key this process has no live push state for yet still
          // needs its baseline inFlight recorded, so entries absent from
          // byKey are seeded rather than left to read as "never attempted".
          for (const entry of this.entries) {
            const existing = this.byKey.get(entry.key)
            if (existing === undefined) {
              this.byKey.set(entry.key, { inFlight: entry.inFlight, notices: [], pendingPrompt: undefined })
            } else if (existing.inFlight !== entry.inFlight) {
              this.byKey.set(entry.key, { ...existing, inFlight: entry.inFlight })
            }
          }
          this.state = 'loaded'
        } else {
          this.state = 'error'
        }
      } catch {
        this.state = 'error'
      } finally {
        this.inflight = null
        this.notifier.markDirty()
      }
    })()
    return this.inflight
  }

  /** The live per-key state, defaulting to idle for a key never attempted. */
  private keyState(key: CredentialKey): AuthorizationKeyState {
    return this.byKey.get(key) ?? { inFlight: false, notices: [], pendingPrompt: undefined }
  }

  private setKeyState(key: CredentialKey, next: AuthorizationKeyState): void {
    this.byKey.set(key, next)
    this.notifier.markDirty()
  }

  /**
   * Start an attempt. `begin`'s ack means only "started", not "finished" — the
   * attempt's own notices/prompts/settlement all arrive as host frames.
   * @param key - the credential record to authorize.
   * @param method - which of the flow's methods to run.
   * @throws {AuthorizationRequestError} when the host rejects the start (already in flight, unknown key/method).
   */
  async begin(key: CredentialKey, method?: string): Promise<void> {
    const { result } = await this.api.authorization.begin({ key, ...method === undefined ? {} : { method } })
    if (!result.ok) throw new AuthorizationRequestError(result.error)
    this.setKeyState(key, { ...this.keyState(key), inFlight: true, notices: [] })
  }

  /**
   * Withdraw the attempt running for a key, if any.
   * @param key - target credential record.
   */
  async cancel(key: CredentialKey): Promise<void> {
    await this.api.authorization.cancel({ key })
  }

  /**
   * Answer a pending prompt.
   * @param rpcId - the prompt's own id.
   * @param answer - the typed text, or the chosen option's id.
   */
  async respondPrompt(rpcId: RpcId, answer: string): Promise<void> {
    const key = this.keyForPendingPrompt(rpcId)
    if (key === undefined) return
    await this.api.respond({
      type: 'client-response', rpcId, result: { ok: true, value: { key, answer } },
    })
  }

  /**
   * Decline a pending prompt.
   * @param rpcId - the prompt's own id.
   */
  async declinePrompt(rpcId: RpcId): Promise<void> {
    if (this.keyForPendingPrompt(rpcId) === undefined) return
    await this.api.respond({
      type: 'client-response',
      rpcId,
      result: { ok: false, error: { code: 'cancelled', message: 'the authorization prompt was declined', details: {} } },
    })
  }

  /** The key whose pending prompt carries this rpcId, if any is still pending. */
  private keyForPendingPrompt(rpcId: RpcId): CredentialKey | undefined {
    for (const [key, state] of this.byKey) {
      if (state.pendingPrompt?.rpcId === rpcId) return key
    }
    return undefined
  }

  /**
   * Host-frame entry: live per-key notice/prompt push state.
   * @param envelope - the frame with its wire rpcId.
   */
  handleHostEnvelope(envelope: RpcRequest<HostFrame>): void {
    const frame = envelope.payload
    if (frame.type === 'authorization/notice') {
      this.applyNotice(frame.key, frame.notice)
    } else if (frame.type === 'authorization/prompt-requested') {
      this.applyPromptRequested(frame.key, envelope.rpcId, frame.prompt)
    } else if (frame.type === 'authorization/prompt-resolved') {
      this.applyPromptResolved(frame.key)
    }
  }

  private applyNotice(key: CredentialKey, notice: AuthorizationNotice): void {
    const current = this.keyState(key)
    this.setKeyState(key, { ...current, inFlight: true, notices: [...current.notices, notice] })
  }

  private applyPromptRequested(key: CredentialKey, rpcId: RpcId, prompt: WireAuthorizationPrompt): void {
    const current = this.keyState(key)
    this.setKeyState(key, { ...current, inFlight: true, pendingPrompt: { rpcId, prompt } })
  }

  private applyPromptResolved(key: CredentialKey): void {
    const current = this.keyState(key)
    if (current.pendingPrompt === undefined) return
    this.setKeyState(key, { ...current, pendingPrompt: undefined })
  }

  /**
   * A running attempt for this key has finished (authorized, cancelled, or
   * failed): clear its transient push state. Entries is left to the next
   * `refresh()` for the authoritative `inFlight` bit — a settled event alone
   * cannot distinguish "authorized" from a route that still needs `apiKeyEnv`
   * configured, which only a fresh `describe`/`list` answers.
   * @param key - the credential record whose attempt settled.
   */
  handleSettled(key: CredentialKey): void {
    const current = this.byKey.get(key)
    if (current === undefined) return
    this.setKeyState(key, { inFlight: false, notices: [], pendingPrompt: undefined })
  }

  private buildSnapshot(): AuthorizationListState {
    return {
      entries: this.entries,
      state: this.state,
      byKey: Object.fromEntries(this.byKey),
    }
  }
}

/** Structured `authorization.begin` failure so callers can branch on the host's business error. */
export class AuthorizationRequestError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(`authorization request failed: ${rpcError.code}: ${rpcError.message}`)
    this.name = 'AuthorizationRequestError'
  }
}
