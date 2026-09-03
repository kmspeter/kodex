// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductAuthGate } from '../../apps/ui/src/auth/AuthGate';
import {
  ProductAuthError,
  type ProductAuthClient,
  type ProductAuthContext,
} from '../../apps/ui/src/auth/product-auth';

const token = 'T'.repeat(43);
const workspaceId = '20000000-0000-4000-8000-000000000001';
const account: ProductAuthContext = {
  user: { id: '10000000-0000-4000-8000-000000000001', email: 'invitee@example.com', displayName: 'Invitee', createdAt: '2026-09-01T00:00:00.000Z' },
  workspaces: [{ id: workspaceId, name: 'Platform', slug: 'platform', role: 'member' }],
  session: { expiresAt: '2099-09-01T00:00:00.000Z' },
};

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
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

describe('workspace invitation AuthGate flow', () => {
  it('previews while unauthenticated, logs in, accepts, revalidates /me, and enters the invited workspace', async () => {
    const client = {
      me: vi.fn()
        .mockRejectedValueOnce(new ProductAuthError('unauthenticated', 'Authentication is required.', 401, 'unauthenticated'))
        .mockResolvedValue(account),
      previewWorkspaceInvitation: vi.fn().mockResolvedValue({
        workspaceName: 'Platform', targetEmailHint: 'i***@example.com', role: 'member', expiresAt: '2026-09-10T00:00:00.000Z',
      }),
      login: vi.fn().mockResolvedValue({ ...account, workspaces: [] }),
      register: vi.fn(),
      acceptWorkspaceInvitation: vi.fn().mockResolvedValue(account.workspaces[0]),
      onUnauthenticated: vi.fn().mockReturnValue(() => undefined),
      clearMemory: vi.fn(),
    } as unknown as ProductAuthClient;

    await act(async () => {
      root.render(<ProductAuthGate client={client} initialInvitationToken={token}>{(context) => <div data-testid="workspace">{context.defaultWorkspace?.id}</div>}</ProductAuthGate>);
      await flush();
    });
    expect(client.previewWorkspaceInvitation).toHaveBeenCalledWith(token);
    expect(container.textContent).toContain('Platform 초대');

    const [email, password] = Array.from(container.querySelectorAll<HTMLInputElement>('input')).filter((entry) => ['email', 'password'].includes(entry.type));
    await act(async () => { setInput(email, 'invitee@example.com'); setInput(password, 'correct horse battery staple'); });
    await act(async () => { container.querySelector<HTMLFormElement>('form')!.requestSubmit(); await flush(); });
    expect(container.textContent).toContain('초대 수락');
    await act(async () => { container.querySelector<HTMLButtonElement>('.invitation-accept-card .auth-submit')!.click(); await flush(); });
    expect(client.acceptWorkspaceInvitation).toHaveBeenCalledWith(token);
    expect(client.me).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="workspace"]')?.textContent).toBe(workspaceId);
    expect(container.textContent).not.toContain(token);
  });
});
