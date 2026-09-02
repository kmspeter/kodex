// @vitest-environment jsdom

import type { BootstrapResponse } from '@kodex/kodex-api';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductWorkspaceApp } from '../../apps/ui/src/App';
import type { ProductAuthClient, ProductAuthContext } from '../../apps/ui/src/auth/product-auth';
import type { KodexClient } from '../../apps/ui/src/client/kodex-client';

const workspaceA = '20000000-0000-4000-8000-000000000001';
const workspaceB = '20000000-0000-4000-8000-000000000002';
const workspaceViewer = '20000000-0000-4000-8000-000000000003';

const account: ProductAuthContext = {
  user: {
    id: '10000000-0000-4000-8000-000000000001',
    email: 'person@example.com',
    displayName: 'Person',
    createdAt: '2026-09-01T00:00:00.000Z',
  },
  defaultWorkspace: { id: workspaceA, name: 'Alpha', slug: 'alpha', role: 'owner' },
  workspaces: [
    { id: workspaceA, name: 'Alpha', slug: 'alpha', role: 'owner' },
    { id: workspaceB, name: 'Beta', slug: 'beta', role: 'member' },
    { id: workspaceViewer, name: 'Read only', slug: 'read-only', role: 'viewer' },
  ],
  session: { expiresAt: '2026-09-02T12:00:00.000Z' },
};

