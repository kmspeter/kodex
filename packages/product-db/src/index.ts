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
  RegistrationConflictError,
  type AuthRepository,
  type CreateSessionInput,
  type LoginCredential,
  type RegisterAccountInput,
  type RegistrationRecord,
} from './auth-repository.js';
export {
  AuthService,
  AuthServiceError,
  hashSessionToken,
  normalizeEmail,
  type AuthErrorCode,
  type AuthServiceOptions,
  type AuthSessionResult,
} from './auth-service.js';
export {
  requireWorkspaceRole,
  workspaceRoles,
  WorkspaceAuthorizationError,
  type AuthContext,
  type AuthUser,
  type WorkspaceMembership,
  type WorkspaceRole,
} from './auth-types.js';
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
