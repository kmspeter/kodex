// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductAuthClient, ProductSession } from '../../apps/ui/src/auth/product-auth';
import { SecurityDialog } from '../../apps/ui/src/components/SecurityDialog';

const current: ProductSession = {
  id: '10000000-0000-4000-8000-000000000001',
  current: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  lastSeenAt: '2026-09-01T01:00:00.000Z',
  expiresAt: '2030-09-02T00:00:00.000Z',
  revoked: false,
  revokedAt: null,
};
const other: ProductSession = {
  ...current,
  id: '10000000-0000-4000-8000-000000000002',
  current: false,
};

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

describe('account security dialog', () => {
  it('wipes both password inputs as soon as the request starts and disables destructive actions', async () => {
    let finish!: () => void;
    const changePassword = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const client = {
      sessions: vi.fn().mockResolvedValue([current, other]),
      changePassword,
      revokeSession: vi.fn(),
      revokeOtherSessions: vi.fn(),
      logoutAll: vi.fn(),
    } as unknown as ProductAuthClient;
    await act(async () => {
      root.render(<SecurityDialog client={client} onClose={vi.fn()} />);
      await flush();
    });
    const currentInput = container.querySelector<HTMLInputElement>('[aria-label="현재 비밀번호"]')!;
    const newInput = container.querySelector<HTMLInputElement>('[aria-label="새 비밀번호"]')!;
    await act(async () => {
      setInput(currentInput, 'old password');
      setInput(newInput, 'new password long enough');
    });
    await act(async () => {
      container.querySelector<HTMLFormElement>('.security-password-form')!.requestSubmit();
      await flush();
    });
    expect(changePassword).toHaveBeenCalledWith('old password', 'new password long enough');
    expect(currentInput.value).toBe('');
    expect(newInput.value).toBe('');
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('button')).some(
      (button) => button.textContent?.includes('모든 기기') && button.disabled,
    )).toBe(true);

    await act(async () => { finish(); await flush(); });
    expect(container.textContent).toContain('현재 세션을 제외한 모든 세션을 종료했습니다');
  });

  it('renders loading, retry, empty, revoke, and logout-all states through the real client contract', async () => {
    const sessions = vi.fn()
      .mockRejectedValueOnce(new Error('temporary session error'))
      .mockResolvedValueOnce([current, other])
      .mockResolvedValueOnce([]);
    const client = {
      sessions,
      changePassword: vi.fn(),
      revokeSession: vi.fn().mockResolvedValue(undefined),
      revokeOtherSessions: vi.fn().mockResolvedValue(undefined),
      logoutAll: vi.fn().mockResolvedValue(undefined),
    } as unknown as ProductAuthClient;
    await act(async () => {
      root.render(<SecurityDialog client={client} onClose={vi.fn()} />);
      await flush();
    });
    expect(container.textContent).toContain('temporary session error');
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('다시 시도'))?.click();
      await flush();
    });
    expect(container.textContent).toContain('현재 세션');
    const otherButton = container.querySelector<HTMLButtonElement>(
      `[aria-label="${other.id} 세션 종료"]`,
    )!;
    await act(async () => { otherButton.click(); await flush(); });
    expect(client.revokeSession).toHaveBeenCalledWith(other);
    expect(container.textContent).toContain('표시할 세션이 없습니다');

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('모든 기기에서 로그아웃'))?.click();
      await flush();
    });
    expect(client.logoutAll).toHaveBeenCalledOnce();
  });
});
