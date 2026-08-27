/**
 * workspace domain zod schemas (names derived from map keys). The
 * WorkspaceId brand cast lives in sessions.schema (see the note there) and
 * is re-exported here as the domain-local name.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type {
  WorkspaceEntry, WorkspaceEntryListing, WorkspaceFileContent, WorkspaceFileDiff, WorkspaceFileVersion, WorkspaceGitStatus, WorkspaceView,
} from './workspace.ts'
import { sessionIdSchema, workspaceIdSchema } from './sessions.schema.ts'

export { workspaceIdSchema } from './sessions.schema.ts'

/** WorkspaceFileVersion: one brand cast after non-empty string validation — an opaque staleness-guard token, not format-checked. */
export const workspaceFileVersionSchema = z.string().min(1) as unknown as z.ZodType<WorkspaceFileVersion>

/** WorkspaceView row of every workspace.* response. */
export const workspaceViewSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(sessionIdSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<Wire<WorkspaceView>>

/** workspace.list request payload (empty object literal). */
export const workspaceListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'workspace.list'>>>

/** workspace.list response value. */
export const workspaceListValueSchema = z.object({
  items: z.array(workspaceViewSchema),
  archivedSessionIds: z.array(sessionIdSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.list'>>>

/** workspace.create request payload: the existing directory to adopt. */
export const workspaceCreateRequestSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.create'>>>

/** workspace.create response value. */
export const workspaceCreateValueSchema = z.object({
  workspace: workspaceViewSchema,
  created: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.create'>>>

/** workspace.rename request payload: the new title must be non-blank. */
export const workspaceRenameRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  title: z.string(),
}).refine(
  payload => payload.title.trim() !== '',
  { message: 'workspace.rename requires a non-blank title' },
) satisfies z.ZodType<Wire<RequestPayload<'workspace.rename'>>>

/** workspace.rename response value. */
export const workspaceRenameValueSchema = z.object({
  workspace: workspaceViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.rename'>>>

/** workspace.delete request payload. */
export const workspaceDeleteRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.delete'>>>

/** workspace.delete response value. */
export const workspaceDeleteValueSchema = z.object({
  deleted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.delete'>>>

/** workspace.insertBefore request payload (anchor omitted = append to end). */
export const workspaceInsertBeforeRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  beforeWorkspaceId: workspaceIdSchema.optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.insertBefore'>>>

/** workspace.insertBefore response value: the complete durable display order. */
export const workspaceInsertBeforeValueSchema = z.object({
  workspaceIds: z.array(workspaceIdSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.insertBefore'>>>

/** workspace.insertSessionBefore request payload (anchor omitted = append to end). */
export const workspaceInsertSessionBeforeRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  sessionId: sessionIdSchema,
  beforeSessionId: sessionIdSchema.optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.insertSessionBefore'>>>

/** workspace.insertSessionBefore response value. */
export const workspaceInsertSessionBeforeValueSchema = z.object({
  workspace: workspaceViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.insertSessionBefore'>>>

/** workspace.archiveSession request payload. */
export const workspaceArchiveSessionRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.archiveSession'>>>

/** workspace.archiveSession response value: the full updated archive set. */
export const workspaceArchiveSessionValueSchema = z.object({
  archivedSessionIds: z.array(sessionIdSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.archiveSession'>>>

/** One `workspace.listEntries` row: a subdirectory or a regular file. */
export const workspaceEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.union([z.literal('directory'), z.literal('file')]),
  hidden: z.boolean(),
  size: z.number().optional(),
}) satisfies z.ZodType<Wire<WorkspaceEntry>>

/** workspace.listEntries request payload: the path must be the workspace root or a descendant. */
export const workspaceListEntriesRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.listEntries'>>>

/** workspace.listEntries response value. */
export const workspaceListEntriesValueSchema = z.object({
  path: z.string(),
  entries: z.array(workspaceEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.listEntries'>>> satisfies z.ZodType<Wire<WorkspaceEntryListing>>

/** workspace.readFile request payload: the path must be the workspace root or a descendant. */
export const workspaceReadFileRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.readFile'>>>

/** workspace.readFile response value: text decodes as a plain JSON string; binary content is base64 with a media type. */
export const workspaceReadFileValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), content: z.string(), version: workspaceFileVersionSchema }),
  z.object({ kind: z.literal('binary'), mediaType: z.string(), data: z.string() }),
]) satisfies z.ZodType<Wire<ResponseValue<'workspace.readFile'>>> satisfies z.ZodType<Wire<WorkspaceFileContent>>

/** workspace.gitStatus request payload. */
export const workspaceGitStatusRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.gitStatus'>>>

/** workspace.gitStatus response value. */
export const workspaceGitStatusValueSchema = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  files: z.record(z.string(), z.string()),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.gitStatus'>>> satisfies z.ZodType<Wire<WorkspaceGitStatus>>

/** workspace.gitCommitAll request payload: the commit message must be non-blank. */
export const workspaceGitCommitAllRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  message: z.string(),
}).refine(
  payload => payload.message.trim() !== '',
  { message: 'workspace.gitCommitAll requires a non-blank commit message' },
) satisfies z.ZodType<Wire<RequestPayload<'workspace.gitCommitAll'>>>

/** workspace.gitCommitAll response value. */
export const workspaceGitCommitAllValueSchema = z.object({
  committed: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.gitCommitAll'>>>

/** workspace.gitDiscardAll request payload. */
export const workspaceGitDiscardAllRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.gitDiscardAll'>>>

/** workspace.gitDiscardAll response value. */
export const workspaceGitDiscardAllValueSchema = z.object({
  discarded: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.gitDiscardAll'>>>

/** workspace.gitFileDiff request payload: the path must be the workspace root or a descendant. */
export const workspaceGitFileDiffRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.gitFileDiff'>>>

/** workspace.gitFileDiff response value: HEAD and working-tree text, either side nullable. */
export const workspaceGitFileDiffValueSchema = z.object({
  oldText: z.string().nullable(),
  newText: z.string().nullable(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.gitFileDiff'>>> satisfies z.ZodType<Wire<WorkspaceFileDiff>>

/** workspace.writeFile request payload: the path must be the workspace root or a descendant, and must already exist. */
export const workspaceWriteFileRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string(),
  content: z.string(),
  expectedVersion: workspaceFileVersionSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.writeFile'>>>

/** workspace.writeFile response value: the version the write produced. */
export const workspaceWriteFileValueSchema = z.object({
  version: workspaceFileVersionSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.writeFile'>>>
