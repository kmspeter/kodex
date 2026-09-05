import type { PasswordHasher } from './password.js';
import {
  PRODUCT_ACCOUNT_DELETE_CONFIRMATION,
  PRODUCT_WORKSPACE_DELETE_CONFIRMATION,
} from '@kodex/product-contract';
import {
  DataLifecycleError,
  type CredentialConfirmation,
  type DataLifecycleJob,
} from './data-lifecycle-types.js';

export const ACCOUNT_DELETE_CONFIRMATION = PRODUCT_ACCOUNT_DELETE_CONFIRMATION;
export const WORKSPACE_DELETE_CONFIRMATION = PRODUCT_WORKSPACE_DELETE_CONFIRMATION;

export interface DataLifecycleRequestRepository {
  requestAccountDeletion(confirmation: CredentialConfirmation): Promise<DataLifecycleJob>;
  requestUserExport(confirmation: CredentialConfirmation): Promise<DataLifecycleJob>;
  requestWorkspaceDeletion(
    confirmation: CredentialConfirmation,
    workspaceId: string,
    workspaceName: string,
  ): Promise<DataLifecycleJob>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function currentPassword(value: unknown): string {
  if (typeof value !== 'string') throw new DataLifecycleError('invalid');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 12 || bytes > 1_024) throw new DataLifecycleError('invalid');
  return value;
}

export class DataLifecycleService {
  constructor(
    private readonly repository: DataLifecycleRequestRepository,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async requestUserExport(userId: string, currentSessionId: string, value: unknown): Promise<DataLifecycleJob> {
    if (!isRecord(value) || !exactKeys(value, ['currentPassword'])) throw new DataLifecycleError('invalid');
    return this.repository.requestUserExport(this.#confirmation(userId, currentSessionId, currentPassword(value.currentPassword)));
  }

  async requestAccountDeletion(userId: string, currentSessionId: string, value: unknown): Promise<DataLifecycleJob> {
    if (
      !isRecord(value)
      || !exactKeys(value, ['confirmation', 'currentPassword'])
      || value.confirmation !== ACCOUNT_DELETE_CONFIRMATION
    ) throw new DataLifecycleError('confirmation_mismatch');
    return this.repository.requestAccountDeletion(
      this.#confirmation(userId, currentSessionId, currentPassword(value.currentPassword)),
    );
  }

  async requestWorkspaceDeletion(
    userId: string,
    currentSessionId: string,
    workspaceId: string,
    value: unknown,
  ): Promise<DataLifecycleJob> {
    if (
      !isRecord(value)
      || !exactKeys(value, ['confirmation', 'confirmationName', 'currentPassword'])
      || value.confirmation !== WORKSPACE_DELETE_CONFIRMATION
      || typeof value.confirmationName !== 'string'
    ) throw new DataLifecycleError('confirmation_mismatch');
    return this.repository.requestWorkspaceDeletion(
      this.#confirmation(userId, currentSessionId, currentPassword(value.currentPassword)),
      workspaceId,
      value.confirmationName,
    );
  }

  #confirmation(userId: string, currentSessionId: string, password: string): CredentialConfirmation {
    return {
      userId,
      currentSessionId,
      verifyCurrentPassword: (encodedHash) => this.passwordHasher.verify(encodedHash, password),
    };
  }
}
