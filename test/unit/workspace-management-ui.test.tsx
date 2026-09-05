// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCT_WORKSPACE_DELETE_CONFIRMATION } from '@kodex/product-contract';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
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

  it('allows a 100-code-point astral name through create, rename, and archive confirmation', async () => {
    const astralBoundary = '😀'.repeat(100);
    const astralWorkspace = { ...base.workspaces[0], name: astralBoundary };
    const astralAccount: ProductAuthContext = { ...base, workspaces: [astralWorkspace] };
    const client = {
      workspaceMembers: vi.fn().mockResolvedValue({ members }),
      workspaceInvitations: vi.fn().mockResolvedValue({ invitations: [] }),
      createWorkspace: vi.fn().mockResolvedValue({ ...astralWorkspace, id: createdId }),
      renameWorkspace: vi.fn().mockResolvedValue(astralWorkspace),
      archiveWorkspace: vi.fn().mockResolvedValue(undefined),
      me: vi.fn().mockResolvedValue(astralAccount),
    } as unknown as ProductAuthClient;
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={base} activeWorkspace={base.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });

    const createInput = container.querySelector<HTMLInputElement>('input[placeholder="예: Platform Team"]')!;
    const createForm = createInput.closest('form')!;
    expect(createInput.maxLength).toBe(200);
    await act(async () => { setInput(createInput, astralBoundary); });
    expect(createForm.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    await act(async () => { createForm.requestSubmit(); await flush(); });
    expect(client.createWorkspace).toHaveBeenCalledWith(astralBoundary);

    const renameInput = container.querySelector<HTMLInputElement>('[aria-label="새 workspace 이름"]')!;
    const renameForm = renameInput.closest('form')!;
    expect(renameInput.maxLength).toBe(200);
    await act(async () => { setInput(renameInput, astralBoundary); });
    expect(renameForm.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    await act(async () => { renameForm.requestSubmit(); await flush(); });
    expect(client.renameWorkspace).toHaveBeenCalledWith(workspaceId, astralBoundary);

    await act(async () => {
      root.render(<WorkspaceManagementDialog account={astralAccount} activeWorkspace={astralWorkspace} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });
    const archiveInput = container.querySelector<HTMLInputElement>('[aria-label="보관할 workspace 이름 확인"]')!;
    const archiveForm = archiveInput.closest('form')!;
    expect(archiveInput.maxLength).toBe(200);
    await act(async () => { setInput(archiveInput, astralBoundary); });
    expect(archiveForm.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    await act(async () => { archiveForm.requestSubmit(); await flush(); });
    expect(client.archiveWorkspace).toHaveBeenCalledWith(workspaceId, astralBoundary);
  });

  it('defensively blocks over-limit create and rename submissions', async () => {
    const client = {
      workspaceMembers: vi.fn().mockResolvedValue({ members }),
      workspaceInvitations: vi.fn().mockResolvedValue({ invitations: [] }),
      createWorkspace: vi.fn(),
      renameWorkspace: vi.fn(),
    } as unknown as ProductAuthClient;
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={base} activeWorkspace={base.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });

    const createInput = container.querySelector<HTMLInputElement>('input[placeholder="예: Platform Team"]')!;
    const createForm = createInput.closest('form')!;
    await act(async () => { setInput(createInput, 'a'.repeat(101)); });
    expect(createForm.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await act(async () => { createForm.requestSubmit(); await flush(); });
    expect(client.createWorkspace).not.toHaveBeenCalled();

    const renameInput = container.querySelector<HTMLInputElement>('[aria-label="새 workspace 이름"]')!;
    const renameForm = renameInput.closest('form')!;
    await act(async () => { setInput(renameInput, '😀'.repeat(101)); });
    expect(renameForm.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await act(async () => { renameForm.requestSubmit(); await flush(); });
    expect(client.renameWorkspace).not.toHaveBeenCalled();
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

  it('shows rename to owners and admins, archive only to owners, and no lifecycle controls to members', async () => {
    const client = {
      workspaceMembers: vi.fn().mockResolvedValue({ members }),
      workspaceInvitations: vi.fn().mockResolvedValue({ invitations: [] }),
    } as unknown as ProductAuthClient;
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={base} activeWorkspace={base.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });
    expect(container.querySelector('.workspace-rename-form')).not.toBeNull();
    expect(container.querySelector('.workspace-archive-form')).not.toBeNull();
    expect(container.textContent).toContain('새 접근은 즉시 차단');
    expect(container.textContent).toContain('최대 5분 주기의 재인가');

    const adminAccount = { ...base, workspaces: [{ ...base.workspaces[0], role: 'admin' as const }] };
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={adminAccount} activeWorkspace={adminAccount.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });
    expect(container.querySelector('.workspace-rename-form')).not.toBeNull();
    expect(container.querySelector('.workspace-archive-form')).toBeNull();

    const memberAccount = { ...base, workspaces: [{ ...base.workspaces[0], role: 'member' as const }] };
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={memberAccount} activeWorkspace={memberAccount.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });
    expect(container.querySelector('.workspace-rename-form')).toBeNull();
    expect(container.querySelector('.workspace-archive-form')).toBeNull();
    expect(container.textContent).toContain('관리할 수 없습니다');
    expect(container.querySelector('.member-add-form')).toBeNull();
    const memberRole = container.querySelector<HTMLSelectElement>('[aria-label="member@example.com 역할"]');
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="member@example.com 제거"]');
    expect(memberRole?.disabled).toBe(true);
    expect(remove?.disabled).toBe(true);
  });

  it('validates rename input, reports failures, and refreshes the account after success', async () => {
    const refreshed: ProductAuthContext = {
      ...base,
      defaultWorkspace: { ...base.workspaces[0], name: 'Platform Core' },
      workspaces: [{ ...base.workspaces[0], name: 'Platform Core' }],
    };
    const renameWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error('rename denied'))
      .mockResolvedValueOnce({ ...base.workspaces[0], name: 'Platform Core' });
    const client = {
      workspaceMembers: vi.fn().mockResolvedValue({ members }),
      workspaceInvitations: vi.fn().mockResolvedValue({ invitations: [] }),
      renameWorkspace,
      me: vi.fn().mockResolvedValue(refreshed),
    } as unknown as ProductAuthClient;
    const onRefresh = vi.fn();
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={base} activeWorkspace={base.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={onRefresh} />);
      await flush();
    });

    const input = container.querySelector<HTMLInputElement>('[aria-label="새 workspace 이름"]')!;
    const form = container.querySelector<HTMLFormElement>('.workspace-rename-form')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => { setInput(input, ' Platform Core'); });
    expect(submit.disabled).toBe(true);
    await act(async () => { form.requestSubmit(); await flush(); });
    expect(renameWorkspace).not.toHaveBeenCalled();

    await act(async () => { setInput(input, 'Rejected Team'); });
    await act(async () => { form.requestSubmit(); await flush(); });
    expect(renameWorkspace).toHaveBeenCalledWith(workspaceId, 'Rejected Team');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('rename denied');
    expect(client.me).not.toHaveBeenCalled();

    await act(async () => { setInput(input, 'Platform Core'); });
    await act(async () => { form.requestSubmit(); await flush(); });
    expect(renameWorkspace).toHaveBeenLastCalledWith(workspaceId, 'Platform Core');
    expect(client.me).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledWith(refreshed);
  });

  it('requires an exact archive confirmation, prevents duplicate submission, and refreshes after local removal', async () => {
    const archiveResult = deferred<void>();
    const accountResult = deferred<ProductAuthContext>();
    const archiveWorkspace = vi.fn(() => archiveResult.promise);
    const client = {
      workspaceMembers: vi.fn().mockResolvedValue({ members }),
      workspaceInvitations: vi.fn().mockResolvedValue({ invitations: [] }),
      archiveWorkspace,
      me: vi.fn(() => accountResult.promise),
    } as unknown as ProductAuthClient;
    const onArchived = vi.fn();
    const onRefresh = vi.fn();
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={base} activeWorkspace={base.workspaces[0]} client={client} onArchived={onArchived} onClose={vi.fn()} onRefresh={onRefresh} />);
      await flush();
    });

    const input = container.querySelector<HTMLInputElement>('[aria-label="보관할 workspace 이름 확인"]')!;
    const form = container.querySelector<HTMLFormElement>('.workspace-archive-form')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
    await act(async () => { setInput(input, 'platform'); });
    expect(submit.disabled).toBe(true);
    await act(async () => { setInput(input, 'Platform'); });
    expect(submit.disabled).toBe(false);

    await act(async () => {
      form.requestSubmit();
      form.requestSubmit();
      await Promise.resolve();
    });
    expect(archiveWorkspace).toHaveBeenCalledOnce();
    expect(archiveWorkspace).toHaveBeenCalledWith(workspaceId, 'Platform');

    await act(async () => { archiveResult.resolve(undefined); await flush(); });
    expect(onArchived).toHaveBeenCalledWith(ownerId, workspaceId);
    expect(client.me).toHaveBeenCalledOnce();
    expect(onRefresh).not.toHaveBeenCalled();

    const refreshed = { ...base, defaultWorkspace: undefined, workspaces: [] };
    await act(async () => { accountResult.resolve(refreshed); await flush(); });
    expect(onRefresh).toHaveBeenCalledWith(refreshed);
  });

  it('aborts and ignores a delayed archive refresh after the dialog unmounts', async () => {
    const accountResult = deferred<ProductAuthContext>();
    let refreshSignal: AbortSignal | undefined;
    const client = {
      workspaceMembers: vi.fn().mockResolvedValue({ members }),
      workspaceInvitations: vi.fn().mockResolvedValue({ invitations: [] }),
      archiveWorkspace: vi.fn().mockResolvedValue(undefined),
      me: vi.fn((options?: { signal?: AbortSignal }) => {
        refreshSignal = options?.signal;
        return accountResult.promise;
      }),
    } as unknown as ProductAuthClient;
    const onRefresh = vi.fn();
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={base} activeWorkspace={base.workspaces[0]} client={client} onArchived={vi.fn()} onClose={vi.fn()} onRefresh={onRefresh} />);
      await flush();
    });
    await act(async () => {
      setInput(container.querySelector<HTMLInputElement>('[aria-label="보관할 workspace 이름 확인"]')!, 'Platform');
      container.querySelector<HTMLFormElement>('.workspace-archive-form')!.requestSubmit();
      await flush();
    });
    expect(refreshSignal?.aborted).toBe(false);

    await act(async () => root.render(<div>archived workspace removed</div>));
    expect(refreshSignal?.aborted).toBe(true);
    await act(async () => {
      accountResult.resolve({ ...base, defaultWorkspace: undefined, workspaces: [] });
      await flush();
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does not let a stale rename completion unlock or refresh a newer workspace request', async () => {
    const otherWorkspaceId = '20000000-0000-4000-8000-000000000003';
    const otherWorkspace = { id: otherWorkspaceId, name: 'Other Workspace', slug: 'other', role: 'owner' as const };
    const otherAccount: ProductAuthContext = { ...base, defaultWorkspace: otherWorkspace, workspaces: [...base.workspaces, otherWorkspace] };
    const refreshed: ProductAuthContext = {
      ...otherAccount,
      defaultWorkspace: { ...otherWorkspace, name: 'Other Updated' },
      workspaces: [base.workspaces[0], { ...otherWorkspace, name: 'Other Updated' }],
    };
    const first = deferred<(typeof base.workspaces)[number]>();
    const second = deferred<typeof otherWorkspace>();
    const renameWorkspace = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const client = {
      workspaceMembers: vi.fn().mockResolvedValue({ members }),
      workspaceInvitations: vi.fn().mockResolvedValue({ invitations: [] }),
      renameWorkspace,
      me: vi.fn().mockResolvedValue(refreshed),
    } as unknown as ProductAuthClient;
    const onRefresh = vi.fn();
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={base} activeWorkspace={base.workspaces[0]} client={client} onClose={vi.fn()} onRefresh={onRefresh} />);
      await flush();
    });
    await act(async () => { setInput(container.querySelector<HTMLInputElement>('[aria-label="새 workspace 이름"]')!, 'Old Updated'); });
    await act(async () => {
      container.querySelector<HTMLFormElement>('.workspace-rename-form')!.requestSubmit();
      await Promise.resolve();
    });

    await act(async () => {
      root.render(<WorkspaceManagementDialog account={otherAccount} activeWorkspace={otherWorkspace} client={client} onClose={vi.fn()} onRefresh={onRefresh} />);
      await flush();
    });
    const nextForm = container.querySelector<HTMLFormElement>('.workspace-rename-form')!;
    await act(async () => { setInput(container.querySelector<HTMLInputElement>('[aria-label="새 workspace 이름"]')!, 'Other Updated'); });
    await act(async () => { nextForm.requestSubmit(); await Promise.resolve(); });
    expect(renameWorkspace).toHaveBeenCalledTimes(2);

    await act(async () => { first.resolve({ ...base.workspaces[0], name: 'Old Updated' }); await flush(); });
    expect(onRefresh).not.toHaveBeenCalled();
    await act(async () => { nextForm.requestSubmit(); await flush(); });
    expect(renameWorkspace).toHaveBeenCalledTimes(2);

    await act(async () => { second.resolve({ ...otherWorkspace, name: 'Other Updated' }); await flush(); });
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledWith(refreshed);
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
    const renameInput = container.querySelector<HTMLInputElement>('[aria-label="새 workspace 이름"]')!;
    const archiveInput = container.querySelector<HTMLInputElement>('[aria-label="보관할 workspace 이름 확인"]')!;
    await act(async () => {
      setInput(emailInput, 'stale@example.com');
      setInput(renameInput, 'Stale Rename');
      setInput(archiveInput, 'Platform');
    });
    await act(async () => {
      root.render(<WorkspaceManagementDialog account={otherAccount} activeWorkspace={otherAccount.workspaces[1]} client={client} onClose={vi.fn()} onRefresh={vi.fn()} />);
      await flush();
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="email"]')?.value).toBe('');
    expect(container.querySelector<HTMLInputElement>('[aria-label="새 workspace 이름"]')?.value).toBe('Other Workspace');
    expect(container.querySelector<HTMLInputElement>('[aria-label="보관할 workspace 이름 확인"]')?.value).toBe('');
    await act(async () => { resolveFirst({ members }); await flush(); });
    expect(container.textContent).toContain('Other');
    expect(container.textContent).not.toContain('member@example.com');
  });

  it('requires owner password, exact workspace name, and exact permanent-deletion phrase', async () => {
    const deletion = deferred<{
      attemptCount: number; completedAt: null; createdAt: string; id: string;
      kind: 'workspace_delete'; lastErrorCode: null; status: 'pending'; updatedAt: string;
    }>();
    const deleteWorkspace = vi.fn(() => deletion.promise);
    const refreshed = { ...base, workspaces: [] };
    const client = {
      workspaceMembers: vi.fn().mockResolvedValue({ members }),
      workspaceInvitations: vi.fn().mockResolvedValue({ invitations: [] }),
      deleteWorkspace,
      me: vi.fn().mockResolvedValue(refreshed),
    } as unknown as ProductAuthClient;
    const onArchived = vi.fn();
    const onRefresh = vi.fn();
    await act(async () => {
      root.render(<WorkspaceManagementDialog
        account={base}
        activeWorkspace={base.workspaces[0]}
        client={client}
        onArchived={onArchived}
        onClose={vi.fn()}
        onRefresh={onRefresh}
      />);
      await flush();
    });
    expect(container.textContent).toContain('Active runtime lease 또는 legal hold');
    expect(container.textContent).toContain('secure erasure가 아닙니다');
    const passwordInput = container.querySelector<HTMLInputElement>('[aria-label="Workspace 영구 삭제 현재 비밀번호"]')!;
    const nameInput = container.querySelector<HTMLInputElement>('[aria-label="영구 삭제할 Workspace 이름 확인"]')!;
    const confirmationInput = container.querySelector<HTMLInputElement>('[aria-label="Workspace 영구 삭제 확인"]')!;
    const submit = confirmationInput.closest('form')!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => {
      setInput(passwordInput, 'current password');
      setInput(nameInput, 'platform');
      setInput(confirmationInput, PRODUCT_WORKSPACE_DELETE_CONFIRMATION);
    });
    expect(submit.disabled).toBe(true);
    await act(async () => { setInput(nameInput, 'Platform'); });
    expect(submit.disabled).toBe(false);
    await act(async () => {
      confirmationInput.closest('form')!.requestSubmit();
      await flush();
    });
    expect(deleteWorkspace).toHaveBeenCalledWith(
      workspaceId,
      'current password',
      'Platform',
      PRODUCT_WORKSPACE_DELETE_CONFIRMATION,
    );
    expect(passwordInput.value).toBe('');
    expect(nameInput.value).toBe('');
    expect(confirmationInput.value).toBe('');
    expect(submit.disabled).toBe(true);

    await act(async () => {
      deletion.resolve({
        attemptCount: 0,
        completedAt: null,
        createdAt: '2026-09-05T00:00:00.000Z',
        id: '40000000-0000-4000-8000-000000000001',
        kind: 'workspace_delete',
        lastErrorCode: null,
        status: 'pending',
        updatedAt: '2026-09-05T00:00:00.000Z',
      });
      await flush();
    });
    expect(onArchived).toHaveBeenCalledWith(ownerId, workspaceId);
    expect(onRefresh).toHaveBeenCalledWith(refreshed);
  });
});
