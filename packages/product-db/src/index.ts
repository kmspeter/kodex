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
