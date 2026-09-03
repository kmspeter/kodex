// @vitest-environment jsdom

import type { BootstrapResponse, RepositoryPreviewResponse } from '@kodex/kodex-api';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductAuthClient } from '../../apps/ui/src/auth/product-auth';
import { Dialogs } from '../../apps/ui/src/components/Dialogs';

const workspaceId = '20000000-0000-4000-8000-000000000001';
const projectId = '30000000-0000-4000-8000-000000000001';
const previewToken = '40000000-0000-4000-8000-000000000001';

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function bootstrap(id = projectId): BootstrapResponse {
  return {
    activeProject: { id, name: id === projectId ? 'Consent project' : 'Other project', path: 'D:/private/not-shown', createdAt: 0, lastOpenedAt: 0 },
  } as BootstrapResponse;
}

function props(onLocalRequest: ReturnType<typeof vi.fn>, activeProjectId = projectId): Parameters<typeof Dialogs>[0] {
  const onKnowledgeRequest = vi.fn(async (pathname: string, _init?: RequestInit) => {
    if (pathname.startsWith('/api/knowledge/documents')) return { data: [] };
    return { citations: [] };
  });
  return {
    dialog: 'knowledge' as const,
    bootstrap: bootstrap(activeProjectId),
    automations: [], skills: [], apps: [], plugins: null, mcpServers: [], archivedThreads: [],
    authClient: {} as ProductAuthClient, workspaceId, codexConfig: null,
    onClose: vi.fn(), onError: vi.fn(), onCreateAutomation: vi.fn(), onRunAutomation: vi.fn(),
    onDeleteAutomation: vi.fn(), onSettings: vi.fn(), onAddMcp: vi.fn(), onAddProject: vi.fn(),
    onRemoveProject: vi.fn(), onUnarchive: vi.fn(),
    onKnowledgeRequest: onKnowledgeRequest as unknown as Parameters<typeof Dialogs>[0]['onKnowledgeRequest'],
    onLocalRequest: onLocalRequest as unknown as Parameters<typeof Dialogs>[0]['onLocalRequest'],
  };
}

