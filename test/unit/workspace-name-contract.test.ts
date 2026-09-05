import {
  isValidProductWorkspaceName,
  parseProductArchivedWorkspaces,
  PRODUCT_WORKSPACE_NAME_MAX_UTF16_CODE_UNITS,
} from '@kodex/product-contract';
import { describe, expect, it } from 'vitest';

describe('workspace name contract', () => {
  it('accepts the astral Unicode boundary and exposes a safe HTML maxLength', () => {
    const astralBoundary = '😀'.repeat(100);
    expect(Array.from(astralBoundary)).toHaveLength(100);
    expect(new TextEncoder().encode(astralBoundary)).toHaveLength(400);
    expect(astralBoundary).toHaveLength(PRODUCT_WORKSPACE_NAME_MAX_UTF16_CODE_UNITS);
    expect(isValidProductWorkspaceName(astralBoundary)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    [' padded', 'leading whitespace'],
    ['padded ', 'trailing whitespace'],
    ['two  spaces', 'consecutive whitespace'],
    ['e\u0301', 'non-NFC'],
    ['control\u0000', 'ASCII control'],
    ['delete\u007F', 'DEL'],
    ['surrogate\uD800', 'lone surrogate'],
    ['a'.repeat(101), '101 code points'],
    ['😀'.repeat(101), 'more than 400 UTF-8 bytes'],
  ])('rejects %s (%s)', (value) => {
    expect(isValidProductWorkspaceName(value)).toBe(false);
  });

  it('strictly parses bounded archived workspace pages without lifecycle or secret fields', () => {
    const workspace = {
      archivedAt: '2026-09-05T00:00:00.000Z',
      id: '20000000-0000-4000-8000-000000000001',
      name: 'Archived Team',
      slug: 'workspace-archived',
    };
    expect(parseProductArchivedWorkspaces({ workspaces: [workspace], nextCursor: 'opaque_cursor' }))
      .toEqual({ workspaces: [workspace], nextCursor: 'opaque_cursor' });
    expect(() => parseProductArchivedWorkspaces({
      workspaces: [{ ...workspace, purgeRequestedAt: null }],
    })).toThrow();
    expect(() => parseProductArchivedWorkspaces({
      workspaces: [{ ...workspace, token: 'secret' }],
    })).toThrow();
    expect(() => parseProductArchivedWorkspaces({
      workspaces: Array.from({ length: 101 }, () => workspace),
    })).toThrow();
  });
});
