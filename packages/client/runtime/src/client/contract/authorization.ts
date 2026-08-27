/**
 * The outward authorization-service face — what `ctx.authorization` exposes to
 * feature packages, and therefore exactly what the test runtime's
 * authorization double must implement. The wire-pump entry point
 * (handleHostEnvelope) stays on the concrete class.
 */
import type {
  AuthorizationEntry, AuthorizationNotice, RpcId, WireAuthorizationPrompt,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import type { ObservableSnapshot } from './store.ts'

/** One pending answerable prompt from a running authorization attempt. */
export interface AuthorizationPendingPrompt {
  rpcId: RpcId
  prompt: WireAuthorizationPrompt
}

/** Live state of one credential key's authorization flow. */
export interface AuthorizationKeyState {
  /** Whether an attempt for this key is running right now (in this process or another tab). */
  inFlight: boolean
  /** Notices accumulated since the attempt began; cleared when it settles. */
  notices: readonly AuthorizationNotice[]
  /** The one prompt currently awaiting an answer, if any. */
  pendingPrompt: AuthorizationPendingPrompt | undefined
}

/** Every registered flow plus live per-key attempt state. */
export interface AuthorizationListState {
  entries: readonly AuthorizationEntry[]
  state: 'idle' | 'loading' | 'loaded' | 'error'
  /** Live state keyed by `CredentialKey`; absent means idle/never attempted. */
  byKey: Readonly<Record<string, AuthorizationKeyState>>
}

/** The authorization-service face injected as `ctx.authorization`. */
export interface IAuthorization {
  /** Every registered flow plus live per-key attempt state (loads lazily on first `refreshEntries`). */
  readonly list: ObservableSnapshot<AuthorizationListState>
  /** (Re)load the registered-flow list from the host. */
  refreshEntries(): Promise<void>
  /**
   * Start an attempt for one key. Acks once the attempt has started (or
   * rejects with the host's business error, e.g. already in flight) — the
   * attempt's notices, prompts, and settlement all arrive as pushed state on
   * {@link IAuthorization.list}.
   * @param key - the credential record to authorize.
   * @param method - which of the flow's methods to run; omitted picks its first.
   */
  begin(key: CredentialKey, method?: string): Promise<void>
  /** Withdraw the attempt running for a key, if any (idempotent). */
  cancel(key: CredentialKey): Promise<void>
  /**
   * Answer a pending prompt.
   * @param rpcId - the prompt's own id, from {@link AuthorizationKeyState.pendingPrompt}.
   * @param answer - the typed text, or the chosen option's id for a `select` prompt.
   */
  respondPrompt(rpcId: RpcId, answer: string): Promise<void>
  /**
   * Decline a pending prompt — the human dismissed it without answering.
   * @param rpcId - the prompt's own id, from {@link AuthorizationKeyState.pendingPrompt}.
   */
  declinePrompt(rpcId: RpcId): Promise<void>
  /**
   * Report that a key's running attempt has settled (authorized, cancelled,
   * or failed): clears its transient notice/prompt state. `authorization/settled`
   * rides the generic forwarded-event channel rather than a dedicated
   * HostFrame, so the runtime itself never subscribes to it — the owning
   * feature surface (already bridging `ctx.remote.$on` for its own refresh
   * needs) reports it here instead.
   * @param key - the credential record whose attempt settled.
   */
  notifySettled(key: CredentialKey): void
}
