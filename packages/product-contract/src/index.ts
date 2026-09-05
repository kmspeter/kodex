/** Browser-safe product authentication and tenant-scope contract. */
export const PRODUCT_SESSION_COOKIE_NAME = 'kodex_product_session';
export const PRODUCT_WORKSPACE_HEADER_NAME = 'X-Kodex-Workspace-Id';
export const PRODUCT_WORKSPACE_QUERY_PARAM = 'workspace_id';
export const PRODUCT_WORKSPACE_NAME_MAX_CHARACTERS = 100;
export const PRODUCT_WORKSPACE_NAME_MAX_UTF8_BYTES = 400;
/** HTML maxLength counts UTF-16 code units; a Unicode code point can require two. */
export const PRODUCT_WORKSPACE_NAME_MAX_UTF16_CODE_UNITS = PRODUCT_WORKSPACE_NAME_MAX_CHARACTERS * 2;
export const PRODUCT_ACCOUNT_DELETE_CONFIRMATION = 'DELETE MY ACCOUNT';
export const PRODUCT_WORKSPACE_DELETE_CONFIRMATION = 'DELETE WORKSPACE';

/** Browser-safe workspace-name predicate shared by Product API and UI boundaries. */
export function isValidProductWorkspaceName(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim() || value !== value.normalize('NFC')) {
    return false;
  }
  const characters = Array.from(value);
  return characters.length >= 1
    && characters.length <= PRODUCT_WORKSPACE_NAME_MAX_CHARACTERS
    && new TextEncoder().encode(value).byteLength <= PRODUCT_WORKSPACE_NAME_MAX_UTF8_BYTES
    && !/\s{2,}/u.test(value)
    && !characters.some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 || (code >= 0xD800 && code <= 0xDFFF);
    });
}

