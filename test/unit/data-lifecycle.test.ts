import {
  PRODUCT_ACCOUNT_DELETE_CONFIRMATION,
  PRODUCT_WORKSPACE_DELETE_CONFIRMATION,
  parseProductDataLifecycleJob,
} from '@kodex/product-contract';
import {
  DataLifecycleService,
  type DataLifecycleJob,
  type DataLifecycleRequestRepository,
  type PasswordHasher,
} from '@kodex/product-db';
import { describe, expect, it, vi } from 'vitest';

const userId = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000001';
const sessionId = '30000000-0000-4000-8000-000000000001';
const jobId = '40000000-0000-4000-8000-000000000001';
const createdAt = new Date('2026-09-05T00:00:00.000Z');

function lifecycleJob(kind: DataLifecycleJob['kind'] = 'user_export'): DataLifecycleJob {
  return {
    attemptCount: 0,
    completedAt: null,
    createdAt,
    id: jobId,
    kind,
    lastErrorCode: null,
    status: 'pending',
    targetUserId: kind === 'workspace_delete' ? null : userId,
    targetWorkspaceId: kind === 'workspace_delete' ? workspaceId : null,
    updatedAt: createdAt,
  };
}

function service() {
  const repository: DataLifecycleRequestRepository = {
    requestAccountDeletion: vi.fn(async (input) => {
      expect(await input.verifyCurrentPassword('stored-hash')).toBe(true);
      return lifecycleJob('account_delete');
    }),
    requestUserExport: vi.fn(async (input) => {
      expect(await input.verifyCurrentPassword('stored-hash')).toBe(true);
      return lifecycleJob();
    }),
    requestWorkspaceDeletion: vi.fn(async (input) => {
      expect(await input.verifyCurrentPassword('stored-hash')).toBe(true);
      return lifecycleJob('workspace_delete');
    }),
  };
  const hasher: PasswordHasher = {
    hash: vi.fn(async () => 'unused'),
    needsRehash: vi.fn(() => false),
    verify: vi.fn(async (encoded, password) => encoded === 'stored-hash' && password === 'current password'),
  };
  return { lifecycle: new DataLifecycleService(repository, hasher), repository };
}

describe('data lifecycle request and browser boundaries', () => {
  it('requires exact request shapes, current credentials, and destructive phrases', async () => {
    const { lifecycle, repository } = service();
    await lifecycle.requestUserExport(userId, sessionId, { currentPassword: 'current password' });
    await lifecycle.requestAccountDeletion(userId, sessionId, {
      confirmation: PRODUCT_ACCOUNT_DELETE_CONFIRMATION,
      currentPassword: 'current password',
    });
    await lifecycle.requestWorkspaceDeletion(userId, sessionId, workspaceId, {
      confirmation: PRODUCT_WORKSPACE_DELETE_CONFIRMATION,
      confirmationName: 'Personal Workspace',
      currentPassword: 'current password',
    });
    expect(repository.requestUserExport).toHaveBeenCalledOnce();
    expect(repository.requestAccountDeletion).toHaveBeenCalledOnce();
    expect(repository.requestWorkspaceDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ currentSessionId: sessionId, userId }),
      workspaceId,
      'Personal Workspace',
    );

    await expect(lifecycle.requestUserExport(userId, sessionId, {
      currentPassword: 'current password', secret: 'unexpected',
    })).rejects.toMatchObject({ code: 'invalid' });
    await expect(lifecycle.requestAccountDeletion(userId, sessionId, {
      confirmation: 'delete', currentPassword: 'current password',
    })).rejects.toMatchObject({ code: 'confirmation_mismatch' });
    await expect(lifecycle.requestWorkspaceDeletion(userId, sessionId, workspaceId, {
      confirmation: PRODUCT_WORKSPACE_DELETE_CONFIRMATION,
      confirmationName: 'Personal Workspace',
      currentPassword: 'short',
    })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('accepts only payload-free, bounded lifecycle job responses', () => {
    const body = {
      attemptCount: 1,
      completedAt: null,
      createdAt: '2026-09-05T00:00:00.000Z',
      id: jobId,
      kind: 'workspace_delete',
      lastErrorCode: null,
      status: 'waiting_local',
      updatedAt: '2026-09-05T00:00:01.000Z',
    };
    expect(parseProductDataLifecycleJob(body)).toEqual(body);
    expect(() => parseProductDataLifecycleJob({ ...body, targetWorkspaceId: workspaceId })).toThrow();
    expect(() => parseProductDataLifecycleJob({ ...body, attemptCount: -1 })).toThrow();
    expect(() => parseProductDataLifecycleJob({ ...body, status: 'completed' })).toThrow();
    expect(() => parseProductDataLifecycleJob({
      ...body,
      updatedAt: '2026-09-04T23:59:59.000Z',
    })).toThrow();
  });
});
