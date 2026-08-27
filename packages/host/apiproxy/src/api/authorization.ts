/**
 * authorization domain contract: the web face of the authorization capability
 * seam (`ctx.authorization`). `begin` acks once the flow has started rather
 * than once it finishes — a human clicking through an OAuth consent page can
 * take minutes — and the flow's notices, prompts, and settlement ride the
 * host event stream (`authorization/notice`, `authorization/prompt-requested`,
 * `authorization/prompt-resolved` frames; `authorization/settled` forwarded
 * verbatim). A prompt is answered through `respond`, the same mechanism
 * approvals and questions use.
 */

import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import type { AuthorizationEntry, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

export type {
  AuthorizationEntry, AuthorizationMethod, AuthorizationNotice, AuthorizationPrompt,
  AuthorizationPromptOption,
} from '@deepseek-ai/dsh-authorization/types'

/** `Omit`, applied per union member instead of to the flattened union (TS's built-in `Omit` is not distributive). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/**
 * `AuthorizationPrompt` without its `signal` field, distributed over the
 * `kind` union member-by-member: the plain (non-distributive) `Omit` would
 * collapse the union into one flattened object type, losing `kind`-based
 * narrowing (`prompt.kind === 'select'` would no longer see `options`) — a
 * wire prompt still needs its `kind` to discriminate `text`/`secret`/`select`.
 */
export type WireAuthorizationPrompt = DistributiveOmit<AuthorizationPrompt, 'signal'>

/** Authorization-domain unary methods (the map keys authorization.* of RpcMethodMap). */
export interface AuthorizationApi {
  /** Every registered flow, for a surface listing what can be authorized. */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ entries: AuthorizationEntry[] }>>

  /**
   * Start one attempt. Rejected synchronously with `authorization-not-found`
   * when no flow claims `key` (or `key`'s flow offers no such `method`) and
   * `authorization-in-flight` when an attempt for `key` is already running.
   * Otherwise acks immediately; the attempt's notices, prompts, and eventual
   * settlement all ride the host event stream, not this response.
   */
  begin(request: RpcRequest<{ key: CredentialKey; method?: string }>): Promise<RpcResponse<{ accepted: true }>>

  /** Withdraw the attempt running for a key, if any (idempotent). */
  cancel(request: RpcRequest<{ key: CredentialKey }>): Promise<RpcResponse<{}>>
}

/**
 * Authorization prompt answer payload (the result.value slot of a
 * client-response). Correlated against the pending entry's own `key`, the
 * same audit-correlation posture `ApprovalResponsePayload` uses.
 */
export interface AuthorizationPromptResponsePayload {
  /** The credential record the answered prompt's attempt is authorizing. */
  key: CredentialKey
  /** The typed text, or the chosen option's id for a `select` prompt. */
  answer: string
}
