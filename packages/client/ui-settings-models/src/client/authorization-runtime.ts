/**
 * Real client-side authorization face: drives `ctx.remote.authorization`
 * (the `AuthorizationController` Host Remote namespace) and projects its
 * state for the web Sign-in affordance. This package is the sole consumer,
 * so unlike Workspace/Session there is no shared cross-package client
 * facade — the state lives here, next to the UI that reads it.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthorizationEntry, AuthorizationNotice } from '@deepseek-ai/dsh-authorization/types'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import type { AuthorizationStreamFrame, WireAuthorizationPrompt } from '@deepseek-ai/dsh-api-settings-controller/types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Real client-side authorization face; see {@link IAuthorization}. */
    authorization: IAuthorization
  }
}

/** One pending answerable prompt from a running authorization attempt. */
export interface AuthorizationPendingPrompt {
  readonly prompt: WireAuthorizationPrompt
}

/** Live state of one credential key's authorization flow. */
export interface AuthorizationKeyState {
  /** Whether an attempt for this key is running right now (in this process or another tab). */
  readonly inFlight: boolean
  /** Notices accumulated since the attempt began; cleared when it settles. */
  readonly notices: readonly AuthorizationNotice[]
  /** The one prompt currently awaiting an answer, if any. */
  readonly pendingPrompt: AuthorizationPendingPrompt | undefined
}

/** Every registered flow plus live per-key attempt state. */
export interface AuthorizationListState {
  entries: readonly AuthorizationEntry[]
  state: 'idle' | 'loading' | 'loaded' | 'error'
  /** Live state keyed by `CredentialKey`; absent means idle/never attempted. */
  byKey: Record<string, AuthorizationKeyState>
}

/** The authorization-service face injected as `ctx.authorization`. */
export interface IAuthorization {
  /** Every registered flow plus live per-key attempt state (loads lazily on first `refreshEntries`). */
  readonly list: SnapshotStore<AuthorizationListState>
  /** (Re)load the registered-flow list from the Host. */
  refreshEntries(): Promise<void>
  /**
   * Start an attempt for one key. Resolves once the attempt settles (a human
   * clicking through a consent page can take minutes) — its notices and
   * prompts arrive as pushed state on {@link IAuthorization.list} in the
   * meantime.
   * @param key - the credential record to authorize.
   * @param method - which of the flow's methods to run; omitted picks its first.
   */
  begin(key: CredentialKey, method?: string): Promise<void>
  /** Withdraw the attempt running for a key, if any (idempotent). */
  cancel(key: CredentialKey): Promise<void>
  /**
   * Answer the prompt pending for a key.
   * @param key - the credential record whose prompt is being answered.
   * @param answer - the typed text, or the chosen option's id for a `select` prompt.
   */
  respondPrompt(key: CredentialKey, answer: string): Promise<void>
  /**
   * Decline the prompt pending for a key — the human dismissed it without answering.
   * @param key - the credential record whose prompt is being answered.
   */
  declinePrompt(key: CredentialKey): Promise<void>
  /**
   * Report that a key's running attempt has settled (authorized, cancelled,
   * or failed): clears its transient notice/prompt state. `authorization/settled`
   * rides the generic forwarded-event channel, so this plugin (already
   * bridging `ctx.remote.$on` for its own refresh needs) reports it here.
   * @param key - the credential record whose attempt settled.
   */
  notifySettled(key: CredentialKey): void
}

const IDLE_KEY_STATE: AuthorizationKeyState = { inFlight: false, notices: [], pendingPrompt: undefined }

/** The generated `ctx.remote.authorization` namespace's Client method shapes this runtime drives. */
export type AuthorizationRemote = TypertClientRemote['authorization']

/** Real authorization object layer, backing `ctx.authorization`. */
export class AuthorizationRuntime extends Service implements IAuthorization {
  readonly list: SnapshotStore<AuthorizationListState>

  /**
   * @param ctx - client root context; owns the follow-stream's lifetime.
   * @param remote - the generated `ctx.remote.authorization` namespace.
   */
  constructor(ctx: Context, private readonly remote: AuthorizationRemote) {
    super(ctx, 'authorization')
    this.list = createSnapshotStore<AuthorizationListState>({ entries: [], state: 'idle', byKey: {} })
    const controller = new AbortController()
    ctx.effect(() => {
      void this.pump(controller.signal)
      return () => { controller.abort() }
    }, 'ui-settings-models: authorization follow stream')
  }

  /** @inheritdoc */
  async refreshEntries(): Promise<void> {
    this.list.update((draft) => { draft.state = 'loading' })
    try {
      const result = await this.remote.list()
      if (!result.ok) {
        this.list.update((draft) => { draft.state = 'error' })
        return
      }
      this.list.update((draft) => {
        draft.entries = result.value
        draft.state = 'loaded'
      })
    } catch {
      this.list.update((draft) => { draft.state = 'error' })
    }
  }

  /** @inheritdoc */
  async begin(key: CredentialKey, method?: string): Promise<void> {
    await this.remote.begin(key, method)
  }

  /** @inheritdoc */
  async cancel(key: CredentialKey): Promise<void> {
    await this.remote.cancel(key)
  }

  /** @inheritdoc */
  async respondPrompt(key: CredentialKey, answer: string): Promise<void> {
    await this.remote.respond(key, answer)
  }

  /** @inheritdoc */
  async declinePrompt(key: CredentialKey): Promise<void> {
    await this.remote.respond(key, undefined)
  }

  /** @inheritdoc */
  notifySettled(key: CredentialKey): void {
    this.list.update((draft) => {
      if (draft.byKey[key] !== undefined) draft.byKey[key] = IDLE_KEY_STATE
    })
  }

  /** Drain the shared `follow` stream into per-key live state until aborted. */
  private async pump(signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of this.remote.follow(signal)) {
        this.applyFrame(frame)
      }
      /* v8 ignore next 3 -- abort is the only production exit; nothing else closes the shared stream. */
    } catch (error) {
      if (!signal.aborted) throw error
    }
  }

  private applyFrame(frame: AuthorizationStreamFrame): void {
    this.list.update((draft) => {
      const existing = draft.byKey[frame.key] ?? IDLE_KEY_STATE
      switch (frame.type) {
        case 'notice':
          draft.byKey[frame.key] = { ...existing, inFlight: true, notices: [...existing.notices, frame.notice] }
          return
        case 'prompt-requested':
          draft.byKey[frame.key] = { ...existing, inFlight: true, pendingPrompt: { prompt: frame.prompt } }
          return
        case 'prompt-resolved':
          draft.byKey[frame.key] = { ...existing, pendingPrompt: undefined }
      }
    })
  }
}
