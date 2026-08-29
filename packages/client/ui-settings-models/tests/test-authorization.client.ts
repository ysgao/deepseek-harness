/**
 * Test-owned authorization face: the renderer standard-kit observable plus
 * recorded actions. `IAuthorization` has no shared cross-package client
 * facade (see `../src/client/authorization-runtime.ts`), so unlike
 * `TestWorkspaces` this double lives beside its sole consumer's tests instead
 * of in `@deepseek-ai/dsh-client-test-runtime`.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import type { AuthorizationListState, IAuthorization } from '../src/client/authorization-runtime.ts'

/** One act-wrapper the owning runtime uses to flush a state update through React. */
type Stabilizer = (fn: () => void | Promise<void>) => Promise<void>

/**
 * Authorization test double. Implements the same {@link IAuthorization} face
 * features receive as `ctx.authorization`, so a production face change
 * breaks this double at compile time. Every action records into {@link
 * TestAuthorization.calls}; defaults are inert (no registered flows) —
 * feature tests needing a registered flow install one via {@link
 * TestAuthorization.update} and stub the actions that would drive it.
 */
export class TestAuthorization implements IAuthorization {
  /** The Sign-in surface's standard feed. */
  readonly list = createSnapshotStore<AuthorizationListState>({ entries: [], state: 'loaded', byKey: {} })

  /** Calls observed on the action face, newest last. */
  readonly calls: { method: string; args: unknown[] }[] = []

  /** Replaceable action seat: feature tests may stub richer behavior. */
  private readonly stubs = new Map<string, (...args: unknown[]) => unknown>()

  /** @param stabilize - the owning runtime's act wrapper. */
  constructor(private readonly stabilize: Stabilizer) {}

  /**
   * Update the authorization list state through an immer draft.
   * @param mutate - draft mutator.
   */
  async update(mutate: (draft: AuthorizationListState) => void): Promise<void> {
    await this.stabilize(() => { this.list.update(mutate) })
  }

  /**
   * Replace an action's behavior (the recorded call is still appended first).
   * @param method - action name (e.g. 'begin').
   * @param impl - replacement behavior.
   */
  stub(method: string, impl: (...args: unknown[]) => unknown): void {
    this.stubs.set(method, impl)
  }

  /** Reload the registered-flow list (recorded; default no-op — the double's list is set directly via {@link update}). */
  async refreshEntries(): Promise<void> {
    this.calls.push({ method: 'refreshEntries', args: [] })
    await (this.stubs.get('refreshEntries')?.() as Promise<void> | undefined)
  }

  /**
   * Start an attempt (recorded; default no-op).
   * @param key - target credential record.
   * @param method - chosen flow method.
   */
  async begin(key: CredentialKey, method?: string): Promise<void> {
    this.calls.push({ method: 'begin', args: [key, method] })
    await (this.stubs.get('begin')?.(key, method) as Promise<void> | undefined)
  }

  /**
   * Withdraw the running attempt for a key (recorded; default no-op).
   * @param key - target credential record.
   */
  async cancel(key: CredentialKey): Promise<void> {
    this.calls.push({ method: 'cancel', args: [key] })
    await (this.stubs.get('cancel')?.(key) as Promise<void> | undefined)
  }

  /**
   * Answer the prompt pending for a key (recorded; default no-op).
   * @param key - the credential record whose prompt is being answered.
   * @param answer - the typed text, or the chosen option's id.
   */
  async respondPrompt(key: CredentialKey, answer: string): Promise<void> {
    this.calls.push({ method: 'respondPrompt', args: [key, answer] })
    await (this.stubs.get('respondPrompt')?.(key, answer) as Promise<void> | undefined)
  }

  /**
   * Decline the prompt pending for a key (recorded; default no-op).
   * @param key - the credential record whose prompt is being answered.
   */
  async declinePrompt(key: CredentialKey): Promise<void> {
    this.calls.push({ method: 'declinePrompt', args: [key] })
    await (this.stubs.get('declinePrompt')?.(key) as Promise<void> | undefined)
  }

  /**
   * Report a key's attempt settled (recorded; default no-op).
   * @param key - the credential record whose attempt settled.
   */
  notifySettled(key: CredentialKey): void {
    this.calls.push({ method: 'notifySettled', args: [key] })
    this.stubs.get('notifySettled')?.(key)
  }
}