export const workspaceRoles = ['owner', 'admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];
export const workspaceInvitationRoles = ['admin', 'member', 'viewer'] as const;
export type WorkspaceInvitationRole = (typeof workspaceInvitationRoles)[number];

export const runtimeWorkspaceRoles = ['owner', 'admin', 'member'] as const;
export type RuntimeWorkspaceRole = (typeof runtimeWorkspaceRoles)[number];

export function canUseWorkspaceRuntime(role: WorkspaceRole): role is RuntimeWorkspaceRole {
  return runtimeWorkspaceRoles.includes(role as RuntimeWorkspaceRole);
}

export interface ProductUserDto {
  createdAt: string;
  displayName: string | null;
  email: string;
  id: string;
}

export interface ProductWorkspaceDto {
  id: string;
  name: string;
  role: WorkspaceRole;
  slug: string;
}

export interface ProductWorkspaceRenameRequestDto {
  name: string;
}

/** Exact-name confirmation used only for the one-way soft-archive operation. */
export interface ProductWorkspaceArchiveRequestDto {
  confirmationName: string;
}

export interface ProductWorkspaceMemberDto {
  displayName: string | null;
  email: string;
  joinedAt: string;
  role: WorkspaceRole;
  userId: string;
}

export const PRODUCT_WORKSPACE_PAGE_DEFAULT_LIMIT = 50;
export const PRODUCT_WORKSPACE_PAGE_MAX_LIMIT = 100;
export const PRODUCT_WORKSPACE_CURSOR_MAX_CHARACTERS = 512;

export interface ProductWorkspaceMembersDto {
  members: ProductWorkspaceMemberDto[];
  nextCursor?: string;
}

export interface ProductWorkspaceInvitationDto {
  createdAt: string;
  createdByUserId: string | null;
  expiresAt: string;
  id: string;
  role: WorkspaceInvitationRole;
  targetEmail: string;
  workspaceId: string;
}

export interface ProductWorkspaceInvitationsDto {
  invitations: ProductWorkspaceInvitationDto[];
  nextCursor?: string;
}

export type ProductCreatedWorkspaceInvitationDto = {
  invitation: ProductWorkspaceInvitationDto;
  token: string;
} | {
  deliveryStatus: 'pending';
  invitation: ProductWorkspaceInvitationDto;
};

export interface ProductWorkspaceInvitationPreviewDto {
  expiresAt: string;
  role: WorkspaceInvitationRole;
  targetEmailHint: string;
  workspaceName: string;
}

export interface ProductAuthContextDto {
  defaultWorkspace?: ProductWorkspaceDto;
  session: { expiresAt: string };
  user: ProductUserDto;
  workspaces: ProductWorkspaceDto[];
}

export interface ProductAuthResponseDto extends ProductAuthContextDto {
  csrfToken: string;
}

export interface ProductVerificationPendingDto {
  csrfToken: string;
  email: string;
  status: 'verification_pending';
}

export interface ProductEmailVerificationStatusDto {
  email: string;
  status: 'pending' | 'verified';
}

export interface ProductSessionDto {
  createdAt: string;
  current: boolean;
  expiresAt: string;
  id: string;
  lastSeenAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
}

export interface ProductSessionsDto {
  sessions: ProductSessionDto[];
}

export const productDataLifecycleJobKinds = ['user_export', 'account_delete', 'workspace_delete'] as const;
export type ProductDataLifecycleJobKind = (typeof productDataLifecycleJobKinds)[number];
export const productDataLifecycleJobStatuses = [
  'pending', 'running', 'waiting_local', 'blocked_legal_hold', 'completed', 'failed',
] as const;
export type ProductDataLifecycleJobStatus = (typeof productDataLifecycleJobStatuses)[number];

export interface ProductDataLifecycleJobDto {
  attemptCount: number;
  completedAt: string | null;
  createdAt: string;
  id: string;
  kind: ProductDataLifecycleJobKind;
  lastErrorCode: string | null;
  status: ProductDataLifecycleJobStatus;
  updatedAt: string;
}

export const PRODUCT_HISTORY_DEFAULT_LIMIT = 25;
export const PRODUCT_HISTORY_MAX_LIMIT = 50;
export const PRODUCT_HISTORY_PREVIEW_CHARACTERS = 4_000;

export type ProductHistoryThreadStatus = 'active' | 'archived' | 'deleted';
export type ProductHistoryTurnStatus = 'in_progress' | 'completed' | 'failed' | 'interrupted';
export type ProductHistoryItemStatus = 'started' | 'completed';
export type ProductHistoryToolStatus = 'requested' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ProductHistoryApprovalStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';

/** A bounded, server-redacted JSON/text rendering. It is never the raw database payload. */
export interface ProductHistoryPreviewDto {
  content: string;
  truncated: boolean;
}

export interface ProductHistoryThreadSummaryDto {
  createdAt: string;
  projectName: string;
  status: ProductHistoryThreadStatus;
  threadId: string;
  title: string | null;
  updatedAt: string;
}

export interface ProductHistoryThreadPageDto {
  nextCursor: string | null;
  threads: ProductHistoryThreadSummaryDto[];
}

export interface ProductHistoryTurnDto {
  completedAt: string | null;
  startedAt: string;
  status: ProductHistoryTurnStatus;
  turnId: string;
}

export interface ProductHistoryItemDto {
  completedAt: string | null;
  itemId: string;
  itemType: string;
  payload: ProductHistoryPreviewDto;
  role: string | null;
  startedAt: string | null;
  status: ProductHistoryItemStatus;
  turnId: string;
}

export interface ProductHistoryToolCallDto {
  arguments: ProductHistoryPreviewDto;
  callId: string;
  completedAt: string | null;
  requestedAt: string;
  result: ProductHistoryPreviewDto | null;
  startedAt: string | null;
  status: ProductHistoryToolStatus;
  toolName: string;
  turnId: string;
}

export interface ProductHistoryApprovalDto {
  approvalType: string;
  requestId: string;
  requestPayload: ProductHistoryPreviewDto;
  requestedAt: string;
  resolvedAt: string | null;
  responsePayload: ProductHistoryPreviewDto | null;
  status: ProductHistoryApprovalStatus;
  turnId: string | null;
}

export interface ProductHistoryThreadDetailDto {
  approvals: ProductHistoryApprovalDto[];
  items: ProductHistoryItemDto[];
  nextCursor: string | null;
  omitted: { approvals: boolean; items: boolean; toolCalls: boolean };
  thread: ProductHistoryThreadSummaryDto;
  toolCalls: ProductHistoryToolCallDto[];
  turns: ProductHistoryTurnDto[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function workspaceRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactWorkspaceKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function workspaceDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function nullableWorkspaceDate(value: unknown): value is string | null {
  return value === null || workspaceDate(value);
}

export function parseProductSession(value: unknown): ProductSessionDto {
  if (
    !workspaceRecord(value)
    || !exactWorkspaceKeys(value, [
      'createdAt', 'current', 'expiresAt', 'id', 'lastSeenAt', 'revoked', 'revokedAt',
    ])
    || !isUuid(value.id)
    || typeof value.current !== 'boolean'
    || !workspaceDate(value.createdAt)
    || !nullableWorkspaceDate(value.lastSeenAt)
    || !workspaceDate(value.expiresAt)
    || typeof value.revoked !== 'boolean'
    || !nullableWorkspaceDate(value.revokedAt)
    || value.revoked !== (value.revokedAt !== null)
  ) throw new Error('Invalid product session response.');
  return value as unknown as ProductSessionDto;
}

/** Strict browser-boundary parser; rejects secret fields and oversized session lists. */
export function parseProductSessions(value: unknown): ProductSessionsDto {
  if (
    !workspaceRecord(value)
    || !exactWorkspaceKeys(value, ['sessions'])
    || !Array.isArray(value.sessions)
    || value.sessions.length > 100
  ) throw new Error('Invalid product sessions response.');
  const sessions = value.sessions.map(parseProductSession);
  const current = sessions.filter((session) => session.current);
  if (current.length !== 1 || current[0].revoked) {
    throw new Error('Invalid current product session response.');
  }
  return { sessions };
}

export function parseProductDataLifecycleJob(value: unknown): ProductDataLifecycleJobDto {
  if (
    !workspaceRecord(value)
    || !exactWorkspaceKeys(value, [
      'attemptCount', 'completedAt', 'createdAt', 'id', 'kind', 'lastErrorCode', 'status', 'updatedAt',
    ])
    || !isUuid(value.id)
    || typeof value.kind !== 'string'
    || !productDataLifecycleJobKinds.includes(value.kind as ProductDataLifecycleJobKind)
    || typeof value.status !== 'string'
    || !productDataLifecycleJobStatuses.includes(value.status as ProductDataLifecycleJobStatus)
    || !Number.isSafeInteger(value.attemptCount)
    || Number(value.attemptCount) < 0
    || Number(value.attemptCount) > 1_000_000
    || (value.lastErrorCode !== null && (typeof value.lastErrorCode !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(value.lastErrorCode)))
    || !workspaceDate(value.createdAt)
    || !workspaceDate(value.updatedAt)
    || (value.completedAt !== null && !workspaceDate(value.completedAt))
    || Date.parse(String(value.updatedAt)) < Date.parse(String(value.createdAt))
    || (value.completedAt !== null && Date.parse(value.completedAt as string) < Date.parse(String(value.createdAt)))
    || (['completed', 'failed'].includes(value.status as string) !== (value.completedAt !== null))
  ) {
    throw new Error('Invalid product data lifecycle job response.');
  }
  return value as unknown as ProductDataLifecycleJobDto;
}

function workspaceEmail(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 3
    && value.length <= 320
    && value === value.toLowerCase()
    && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(value);
}

function workspaceCursor(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= PRODUCT_WORKSPACE_CURSOR_MAX_CHARACTERS
    && /^[A-Za-z0-9_-]+$/u.test(value);
}

/** Strict browser-boundary parser for workspace mutation responses. */
export function parseProductWorkspace(value: unknown): ProductWorkspaceDto {
  if (
    !workspaceRecord(value)
    || !exactWorkspaceKeys(value, ['id', 'name', 'role', 'slug'])
    || !isUuid(value.id)
    || !isValidProductWorkspaceName(value.name)
    || typeof value.slug !== 'string'
    || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(value.slug)
    || !workspaceRoles.includes(value.role as WorkspaceRole)
  ) throw new Error('Invalid workspace response.');
  return value as unknown as ProductWorkspaceDto;
}

export function parseProductWorkspaceMember(value: unknown): ProductWorkspaceMemberDto {
  if (
    !workspaceRecord(value)
    || !exactWorkspaceKeys(value, ['displayName', 'email', 'joinedAt', 'role', 'userId'])
    || !isUuid(value.userId)
    || !workspaceEmail(value.email)
    || (value.displayName !== null && (typeof value.displayName !== 'string' || value.displayName.length > 100))
    || !workspaceDate(value.joinedAt)
    || !workspaceRoles.includes(value.role as WorkspaceRole)
  ) throw new Error('Invalid workspace member response.');
  return value as unknown as ProductWorkspaceMemberDto;
}

/** Strict browser-boundary parser; rejects extra fields and oversized member lists. */
export function parseProductWorkspaceMembers(value: unknown): ProductWorkspaceMembersDto {
  if (
    !workspaceRecord(value)
    || !(
      exactWorkspaceKeys(value, ['members'])
      || exactWorkspaceKeys(value, ['members', 'nextCursor'])
    )
    || !Array.isArray(value.members)
    || value.members.length > PRODUCT_WORKSPACE_PAGE_MAX_LIMIT
    || (Object.hasOwn(value, 'nextCursor') && !workspaceCursor(value.nextCursor))
  ) throw new Error('Invalid workspace members response.');
  return {
    members: value.members.map(parseProductWorkspaceMember),
    ...(Object.hasOwn(value, 'nextCursor') ? { nextCursor: value.nextCursor as string } : {}),
  };
}

export function parseProductWorkspaceInvitation(value: unknown): ProductWorkspaceInvitationDto {
  if (
    !workspaceRecord(value)
    || !exactWorkspaceKeys(value, [
      'createdAt', 'createdByUserId', 'expiresAt', 'id', 'role', 'targetEmail', 'workspaceId',
    ])
    || !isUuid(value.id)
    || !isUuid(value.workspaceId)
    || (value.createdByUserId !== null && !isUuid(value.createdByUserId))
    || !workspaceEmail(value.targetEmail)
    || !workspaceInvitationRoles.includes(value.role as WorkspaceInvitationRole)
    || !workspaceDate(value.createdAt)
    || !workspaceDate(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
  ) throw new Error('Invalid workspace invitation response.');
  return value as unknown as ProductWorkspaceInvitationDto;
}

/** Strict pending-list parser; token/hash/secret fields are rejected by exact-key checks. */
export function parseProductWorkspaceInvitations(value: unknown): ProductWorkspaceInvitationsDto {
  if (
    !workspaceRecord(value)
    || !(
      exactWorkspaceKeys(value, ['invitations'])
      || exactWorkspaceKeys(value, ['invitations', 'nextCursor'])
    )
    || !Array.isArray(value.invitations)
    || value.invitations.length > PRODUCT_WORKSPACE_PAGE_MAX_LIMIT
    || (Object.hasOwn(value, 'nextCursor') && !workspaceCursor(value.nextCursor))
  ) throw new Error('Invalid workspace invitation list response.');
  return {
    invitations: value.invitations.map(parseProductWorkspaceInvitation),
    ...(Object.hasOwn(value, 'nextCursor') ? { nextCursor: value.nextCursor as string } : {}),
  };
}

/** The only browser DTO allowed to contain a raw invitation token. */
export function parseProductCreatedWorkspaceInvitation(value: unknown): ProductCreatedWorkspaceInvitationDto {
  if (
    !workspaceRecord(value)
    || !(
      (exactWorkspaceKeys(value, ['invitation', 'token'])
        && typeof value.token === 'string'
        && /^[A-Za-z0-9_-]{43}$/u.test(value.token))
      || (exactWorkspaceKeys(value, ['deliveryStatus', 'invitation'])
        && value.deliveryStatus === 'pending')
    )
  ) throw new Error('Invalid created workspace invitation response.');
  const invitation = parseProductWorkspaceInvitation(value.invitation);
  return Object.hasOwn(value, 'token')
    ? { invitation, token: value.token as string }
    : { invitation, deliveryStatus: 'pending' };
}

export function parseProductVerificationPending(value: unknown): ProductVerificationPendingDto {
  if (
    !workspaceRecord(value)
    || !exactWorkspaceKeys(value, ['csrfToken', 'email', 'status'])
    || value.status !== 'verification_pending'
    || typeof value.csrfToken !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.csrfToken)
    || !workspaceEmail(value.email)
  ) throw new Error('Invalid email verification pending response.');
  return value as unknown as ProductVerificationPendingDto;
}

export function parseProductEmailVerificationStatus(value: unknown): ProductEmailVerificationStatusDto {
  if (
    !workspaceRecord(value)
    || !exactWorkspaceKeys(value, ['email', 'status'])
    || !workspaceEmail(value.email)
    || !['pending', 'verified'].includes(String(value.status))
  ) throw new Error('Invalid email verification status response.');
  return value as unknown as ProductEmailVerificationStatusDto;
}

export function parseProductWorkspaceInvitationPreview(value: unknown): ProductWorkspaceInvitationPreviewDto {
  if (
    !workspaceRecord(value)
    || !exactWorkspaceKeys(value, ['expiresAt', 'role', 'targetEmailHint', 'workspaceName'])
    || !workspaceDate(value.expiresAt)
    || !workspaceInvitationRoles.includes(value.role as WorkspaceInvitationRole)
    || typeof value.targetEmailHint !== 'string'
    || value.targetEmailHint.length < 3
    || value.targetEmailHint.length > 320
    || !value.targetEmailHint.includes('*@')
    || !isValidProductWorkspaceName(value.workspaceName)
  ) throw new Error('Invalid workspace invitation preview response.');
  return value as unknown as ProductWorkspaceInvitationPreviewDto;
}

function historyRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactHistoryKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function historyString(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function historyDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function historyNullableDate(value: unknown): value is string | null {
  return value === null || historyDate(value);
}

function historyCursor(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_-]+$/u.test(value));
}

function parseHistoryPreview(value: unknown): ProductHistoryPreviewDto {
  if (
    !historyRecord(value)
    || !exactHistoryKeys(value, ['content', 'truncated'])
    || typeof value.content !== 'string'
    || value.content.length > PRODUCT_HISTORY_PREVIEW_CHARACTERS
    || typeof value.truncated !== 'boolean'
  ) throw new Error('Invalid saved history preview.');
  return { content: value.content, truncated: value.truncated };
}

function parseHistoryThread(value: unknown): ProductHistoryThreadSummaryDto {
  if (
    !historyRecord(value)
    || !exactHistoryKeys(value, ['createdAt', 'projectName', 'status', 'threadId', 'title', 'updatedAt'])
    || !historyDate(value.createdAt)
    || !historyString(value.projectName, 500)
    || !['active', 'archived', 'deleted'].includes(String(value.status))
    || !historyString(value.threadId)
    || (value.title !== null && typeof value.title !== 'string')
    || (typeof value.title === 'string' && value.title.length > 1_000)
    || !historyDate(value.updatedAt)
  ) throw new Error('Invalid saved history thread.');
  return value as unknown as ProductHistoryThreadSummaryDto;
}

/** Strict browser-boundary parser; rejects unexpected keys and oversized fields. */
export function parseProductHistoryThreadPage(value: unknown): ProductHistoryThreadPageDto {
  if (
    !historyRecord(value)
    || !exactHistoryKeys(value, ['nextCursor', 'threads'])
    || !historyCursor(value.nextCursor)
    || !Array.isArray(value.threads)
    || value.threads.length > PRODUCT_HISTORY_MAX_LIMIT
  ) throw new Error('Invalid saved history thread page.');
  return { nextCursor: value.nextCursor, threads: value.threads.map(parseHistoryThread) };
}

/** Strict browser-boundary parser for a single turn page and its bounded child previews. */
export function parseProductHistoryThreadDetail(value: unknown): ProductHistoryThreadDetailDto {
  if (
    !historyRecord(value)
    || !exactHistoryKeys(value, ['approvals', 'items', 'nextCursor', 'omitted', 'thread', 'toolCalls', 'turns'])
    || !historyCursor(value.nextCursor)
    || !historyRecord(value.omitted)
    || !exactHistoryKeys(value.omitted, ['approvals', 'items', 'toolCalls'])
    || typeof value.omitted.approvals !== 'boolean'
    || typeof value.omitted.items !== 'boolean'
    || typeof value.omitted.toolCalls !== 'boolean'
    || !Array.isArray(value.turns)
    || !Array.isArray(value.items)
    || !Array.isArray(value.toolCalls)
    || !Array.isArray(value.approvals)
    || value.turns.length > PRODUCT_HISTORY_MAX_LIMIT
    || value.items.length > 250
    || value.toolCalls.length > 250
    || value.approvals.length > 250
  ) throw new Error('Invalid saved history detail.');

  const turns = value.turns.map((entry): ProductHistoryTurnDto => {
    if (!historyRecord(entry) || !exactHistoryKeys(entry, ['completedAt', 'startedAt', 'status', 'turnId'])
      || !historyNullableDate(entry.completedAt) || !historyDate(entry.startedAt)
      || !['in_progress', 'completed', 'failed', 'interrupted'].includes(String(entry.status))
      || !historyString(entry.turnId)) throw new Error('Invalid saved history turn.');
    return entry as unknown as ProductHistoryTurnDto;
  });
  const items = value.items.map((entry): ProductHistoryItemDto => {
    if (!historyRecord(entry) || !exactHistoryKeys(entry, ['completedAt', 'itemId', 'itemType', 'payload', 'role', 'startedAt', 'status', 'turnId'])
      || !historyNullableDate(entry.completedAt) || !historyString(entry.itemId) || !historyString(entry.itemType, 200)
      || (entry.role !== null && !historyString(entry.role, 100)) || !historyNullableDate(entry.startedAt)
      || !['started', 'completed'].includes(String(entry.status)) || !historyString(entry.turnId)) throw new Error('Invalid saved history item.');
    return { ...(entry as unknown as Omit<ProductHistoryItemDto, 'payload'>), payload: parseHistoryPreview(entry.payload) };
  });
  const toolCalls = value.toolCalls.map((entry): ProductHistoryToolCallDto => {
    if (!historyRecord(entry) || !exactHistoryKeys(entry, ['arguments', 'callId', 'completedAt', 'requestedAt', 'result', 'startedAt', 'status', 'toolName', 'turnId'])
      || !historyString(entry.callId) || !historyNullableDate(entry.completedAt) || !historyDate(entry.requestedAt)
      || !historyNullableDate(entry.startedAt) || !['requested', 'running', 'completed', 'failed', 'cancelled'].includes(String(entry.status))
      || !historyString(entry.toolName, 200) || !historyString(entry.turnId)) throw new Error('Invalid saved history tool call.');
    return { ...(entry as unknown as Omit<ProductHistoryToolCallDto, 'arguments' | 'result'>), arguments: parseHistoryPreview(entry.arguments), result: entry.result === null ? null : parseHistoryPreview(entry.result) };
  });
  const approvals = value.approvals.map((entry): ProductHistoryApprovalDto => {
    if (!historyRecord(entry) || !exactHistoryKeys(entry, ['approvalType', 'requestId', 'requestPayload', 'requestedAt', 'resolvedAt', 'responsePayload', 'status', 'turnId'])
      || !historyString(entry.approvalType, 200) || !historyString(entry.requestId) || !historyDate(entry.requestedAt)
      || !historyNullableDate(entry.resolvedAt) || !['pending', 'approved', 'denied', 'cancelled', 'expired'].includes(String(entry.status))
      || (entry.turnId !== null && !historyString(entry.turnId))) throw new Error('Invalid saved history approval.');
    return { ...(entry as unknown as Omit<ProductHistoryApprovalDto, 'requestPayload' | 'responsePayload'>), requestPayload: parseHistoryPreview(entry.requestPayload), responsePayload: entry.responsePayload === null ? null : parseHistoryPreview(entry.responsePayload) };
  });
  return {
    approvals,
    items,
    nextCursor: value.nextCursor,
    omitted: value.omitted as ProductHistoryThreadDetailDto['omitted'],
    thread: parseHistoryThread(value.thread),
    toolCalls,
    turns,
  };
}
