import { describe, expect, it } from 'vitest';
import { ALLOWED_METHODS } from '../../apps/local-server/src/runtime';
import {
  validateAutomationInput, validateClientRequest, validateProjectMutation, validateServerRequestResult,
  validateSettingsPatch, validateSocketMessage,
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

  it('validates RPC methods, envelopes, cursors, and approval results', () => {
    expect(validateClientRequest({ method: 'thread/list', id: 1, params: { limit: 10 } }, ALLOWED_METHODS).method).toBe('thread/list');
    expect(() => validateClientRequest({ method: 'account/login/start', id: 1, params: {} }, ALLOWED_METHODS)).toThrow('not exposed');
    expect(validateSocketMessage({ type: 'replay', epoch: 'epoch-1', afterSequence: 4 }, ALLOWED_METHODS)).toEqual({ type: 'replay', epoch: 'epoch-1', afterSequence: 4 });
    expect(() => validateSocketMessage({ type: 'replay', afterSequence: -1 }, ALLOWED_METHODS)).toThrow();
    expect(validateServerRequestResult('item/commandExecution/requestApproval', { decision: 'accept' })).toEqual({ decision: 'accept' });
    expect(() => validateServerRequestResult('item/tool/call', {})).toThrow('not implemented');
  });
});
