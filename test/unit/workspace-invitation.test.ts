import {
  parseProductCreatedWorkspaceInvitation,
  parseProductWorkspaceInvitationPreview,
  parseProductWorkspaceInvitations,
  parseProductWorkspaceMembers,
} from '@kodex/product-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  createInvitationShareLink,
  recoverInvitationTokenFromLocation,
} from '../../apps/ui/src/auth/invitation-fragment';

const token = 'A'.repeat(43);
const invitation = {
  createdAt: '2026-09-03T00:00:00.000Z',
  createdByUserId: '10000000-0000-4000-8000-000000000001',
  expiresAt: '2026-09-10T00:00:00.000Z',
  id: '30000000-0000-4000-8000-000000000001',
  role: 'member',
  targetEmail: 'member@example.com',
  workspaceId: '20000000-0000-4000-8000-000000000001',
};

describe('workspace invitation browser boundary', () => {
  it('recovers a fragment token once and removes it from the URL immediately', () => {
    const history = { state: { safe: true }, replaceState: vi.fn() };
    expect(recoverInvitationTokenFromLocation({
      hash: `#invite=${token}`, origin: 'https://kodex.example', pathname: '/app', search: '?mode=desktop',
    }, history)).toBe(token);
    expect(history.replaceState).toHaveBeenCalledWith({ safe: true }, '', '/app?mode=desktop');
    expect(createInvitationShareLink('https://kodex.example', token)).toBe(`https://kodex.example/#invite=${token}`);
  });

  it('removes malformed invite fragments without accepting them', () => {
    const history = { state: null, replaceState: vi.fn() };
    expect(recoverInvitationTokenFromLocation({
      hash: '#invite=too-short', origin: 'https://kodex.example', pathname: '/', search: '',
    }, history)).toBeNull();
    expect(history.replaceState).toHaveBeenCalledOnce();
  });

  it('strictly separates the one-time create DTO from pending and preview DTOs', () => {
    expect(parseProductCreatedWorkspaceInvitation({ invitation, token })).toEqual({ invitation, token });
    expect(parseProductWorkspaceInvitations({ invitations: [invitation] })).toEqual({ invitations: [invitation] });
    expect(parseProductWorkspaceInvitationPreview({
      expiresAt: invitation.expiresAt, role: 'member', targetEmailHint: 'm***@example.com', workspaceName: 'Platform',
    })).toEqual({ expiresAt: invitation.expiresAt, role: 'member', targetEmailHint: 'm***@example.com', workspaceName: 'Platform' });
    expect(() => parseProductWorkspaceInvitations({ invitations: [{ ...invitation, token }] })).toThrow();
    expect(() => parseProductWorkspaceInvitationPreview({
      expiresAt: invitation.expiresAt, role: 'member', targetEmailHint: 'm***@example.com', workspaceName: 'Platform', token,
    })).toThrow();
    expect(() => parseProductCreatedWorkspaceInvitation({ invitation, token, tokenHash: 'secret' })).toThrow();
  });

  it('accepts only exact bounded workspace page envelopes with an optional opaque cursor', () => {
    const member = {
      userId: invitation.createdByUserId,
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
      joinedAt: invitation.createdAt,
    };
    expect(parseProductWorkspaceMembers({ members: [member], nextCursor: 'member_next' }))
      .toEqual({ members: [member], nextCursor: 'member_next' });
    expect(parseProductWorkspaceInvitations({ invitations: [invitation], nextCursor: 'invite_next' }))
      .toEqual({ invitations: [invitation], nextCursor: 'invite_next' });
    expect(() => parseProductWorkspaceMembers({ members: [member], nextCursor: null })).toThrow();
    expect(() => parseProductWorkspaceInvitations({ invitations: [invitation], nextCursor: 'bad!', tokenHash: 'secret' })).toThrow();
    expect(() => parseProductWorkspaceMembers({ members: Array.from({ length: 101 }, () => member) })).toThrow();
  });
});
