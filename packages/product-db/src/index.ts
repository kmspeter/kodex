export {
  productDatabaseConfigFromEnv,
  ProductDatabaseConfigurationError,
  requireProductDatabaseConfig,
  type ProductDatabaseConfig,
  type ProductDatabaseSslMode,
} from './config.js';
export {
  createProductDatabase,
  createProductDatabaseFromEnv,
  ProductDatabase,
  requireProductDatabaseFromEnv,
  type ProductDatabaseOptions,
} from './database.js';
export {
  defaultMigrationsDirectory,
  loadMigrations,
  migrateProductDatabase,
  type AppliedMigration,
  type Migration,
} from './migrations.js';
export {
  PostgresAuthRepository,
  LoginCredentialChangedError,
  PasswordChangeRejectedError,
  RegistrationConflictError,
  SessionNotFoundError,
  type AuthRepository,
  type ChangePasswordInput,
  type CreateSessionInput,
  type LoginCredential,
  type RegisterAccountInput,
  type RegistrationRecord,
} from './auth-repository.js';
export {
  AuthService,
  AuthServiceError,
  hashSessionToken,
  loginRateLimitBucket,
  normalizeEmail,
  type AuthErrorCode,
  type AuthServiceOptions,
  type AuthSessionResult,
  type LoginRequestContext,
} from './auth-service.js';
export {
  requireWorkspaceRole,
  workspaceRoles,
  WorkspaceAuthorizationError,
  type AuthContext,
  type AuthSession,
  type AuthUser,
  type WorkspaceMembership,
  type WorkspaceRole,
} from './auth-types.js';
export {
  PostgresLoginRateLimiter,
  type LoginRateLimiter,
  type LoginRateLimitPolicy,
  type LoginRateLimitResult,
} from './login-rate-limiter.js';
export {
  Argon2idPasswordHasher,
  argon2idParameters,
  type PasswordHasher,
} from './password.js';
export { PostgresHistoryRepository } from './history-repository.js';
export {
  HistoryCursorError,
  type HistoryApprovalRecord,
  type HistoryApprovalSnapshot,
  type HistoryApprovalStatus,
  type HistoryEventSink,
  type HistoryIngestEvent,
  type HistoryItemRecord,
  type HistoryItemSnapshot,
  type HistoryItemStatus,
  type HistoryProjectSnapshot,
  type HistoryReader,
  type HistoryScope,
  type HistoryThreadDetail,
  type HistoryThreadPage,
  type HistoryThreadSnapshot,
  type HistoryThreadStatus,
  type HistoryThreadSummary,
  type HistoryToolCallRecord,
  type HistoryToolCallSnapshot,
  type HistoryToolStatus,
  type HistoryTurnRecord,
  type HistoryTurnSnapshot,
  type HistoryTurnStatus,
} from './history-types.js';
export {
  CHUNKER_VERSION,
  chunkText,
  contentChecksum,
  indexConfigurationChecksum,
  validateChunkingConfig,
  type ChunkingConfig,
  type TextChunk,
} from './chunking.js';
export {
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  OpenAIEmbeddingProvider,
  openAIEmbeddingConfigFromEnv,
  type OpenAIEmbeddingConfig,
  type OpenAIEmbeddingProviderOptions,
} from './embedding-provider.js';
export {
  PostgresKnowledgeRepository,
  type ReplacementChunk,
  type ReplaceDocumentInput,
  type StoredDocument,
} from './knowledge-repository.js';
export {
  KnowledgeService,
  type IndexTextDocumentInput,
  type IndexTextDocumentResult,
} from './knowledge-service.js';
export {
  createKnowledgeRuntimeFromEnv,
  type KnowledgeRuntime,
  type KnowledgeRuntimeOptions,
} from './knowledge-runtime.js';
export {
  KnowledgeNotFoundError,
  KnowledgeCursorError,
  KnowledgeOperationError,
  type EmbeddingProvider,
  type KnowledgeDocumentPage,
  type KnowledgeDocumentRecord,
  type KnowledgeScope,
  type KnowledgeSourceRecord,
  type RagFailureCode,
  type RetrievalCitation,
  type RetrievalResult,
} from './knowledge-types.js';
export { ragConfigFromEnv, type RagConfig } from './rag-config.js';
export {
  hashWorkspaceInvitationToken,
  PostgresWorkspaceRepository,
  WORKSPACE_INVITATION_TOKEN_BYTES,
  WORKSPACE_INVITATION_TOKEN_PATTERN,
  type WorkspaceInvitationOptions,
} from './workspace-repository.js';
export {
  WorkspaceCursorError,
  WorkspaceInvitationError,
  WorkspaceOperationError,
  type CreatedWorkspaceInvitation,
  type WorkspaceApplication,
  type WorkspaceInvitation,
  type WorkspaceInvitationPage,
  type WorkspaceInvitationErrorCode,
  type WorkspaceInvitationPreview,
  type WorkspaceInvitationRole,
  type WorkspaceMember,
  type WorkspaceMemberPage,
  type WorkspaceOperationErrorCode,
  type WorkspacePageOptions,
  type WorkspaceRecord,
} from './workspace-types.js';
