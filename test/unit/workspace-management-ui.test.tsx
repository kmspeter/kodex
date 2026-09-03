// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductAuthClient, ProductAuthContext } from '../../apps/ui/src/auth/product-auth';
import { WorkspaceManagementDialog } from '../../apps/ui/src/components/WorkspaceManagementDialog';

const workspaceId = '20000000-0000-4000-8000-000000000001';
const createdId = '20000000-0000-4000-8000-000000000002';
const ownerId = '10000000-0000-4000-8000-000000000001';
const memberId = '10000000-0000-4000-8000-000000000002';
const base: ProductAuthContext = {
  user: { id: ownerId, email: 'owner@example.com', displayName: 'Owner', createdAt: '2026-09-01T00:00:00.000Z' },
  workspaces: [{ id: workspaceId, name: 'Platform', slug: 'platform', role: 'owner' }],
  session: { expiresAt: '2026-09-02T00:00:00.000Z' },
};
const members = [
  { userId: ownerId, email: 'owner@example.com', displayName: 'Owner', role: 'owner' as const, joinedAt: '2026-09-01T00:00:00.000Z' },
  { userId: memberId, email: 'member@example.com', displayName: 'Member', role: 'member' as const, joinedAt: '2026-09-01T01:00:00.000Z' },
];

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('workspace management dialog', () => {
  it('creates a workspace and shows a newly-created invitation link exactly once', async () => {
    const refreshed = { ...base, workspaces: [...base.workspaces, { id: createdId, name: 'New Team', slug: 'workspace-new', role: 'owner' as const }] };
    const invitation = {
      id: '40000000-0000-4000-8000-000000000001', workspaceId, targetEmail: 'member@example.com',
      role: 'member' as const, createdByUserId: ownerId, createdAt: '2026-09-01T02:00:00.000Z', expiresAt: '2026-09-08T02:00:00.000Z',
    };
    const client = {
      workspaceMembers: vi.fn().mockResolvedValue({ members }),
      workspaceInvitations: vi.fn().mockResolvedValue({ invitations: [] }),
      createWorkspace: vi.fn().mockResolvedValue({ id: createdId, name: 'New Team', slug: 'workspace-new', role: 'owner' }),
      createWorkspaceInvitation: vi.fn().mockResolvedValue({ invitation, token: 'A'.repeat(43) }),
      updateWorkspaceMember: vi.fn(), removeWorkspaceMember: vi.fn(),
      me: vi.fn().mockResolvedValue(refreshed),
    } as unknown as ProductAuthClient;
    const onRefresh = vi.fn();
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={base} activeWorkspace={base.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={onRefresh} />);
      await flush();
    });
    expect(Array.from(container.querySelector<HTMLSelectElement>('[aria-label="초대할 역할"]')!.options).map((entry) => entry.value)).toEqual(['admin', 'member', 'viewer']);

    const name = container.querySelector<HTMLInputElement>('input[placeholder="예: Platform Team"]')!;
    await act(async () => { setInput(name, 'New Team'); });
    await act(async () => { container.querySelector<HTMLFormElement>('.workspace-inline-form')!.requestSubmit(); await flush(); });
    expect(client.createWorkspace).toHaveBeenCalledWith('New Team');
    expect(client.me).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith(refreshed, createdId);

    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    await act(async () => { setInput(email, 'member@example.com'); });
    await act(async () => { container.querySelector<HTMLFormElement>('.member-add-form')!.requestSubmit(); await flush(); });
    expect(client.createWorkspaceInvitation).toHaveBeenCalledWith(workspaceId, 'member@example.com', 'member');
    expect(client.me).toHaveBeenCalledTimes(1);
    expect(client.workspaceMembers).toHaveBeenCalledTimes(2);
    expect(client.workspaceInvitations).toHaveBeenCalledTimes(2);
    const link = container.querySelector<HTMLInputElement>('[aria-label="새 workspace 초대 링크"]');
    expect(link?.value).toBe(`${window.location.origin}/#invite=${'A'.repeat(43)}`);
    const dismiss = container.querySelector<HTMLButtonElement>('[aria-label="초대 링크 닫기"]')!;
    await act(async () => { dismiss.click(); });
    expect(container.querySelector('[aria-label="새 workspace 초대 링크"]')).toBeNull();
  });

  it('offers manual selection when clipboard access fails', async () => {
    const invitation = {
      id: '40000000-0000-4000-8000-000000000001', workspaceId, targetEmail: 'member@example.com',
      role: 'viewer' as const, createdByUserId: ownerId, createdAt: '2026-09-01T02:00:00.000Z', expiresAt: '2026-09-08T02:00:00.000Z',
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const client = {
      workspaceMembers: vi.fn().mockResolvedValue({ members }), workspaceInvitations: vi.fn().mockResolvedValue({ invitations: [] }),
      createWorkspaceInvitation: vi.fn().mockResolvedValue({ invitation, token: 'B'.repeat(43) }),
    } as unknown as ProductAuthClient;
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={base} activeWorkspace={base.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    await act(async () => { setInput(email, 'member@example.com'); });
    await act(async () => { container.querySelector<HTMLFormElement>('.member-add-form')!.requestSubmit(); await flush(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('.invitation-copy-row .secondary-action')!.click(); await flush(); });
    expect(container.textContent).toContain('선택된 링크를 직접 복사하세요');
    expect(container.querySelector<HTMLInputElement>('[aria-label="새 workspace 초대 링크"]')?.selectionStart).toBe(0);
  });

  it('shows member/viewer permission guidance and disables every management control', async () => {
    const memberAccount = { ...base, workspaces: [{ ...base.workspaces[0], role: 'member' as const }] };
    const client = { workspaceMembers: vi.fn().mockResolvedValue({ members }), workspaceInvitations: vi.fn() } as unknown as ProductAuthClient;
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={memberAccount} activeWorkspace={memberAccount.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });
    expect(container.textContent).toContain('관리할 수 없습니다');
    expect(container.querySelector('.member-add-form')).toBeNull();
    const memberRole = container.querySelector<HTMLSelectElement>('[aria-label="member@example.com 역할"]');
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="member@example.com 제거"]');
    expect(memberRole?.disabled).toBe(true);
    expect(remove?.disabled).toBe(true);
  });

  it('keeps first-page data while independently retrying and accumulating more pages', async () => {
    const invitationA = {
      id: '40000000-0000-4000-8000-000000000001', workspaceId, targetEmail: 'first@example.com',
      role: 'member' as const, createdByUserId: ownerId, createdAt: '2026-09-01T02:00:00.000Z', expiresAt: '2026-09-08T02:00:00.000Z',
    };
    const invitationB = { ...invitationA, id: '40000000-0000-4000-8000-000000000002', targetEmail: 'second@example.com' };
    const workspaceMembers = vi.fn()
      .mockResolvedValueOnce({ members: [members[0]], nextCursor: 'member_next' })
      .mockRejectedValueOnce(new Error('member page failed'))
      .mockResolvedValueOnce({ members: [members[1]] });
    const workspaceInvitations = vi.fn()
      .mockResolvedValueOnce({ invitations: [invitationA], nextCursor: 'invitation_next' })
      .mockResolvedValueOnce({ invitations: [invitationB] });
    const client = { workspaceMembers, workspaceInvitations } as unknown as ProductAuthClient;
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={base} activeWorkspace={base.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });

    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('멤버 더 보기'))?.click();
      await flush();
    });
    expect(container.textContent).toContain('Owner');
    expect(container.textContent).toContain('member page failed');
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('더 보기 다시 시도'))?.click();
      await flush();
    });
    expect(container.textContent).toContain('Member');
    expect(workspaceMembers).toHaveBeenLastCalledWith(workspaceId, expect.objectContaining({ cursor: 'member_next', limit: 50 }));

    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('초대 더 보기'))?.click();
      await flush();
    });
    expect(container.textContent).toContain('first@example.com');
    expect(container.textContent).toContain('second@example.com');
    expect(workspaceInvitations).toHaveBeenLastCalledWith(workspaceId, expect.objectContaining({ cursor: 'invitation_next', limit: 50 }));
  });

  it('retries a failed initial list without clearing or refetching the successful sibling list', async () => {
    const invitation = {
      id: '40000000-0000-4000-8000-000000000003', workspaceId, targetEmail: 'kept@example.com',
      role: 'member' as const, createdByUserId: ownerId, createdAt: '2026-09-01T02:00:00.000Z', expiresAt: '2026-09-08T02:00:00.000Z',
    };
    const workspaceMembers = vi.fn()
      .mockRejectedValueOnce(new Error('member initial failed'))
      .mockResolvedValueOnce({ members });
    const workspaceInvitations = vi.fn().mockResolvedValue({ invitations: [invitation] });
    const client = { workspaceMembers, workspaceInvitations } as unknown as ProductAuthClient;
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={base} activeWorkspace={base.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });
    expect(container.textContent).toContain('member initial failed');
    expect(container.textContent).toContain('kept@example.com');

    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === '다시 시도')?.click();
      await flush();
    });
    expect(container.textContent).toContain('Owner');
    expect(container.textContent).toContain('kept@example.com');
    expect(workspaceMembers).toHaveBeenCalledTimes(2);
    expect(workspaceInvitations).toHaveBeenCalledTimes(1);
  });

  it('aborts and ignores a previous workspace page when the active workspace changes', async () => {
    const otherWorkspaceId = '20000000-0000-4000-8000-000000000003';
    const otherMember = {
      userId: '10000000-0000-4000-8000-000000000003', email: 'other@example.com', displayName: 'Other',
      role: 'owner' as const, joinedAt: '2026-09-01T00:00:00.000Z',
    };
    let resolveFirst!: (page: { members: typeof members }) => void;
    let firstSignal: AbortSignal | undefined;
    const workspaceMembers = vi.fn((id: string, options: { signal?: AbortSignal }) => {
      if (id === workspaceId) {
        firstSignal = options.signal;
        return new Promise<{ members: typeof members }>((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ members: [otherMember] });
    });
    const client = {
      workspaceMembers,
      workspaceInvitations: vi.fn().mockResolvedValue({ invitations: [] }),
    } as unknown as ProductAuthClient;
    const otherAccount: ProductAuthContext = {
      ...base,
      workspaces: [...base.workspaces, { id: otherWorkspaceId, name: 'Other Workspace', slug: 'other', role: 'owner' }],
    };
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={base} activeWorkspace={base.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });
    const emailInput = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    await act(async () => { setInput(emailInput, 'stale@example.com'); });
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={otherAccount} activeWorkspace={otherAccount.workspaces[1]} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="email"]')?.value).toBe('');
    await act(async () => { resolveFirst({ members }); await flush(); });
    expect(container.textContent).toContain('Other');
    expect(container.textContent).not.toContain('member@example.com');
  });
});
