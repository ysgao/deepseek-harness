/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

import type { AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization/types'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'

/** Stable settings failure details returned by the `settings` namespace. */
export interface SettingsErrorDetailsMap {
  /**
   * Every seam refusal that is not a stale write: an unregistered or malformed
   * namespace, a read-only provider, schema validation, storage.
   */
  'settings-rejected': { readonly ns: string }
  /**
   * The stored revision moved after the caller read it. Its own outcome rather
   * than an invalid request: the caller must re-read and re-apply.
   */
  'settings-conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
}

/** Settings business failure carried by a rejected Remote call. */
export type SettingsError = {
  [Code in keyof SettingsErrorDetailsMap]: {
    readonly code: Code
    readonly message: string
    readonly details: SettingsErrorDetailsMap[Code]
  }
}[keyof SettingsErrorDetailsMap]

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** Result of opening or revealing one locally authored Agent preset directory. */
export type AgentPresetDirectoryOpenValue =
  | { readonly opened: true }
  | { readonly opened: false; readonly path: string }

/** Stable credential failure details returned by the `credentials` namespace. */
export interface CredentialErrorDetailsMap {
  /**
   * The provider refused a valid write, for example because a read-only source
   * shadows the reference. The details name only the reference, never the value.
   */
  'credential-rejected': { readonly ref: string }
}

/** Credential business failure carried by a rejected Remote call. */
export type CredentialError = {
  [Code in keyof CredentialErrorDetailsMap]: {
    readonly code: Code
    readonly message: string
    readonly details: CredentialErrorDetailsMap[Code]
  }
}[keyof CredentialErrorDetailsMap]

/** `Omit`, applied per union member instead of to the flattened union (TS's built-in `Omit` is not distributive). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/**
 * `AuthorizationPrompt` without its `signal` field, distributed over the
 * `kind` union member-by-member: the plain (non-distributive) `Omit` would
 * collapse the union into one flattened object type, losing `kind`-based
 * narrowing (`prompt.kind === 'select'` would no longer see `options`) — a
 * wire prompt still needs its `kind` to discriminate `text`/`secret`/`select`.
 * The seam's own cancellation `signal` is flow-internal and never wire-safe.
 */
export type WireAuthorizationPrompt = DistributiveOmit<AuthorizationPrompt, 'signal'>

/**
 * One frame of the `authorization` namespace's `follow` stream. Every
 * connected configuration page shares this stream: `prompt-requested`
 * replays as the reconnect baseline for every prompt still pending, so a
 * late-joining tab can answer a flow another tab started.
 */
export type AuthorizationStreamFrame =
  | { readonly type: 'notice'; readonly key: CredentialKey; readonly notice: AuthorizationNotice }
  | { readonly type: 'prompt-requested'; readonly key: CredentialKey; readonly prompt: WireAuthorizationPrompt }
  | { readonly type: 'prompt-resolved'; readonly key: CredentialKey }

/** Stable authorization failure details returned by the `authorization` namespace. */
export interface AuthorizationErrorDetailsMap {
  /** No flow claims the requested key. */
  'authorization-not-found': {}
  /** An attempt for the requested key is already running. */
  'authorization-in-flight': {}
  /** Any other seam refusal (unknown method, uncommitted flow). */
  'authorization-rejected': {}
}

/** Authorization business failure carried by a rejected Remote call. */
export type AuthorizationError = {
  [Code in keyof AuthorizationErrorDetailsMap]: {
    readonly code: Code
    readonly message: string
    readonly details: AuthorizationErrorDetailsMap[Code]
  }
}[keyof AuthorizationErrorDetailsMap]
