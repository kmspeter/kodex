import { describe, expect, it } from 'vitest';
import { ALLOWED_METHODS } from '../../apps/local-server/src/runtime';
import {
  validateAutomationInput, validateClientRequest, validateProjectMutation, validateServerRequestResult,
  validateRepositoryConfirm, validateRepositoryPreview, validateSettingsPatch, validateSocketMessage,
} from '../../apps/local-server/src/api/validation';

describe('HTTP and WebSocket runtime validation', () => {
  it('accepts explicit supported settings and rejects stale or unsafe provider values', () => {
    expect(validateSettingsPatch({ network: { webSearch: false }, provider: { mode: 'local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'local-model' } })).toMatchObject({ provider: { mode: 'local' } });
    expect(() => validateSettingsPatch({ notifications: true })).toThrow('not supported');
    expect(() => validateSettingsPatch({ provider: { mode: 'local', baseUrl: 'https://api.example.com/v1', model: 'x' } })).toThrow('localhost/loopback');
  });

  it('validates project and automation mutations without coercing arbitrary values', () => {
    expect(validateProjectMutation({ id: 'project-1' })).toEqual({ id: 'project-1' });
    expect(() => validateProjectMutation({ id: 'project-1', path: 'D:/other' })).toThrow('cannot include');
    expect(() => validateAutomationInput({ prompt: 'x', intervalMinutes: 0 })).toThrow('1 to 10080');
  });

  it('requires exact bounded repository preview and confirm DTOs with portable relative paths', () => {
    const projectId = '30000000-0000-4000-8000-000000000001';
    const previewToken = '40000000-0000-4000-8000-000000000001';
    expect(validateRepositoryPreview({ projectId })).toEqual({ projectId });
    expect(validateRepositoryConfirm({ previewToken, projectId, paths: ['src/index.ts'] }))
      .toEqual({ previewToken, projectId, paths: ['src/index.ts'] });
    expect(() => validateRepositoryPreview({ projectId, root: 'D:/secret' })).toThrow('not supported');
    expect(() => validateRepositoryConfirm({ previewToken, projectId, paths: ['../secret'] })).toThrow('invalid relative path');
    expect(() => validateRepositoryConfirm({ previewToken, projectId, paths: ['D:/secret'] })).toThrow('invalid relative path');
    expect(() => validateRepositoryConfirm({ previewToken, projectId, paths: ['src\\index.ts'] })).toThrow('invalid relative path');
    expect(() => validateRepositoryConfirm({ previewToken, projectId, paths: ['src/index.ts'], userId: projectId })).toThrow('not supported');
    expect(() => validateRepositoryConfirm({ previewToken, projectId, paths: Array.from({ length: 51 }, (_, index) => `src/${index}.ts`) })).toThrow('between 1 and 50');
  });

  it('validates RPC methods, envelopes, cursors, and approval results', () => {
    expect(validateClientRequest({ method: 'thread/list', id: 1, params: { limit: 10 } }, ALLOWED_METHODS).method).toBe('thread/list');
    expect(() => validateClientRequest({ method: 'account/login/start', id: 1, params: {} }, ALLOWED_METHODS)).toThrow('not exposed');
    expect(validateSocketMessage({ type: 'replay', epoch: 'epoch-1', afterSequence: 4 }, ALLOWED_METHODS)).toEqual({ type: 'replay', epoch: 'epoch-1', afterSequence: 4 });
    expect(() => validateSocketMessage({ type: 'replay', afterSequence: -1 }, ALLOWED_METHODS)).toThrow();
    expect(validateServerRequestResult('item/commandExecution/requestApproval', { decision: 'accept' })).toEqual({ decision: 'accept' });
    expect(() => validateServerRequestResult('item/tool/call', {})).toThrow('not implemented');
  });
});
