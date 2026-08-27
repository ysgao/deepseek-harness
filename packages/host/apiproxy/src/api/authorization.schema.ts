/**
 * authorization domain zod schemas (names derived from map keys:
 * authorizationListRequestSchema / authorizationListValueSchema / …), plus the
 * `respond()` payload schema for an answered or declined prompt.
 */

import { z } from 'zod'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type {
  AuthorizationEntry, AuthorizationMethod, AuthorizationNotice,
  AuthorizationPromptResponsePayload, WireAuthorizationPrompt,
} from './authorization.ts'

/**
 * `<scope>/<id>` credential key grammar (mirrors `dsh-credentials`'
 * `KEY_SEGMENT_PATTERN`, both segments), branded like `sessionIdSchema` /
 * `approvalRequestIdSchema`.
 */
export const credentialKeySchema = z.string().regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/) as unknown as z.ZodType<CredentialKey>

/** AuthorizationMethod entry of authorization.list / an authorization/prompt-requested frame's owning entry. */
export const authorizationMethodSchema = z.object({
  id: z.string(),
  label: z.string(),
}) satisfies z.ZodType<Wire<AuthorizationMethod>>

/** AuthorizationEntry entry of authorization.list. */
export const authorizationEntrySchema = z.object({
  key: credentialKeySchema,
  label: z.string(),
  methods: z.array(authorizationMethodSchema),
  inFlight: z.boolean(),
}) satisfies z.ZodType<Wire<AuthorizationEntry>>

/** authorization.list request payload (empty). */
export const authorizationListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'authorization.list'>>>

/** authorization.list response value. */
export const authorizationListValueSchema = z.object({
  entries: z.array(authorizationEntrySchema),
}) satisfies z.ZodType<Wire<ResponseValue<'authorization.list'>>>

/** authorization.begin request payload. */
export const authorizationBeginRequestSchema = z.object({
  key: credentialKeySchema,
  method: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'authorization.begin'>>>

/** authorization.begin response value. */
export const authorizationBeginValueSchema = z.object({
  accepted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'authorization.begin'>>>

/** authorization.cancel request payload. */
export const authorizationCancelRequestSchema = z.object({
  key: credentialKeySchema,
}) satisfies z.ZodType<Wire<RequestPayload<'authorization.cancel'>>>

/** authorization.cancel response value. */
export const authorizationCancelValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'authorization.cancel'>>>

/** AuthorizationNotice payload of an `authorization/notice` host frame. */
export const authorizationNoticeSchema = z.object({
  message: z.string(),
  url: z.string().optional(),
  code: z.string().optional(),
}) satisfies z.ZodType<Wire<AuthorizationNotice>>

/** AuthorizationPrompt payload of an `authorization/prompt-requested` host frame. */
export const authorizationPromptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), message: z.string(), placeholder: z.string().optional() }),
  z.object({ kind: z.literal('secret'), message: z.string(), placeholder: z.string().optional() }),
  z.object({
    kind: z.literal('select'),
    message: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() })),
  }),
]) satisfies z.ZodType<Wire<WireAuthorizationPrompt>>

/** Authorization prompt answer payload (the result.value slot of a client-response). */
export const authorizationPromptResponsePayloadSchema = z.object({
  key: credentialKeySchema,
  answer: z.string(),
}) satisfies z.ZodType<Wire<AuthorizationPromptResponsePayload>>