const bootstrap: BootstrapResponse = {
  product: 'Kodex',
  csrfToken: 'csrf',
  sessionToken: 'session',
  apiBaseUrl: 'http://127.0.0.1:47831',
  engine: {
    state: 'ready', message: 'Ready', apiKeyConfigured: true, binary: 'codex.exe',
    binarySource: 'local', version: 'test', pid: 1, restartCount: 0,
    consecutiveFailures: 0, providerMode: 'openai', providerModel: null, transport: 'stdio JSONL',
  },
  settings: {
    sandbox: 'workspace-write', approvalPolicy: 'on-request',
    network: { shell: false, webSearch: false },
    provider: { mode: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' },
    lastProjectId: 'project-1', sidebarOpen: true, detailPanelOpen: false,
  },
  projects: [{ id: 'project-1', name: 'Project', path: 'D:\\project', createdAt: 1, lastOpenedAt: 1 }],
  activeProject: { id: 'project-1', name: 'Project', path: 'D:\\project', createdAt: 1, lastOpenedAt: 1 },
  automations: [],
  capabilities: {
    localState: true, cloudBackend: false, webSearch: false, remoteMcp: false,
    apps: false, plugins: false, hostDynamicTools: false,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function fakeClient(start: Promise<BootstrapResponse>) {
  return {
    start: vi.fn(() => start),
    close: vi.fn(),
    onConnection: vi.fn(() => () => undefined),
    subscribe: vi.fn(() => () => undefined),
    http: vi.fn(),
    rpc: vi.fn(),
    sendServerResponse: vi.fn(),
    sendServerError: vi.fn(),
  } as unknown as KodexClient;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('workspace switching UI', () => {
  it('lists roles and accessible current/viewer states, then closes the old client before booting the selection', async () => {
    const betaStart = deferred<BootstrapResponse>();
    const alphaClient = fakeClient(Promise.resolve(bootstrap));
    const betaClient = fakeClient(betaStart.promise);
    const clients = new Map([[workspaceA, alphaClient], [workspaceB, betaClient]]);
    const createClient = vi.fn((workspaceId: string) => clients.get(workspaceId)!);
    const authClient = {} as ProductAuthClient;

    await act(async () => {
      root.render(<ProductWorkspaceApp account={account} authClient={authClient} loggingOut={false} onLogout={vi.fn()} createClient={createClient} />);
      await flush();
    });
    const accountButton = container.querySelector<HTMLButtonElement>('.account-button')!;
    expect(accountButton.getAttribute('aria-label')).toContain('Alpha workspace, owner 역할');
    await act(async () => accountButton.click());

    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('.workspace-option'));
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Alphaowner 현재'),
      expect.stringContaining('Betamember전환'),
      expect.stringContaining('Read onlyviewer실행 불가'),
    ]);
    expect(options[0]?.getAttribute('aria-current')).toBe('true');
    expect(options[0]?.disabled).toBe(true);
    expect(options[2]?.disabled).toBe(true);

    await act(async () => options[1]?.click());
    expect(alphaClient.close).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenLastCalledWith(workspaceB);
    expect(container.textContent).toContain('Beta workspace runtime에 연결하는 중');
    expect(container.textContent).toContain('진행 중인 turn은 서버 정책에 따라 계속될 수 있습니다');
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    await act(async () => {
      betaStart.resolve(bootstrap);
      await flush();
    });
    const betaAccountButton = container.querySelector<HTMLButtonElement>('.account-button')!;
    expect(betaAccountButton.getAttribute('aria-label')).toContain('Beta workspace, member 역할');
    await act(async () => betaAccountButton.click());
    const current = container.querySelector<HTMLButtonElement>('.workspace-option[aria-current="true"]');
    expect(current?.textContent).toContain('Beta');
  });

  it('preserves a selected membership on fresh context, scopes knowledge/history, and falls back on downgrade', async () => {
    const clients: Array<{ workspaceId: string; client: KodexClient }> = [];
    const createClient = vi.fn((workspaceId: string) => {
      const client = fakeClient(Promise.resolve(bootstrap));
      clients.push({ workspaceId, client });
      return client;
    });
    const knowledge = vi.fn().mockResolvedValue({ data: [] });
    const historyThreads = vi.fn().mockResolvedValue({ threads: [], nextCursor: null });
    const authClient = { knowledge, historyThreads } as unknown as ProductAuthClient;
    const render = (nextAccount: ProductAuthContext) => root.render(<ProductWorkspaceApp
      account={nextAccount} authClient={authClient} loggingOut={false}
      onLogout={vi.fn()} createClient={createClient}
    />);

    await act(async () => { render(account); await flush(); });
    await act(async () => container.querySelector<HTMLButtonElement>('.account-button')?.click());
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.workspace-option'))
        .find((button) => button.textContent?.includes('Beta'))?.click();
      await flush();
    });
    expect(clients.at(-1)?.workspaceId).toBe(workspaceB);

    await act(async () => { render({ ...account, workspaces: [...account.workspaces] }); await flush(); });
    expect(clients.at(-1)?.workspaceId).toBe(workspaceB);
    expect(createClient.mock.calls.filter(([id]) => id === workspaceB)).toHaveLength(1);

    await act(async () => container.querySelectorAll<HTMLButtonElement>('.sidebar-item')[3]?.click());
    await act(flush);
    expect(knowledge).toHaveBeenCalledWith('/api/knowledge/documents?limit=100', workspaceB, undefined);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click());
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.sidebar-item')[4]?.click());
    await act(flush);
    expect(historyThreads).toHaveBeenCalledWith(workspaceB, expect.objectContaining({ limit: 20 }));

    const downgraded: ProductAuthContext = {
      ...account,
      workspaces: account.workspaces.map((workspace) => workspace.id === workspaceB
        ? { ...workspace, role: 'viewer' }
        : workspace),
    };
    await act(async () => { render(downgraded); await flush(); });
    expect(clients.find((entry) => entry.workspaceId === workspaceB)?.client.close).toHaveBeenCalledOnce();
    expect(clients.at(-1)?.workspaceId).toBe(workspaceA);
  });

  it('drops the previous user selection and does not create a runtime for viewer-only access', async () => {
    const createClient = vi.fn(() => fakeClient(Promise.resolve(bootstrap)));
    const authClient = {} as ProductAuthClient;
    const otherWorkspace = '20000000-0000-4000-8000-000000000004';
    const otherUser: ProductAuthContext = {
      ...account,
      user: { ...account.user, id: '10000000-0000-4000-8000-000000000002' },
      defaultWorkspace: { id: otherWorkspace, name: 'Other', slug: 'other', role: 'admin' },
      workspaces: [{ id: otherWorkspace, name: 'Other', slug: 'other', role: 'admin' }],
    };
    await act(async () => { root.render(<ProductWorkspaceApp account={account} authClient={authClient} loggingOut={false} onLogout={vi.fn()} createClient={createClient} />); await flush(); });
    await act(async () => { root.render(<ProductWorkspaceApp account={otherUser} authClient={authClient} loggingOut={false} onLogout={vi.fn()} createClient={createClient} />); await flush(); });
    expect(createClient).toHaveBeenLastCalledWith(otherWorkspace);
    await act(async () => container.querySelector<HTMLButtonElement>('.account-button')?.click());
    expect(container.querySelector('.workspace-selector')).toBeNull();

    const viewerOnly = {
      ...otherUser,
      defaultWorkspace: { id: workspaceViewer, name: 'Read only', slug: 'read-only', role: 'viewer' as const },
      workspaces: [{ id: workspaceViewer, name: 'Read only', slug: 'read-only', role: 'viewer' as const }],
    };
    await act(async () => { root.render(<ProductWorkspaceApp account={viewerOnly} authClient={authClient} loggingOut={false} onLogout={vi.fn()} createClient={createClient} />); await flush(); });
    expect(container.textContent).toContain('실행 가능한 workspace가 없습니다');
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});