describe('repository indexing consent UI', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('requires preview, file selection, and explicit consent before sending allowlisted paths', async () => {
    const preview: RepositoryPreviewResponse = {
      previewToken,
      project: { id: projectId, name: 'Consent project' },
      expiresAt: '2026-09-03T01:00:00.000Z',
      files: [{ path: 'src/safe.ts', sizeBytes: 123, status: 'eligible' }],
      excluded: [{ reason: 'credential_or_secret', count: 2 }],
      truncated: false,
      limits: { maxFileBytes: 262_144, maxSelectedFiles: 50, maxTotalBytes: 2_097_152, maxTotalCharacters: 500_000 },
    };
    const onLocalRequest = vi.fn(async (pathname: string, _init?: RequestInit) => {
      if (pathname.endsWith('/preview')) return preview;
      return {
        project: preview.project,
        indexed: 1,
        unchanged: 0,
        files: [{ path: 'src/safe.ts', documentId: '50000000-0000-4000-8000-000000000001', status: 'indexed', chunkCount: 1 }],
      };
    });
    await act(async () => { root.render(<Dialogs {...props(onLocalRequest)} />); await flush(); });

    const previewButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('후보 파일 확인'))!;
    await act(async () => { previewButton.click(); await flush(); });
    expect(container.textContent).toContain('src/safe.ts');
    expect(container.textContent).not.toContain('D:/private/not-shown');

    const confirmButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('선택 파일 인덱싱'))!;
    expect(confirmButton.disabled).toBe(true);
    const candidate = container.querySelector<HTMLInputElement>('[aria-label="Repository candidate files"] input')!;
    await act(async () => candidate.click());
    expect(confirmButton.disabled).toBe(true);
    const consent = container.querySelector<HTMLInputElement>('.repository-consent input')!;
    await act(async () => consent.click());
    expect(confirmButton.disabled).toBe(false);

    await act(async () => { confirmButton.click(); await flush(); });
    expect(onLocalRequest).toHaveBeenCalledTimes(2);
    const confirmCall = onLocalRequest.mock.calls[1]!;
    expect(confirmCall[0]).toBe('/api/knowledge/repository/confirm');
    expect(JSON.parse(String(confirmCall[1]?.body))).toEqual({
      previewToken, projectId, paths: ['src/safe.ts'],
    });
    expect(String(confirmCall[1]?.body)).not.toContain('D:/private');
    expect(container.textContent).toContain('인덱싱 완료');
  });

  it('drops preview and consent when the active project changes', async () => {
    const onLocalRequest = vi.fn(async (_pathname: string, _init?: RequestInit) => ({
      previewToken,
      project: { id: projectId, name: 'Consent project' },
      expiresAt: '2026-09-03T01:00:00.000Z',
      files: [{ path: 'src/safe.ts', sizeBytes: 123, status: 'eligible' }],
      excluded: [], truncated: false,
      limits: { maxFileBytes: 262_144, maxSelectedFiles: 50, maxTotalBytes: 2_097_152, maxTotalCharacters: 500_000 },
    }));
    await act(async () => { root.render(<Dialogs {...props(onLocalRequest)} />); await flush(); });
    const previewButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('후보 파일 확인'))!;
    await act(async () => { previewButton.click(); await flush(); });
    expect(container.textContent).toContain('src/safe.ts');

    await act(async () => { root.render(<Dialogs {...props(onLocalRequest, '30000000-0000-4000-8000-000000000002')} />); await flush(); });
    expect(container.textContent).not.toContain('src/safe.ts');
    expect(container.textContent).toContain('Other project');
  });

  it('discards a late preview response after the active project changes', async () => {
    let resolvePreview!: (value: RepositoryPreviewResponse) => void;
    const onLocalRequest = vi.fn(() => new Promise<RepositoryPreviewResponse>((resolve) => {
      resolvePreview = resolve;
    }));
    await act(async () => { root.render(<Dialogs {...props(onLocalRequest)} />); await flush(); });
    const previewButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('후보 파일 확인'))!;
    await act(async () => { previewButton.click(); await Promise.resolve(); });

    await act(async () => {
      root.render(<Dialogs {...props(onLocalRequest, '30000000-0000-4000-8000-000000000002')} />);
      await flush();
    });
    await act(async () => {
      resolvePreview({
        previewToken,
        project: { id: projectId, name: 'Consent project' },
        expiresAt: '2026-09-03T01:00:00.000Z',
        files: [{ path: 'src/old-project-secret-name.ts', sizeBytes: 123, status: 'eligible' }],
        excluded: [], truncated: false,
        limits: { maxFileBytes: 262_144, maxSelectedFiles: 50, maxTotalBytes: 2_097_152, maxTotalCharacters: 500_000 },
      });
      await flush();
    });
    expect(container.textContent).not.toContain('old-project-secret-name.ts');
    expect(container.textContent).toContain('Other project');
  });

  it('renders permission failures without exposing files and provides an explicit cancellation state', async () => {
    const forbidden = vi.fn(async (_pathname: string, _init?: RequestInit) => {
      throw new Error('Workspace access is not permitted.');
    });
    await act(async () => { root.render(<Dialogs {...props(forbidden)} />); await flush(); });
    let previewButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('후보 파일 확인'))!;
    await act(async () => { previewButton.click(); await flush(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Workspace access is not permitted');
    expect(container.textContent).not.toContain('src/safe.ts');

    const pending = vi.fn((_pathname: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await act(async () => { root.render(<Dialogs {...props(pending)} />); await flush(); });
    previewButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('후보 파일 확인'))!;
    await act(async () => { previewButton.click(); await Promise.resolve(); });
    const cancelButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === '취소')!;
    await act(async () => { cancelButton.click(); await flush(); });
    expect(container.textContent).toContain('요청 표시를 취소했습니다');
  });
});
