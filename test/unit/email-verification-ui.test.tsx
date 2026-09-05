import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductAuthGate } from '../../apps/ui/src/auth/AuthGate.js';
import {
  ProductAuthError,
  type ProductAuthClient,
  type ProductAuthContext,
} from '../../apps/ui/src/auth/product-auth.js';

const account: ProductAuthContext = {
  user: {
    id: '10000000-0000-4000-8000-000000000001',
    email: 'pending@example.com',
    displayName: null,
    createdAt: '2026-09-05T00:00:00.000Z',
  },
  workspaces: [{
    id: '20000000-0000-4000-8000-000000000001',
    name: 'Personal Workspace',
    role: 'owner',
    slug: 'personal-test',
  }],
  session: { expiresAt: '2026-09-06T00:00:00.000Z' },
};

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function input(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('email verification pending UI', () => {
  it('supports pending registration, generic resend, and explicit status refresh', async () => {
    const client = {
      sessionGeneration: 0,
      onUnauthenticated: vi.fn(() => () => undefined),
      clearMemory: vi.fn(),
      me: vi.fn()
        .mockRejectedValueOnce(new ProductAuthError('unauthenticated', 'Authentication is required.'))
        .mockResolvedValueOnce(account),
      login: vi.fn(),
      register: vi.fn(async () => ({
        csrfToken: 'C'.repeat(43),
        email: 'pending@example.com',
        status: 'verification_pending' as const,
      })),
      resendEmailVerification: vi.fn(async () => undefined),
      emailVerificationStatus: vi.fn(async () => ({ email: 'pending@example.com', status: 'verified' as const })),
    } as unknown as ProductAuthClient;

    await act(async () => {
      root.render(<ProductAuthGate client={client}>{() => <div data-testid="authenticated">ready</div>}</ProductAuthGate>);
      await flush();
    });
    const registerTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent === '회원가입')!;
    await act(async () => registerTab.click());
    const email = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    const password = container.querySelector<HTMLInputElement>('input[name="password"]')!;
    await act(async () => {
      input(email, 'pending@example.com');
      input(password, 'verification password long enough');
      container.querySelector<HTMLFormElement>('form')!.requestSubmit();
      await flush();
    });
    expect(container.textContent).toContain('이메일 확인이 필요합니다');
    expect(container.textContent).toContain('pending@example.com');

    const resend = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('확인 이메일 다시 보내기'))!;
    await act(async () => { resend.click(); await flush(); });
    expect(client.resendEmailVerification).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('이전 링크는 더 이상 사용할 수 없습니다');

    const status = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('확인 상태 확인'))!;
    await act(async () => { status.click(); await flush(); });
    expect(client.emailVerificationStatus).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="authenticated"]')).not.toBeNull();
  });
});
