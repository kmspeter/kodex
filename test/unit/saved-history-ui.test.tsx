// @vitest-environment jsdom

import type { ProductHistoryThreadDetailDto, ProductHistoryThreadPageDto } from '@kodex/product-contract';
import type { BootstrapResponse } from '@kodex/kodex-api';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductAuthClient } from '../../apps/ui/src/auth/product-auth';
import { Dialogs } from '../../apps/ui/src/components/Dialogs';
import { SavedHistoryDialog, downloadSavedHistoryJson } from '../../apps/ui/src/components/SavedHistoryDialog';

const workspaceId = '20000000-0000-4000-8000-000000000001';
const thread = {
  threadId: 'thread-1', title: 'DB 기록', projectName: '제품', status: 'active' as const,
  createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T01:00:00.000Z',
};

function page(nextCursor: string | null, suffix = ''): ProductHistoryThreadPageDto {
  return { nextCursor, threads: [{ ...thread, threadId: `thread-1${suffix}`, title: `DB 기록${suffix}` }] };
}

function detail(nextCursor: string | null, suffix = ''): ProductHistoryThreadDetailDto {
  const turnId = `turn-1${suffix}`;
  return {
    thread,
    nextCursor,
    omitted: { items: false, toolCalls: false, approvals: false },
    turns: [{ turnId, status: 'completed', startedAt: '2026-08-31T00:00:00.000Z', completedAt: '2026-08-31T00:01:00.000Z' }],
    items: [{
      itemId: `item-1${suffix}`, turnId, itemType: 'agentMessage', role: 'assistant', status: 'completed',
      startedAt: '2026-08-31T00:00:00.000Z', completedAt: '2026-08-31T00:01:00.000Z',
      payload: { content: JSON.stringify({ text: `답변${suffix}` }), truncated: false },
    }],
    toolCalls: [],
    approvals: [],
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
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
  vi.restoreAllMocks();
});

describe('saved DB history UI', () => {
  it('shows loading and empty states explicitly', async () => {
    const pending = deferred<ProductHistoryThreadPageDto>();
    const client = {
      historyThreads: vi.fn().mockReturnValue(pending.promise),
      historyThread: vi.fn(),
    } as unknown as ProductAuthClient;
    await act(async () => { root.render(<SavedHistoryDialog client={client} workspaceId={workspaceId} />); });
    expect(container.textContent).toContain('목록을 불러오는 중');
    await act(async () => { pending.resolve({ nextCursor: null, threads: [] }); await flush(); });
    expect(container.textContent).toContain('저장된 내 DB 히스토리가 없습니다');
  });

  it('loads list/detail pages separately and labels the async DB boundary', async () => {
    const historyThreads = vi.fn()
      .mockResolvedValueOnce(page('list-next'))
      .mockResolvedValueOnce(page(null, '-2'));
    const historyThread = vi.fn()
      .mockResolvedValueOnce(detail('detail-next'))
      .mockResolvedValueOnce(detail(null, '-2'));
    const client = { historyThreads, historyThread } as unknown as ProductAuthClient;

    await act(async () => { root.render(<SavedHistoryDialog client={client} workspaceId={workspaceId} />); await flush(); });
    expect(container.textContent).toContain('최신 대화는 잠시 늦게');
    expect(container.textContent).toContain('공식 Codex 사이드바·스레드의 실행 상태와는 별도');
    const firstThread = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('DB 기록'))!;
    await act(async () => { firstThread.click(); await flush(); });
    expect(container.textContent).toContain('item · agentMessage');
    expect(container.textContent).toContain('assistant · completed');

    const listMore = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '목록 더 보기')!;
    await act(async () => { listMore.click(); await flush(); });
    expect(historyThreads).toHaveBeenLastCalledWith(workspaceId, expect.objectContaining({ cursor: 'list-next', limit: 20 }));
    expect(container.textContent).toContain('DB 기록-2');

    const detailMore = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '상세 더 보기')!;
    await act(async () => { detailMore.click(); await flush(); });
    expect(historyThread).toHaveBeenLastCalledWith(workspaceId, 'thread-1', expect.objectContaining({ cursor: 'detail-next', limit: 20 }));
    expect(container.textContent).toContain('turn-1-2');
  });

  it('shows explicit list and detail errors with retry', async () => {
    const historyThreads = vi.fn().mockRejectedValueOnce(new Error('목록 실패')).mockResolvedValueOnce(page(null));
    const historyThread = vi.fn().mockRejectedValueOnce(new Error('상세 실패')).mockResolvedValueOnce(detail(null));
    const client = { historyThreads, historyThread } as unknown as ProductAuthClient;
    await act(async () => { root.render(<SavedHistoryDialog client={client} workspaceId={workspaceId} />); await flush(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('목록 실패');
    const listRetry = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '다시 시도')!;
    await act(async () => { listRetry.click(); await flush(); });
    const firstThread = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('DB 기록'))!;
    await act(async () => { firstThread.click(); await flush(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('상세 실패');
    const detailRetry = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '다시 시도')!;
    await act(async () => { detailRetry.click(); await flush(); });
    expect(container.textContent).toContain('item · agentMessage');
  });

  it('revokes the temporary JSON export URL after clicking the download', () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:safe-history');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    downloadSavedHistoryJson(detail(null), 'thread/unsafe');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:safe-history');
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('ignores a stale detail response after the user selects another thread', async () => {
    const first = deferred<ProductHistoryThreadDetailDto>();
    const second = deferred<ProductHistoryThreadDetailDto>();
    const secondThread = { ...thread, threadId: 'thread-2', title: '두 번째 기록' };
    const historyThread = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const client = {
      historyThreads: vi.fn().mockResolvedValue({ nextCursor: null, threads: [thread, secondThread] }),
      historyThread,
    } as unknown as ProductAuthClient;
    await act(async () => { root.render(<SavedHistoryDialog client={client} workspaceId={workspaceId} />); await flush(); });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.saved-history-thread'));
    await act(async () => { buttons[0]?.click(); buttons[1]?.click(); await flush(); });
    await act(async () => {
      second.resolve({ ...detail(null, '-new'), thread: secondThread });
      await flush();
    });
    expect(container.textContent).toContain('답변-new');
    await act(async () => { first.resolve(detail(null, '-old')); await flush(); });
    expect(container.textContent).toContain('답변-new');
    expect(container.textContent).not.toContain('답변-old');
  });

  it('exposes an accessible modal and closes it with Escape without touching Codex thread state', async () => {
    const onClose = vi.fn();
    const client = {
      historyThreads: vi.fn().mockResolvedValue({ nextCursor: null, threads: [] }),
      historyThread: vi.fn(),
    } as unknown as ProductAuthClient;
    const props = {
      dialog: 'history', bootstrap: {} as BootstrapResponse, automations: [], skills: [], apps: [],
      plugins: null, mcpServers: [], archivedThreads: [], authClient: client, workspaceId,
      codexConfig: null, onClose, onError: vi.fn(), onCreateAutomation: vi.fn(),
      onRunAutomation: vi.fn(), onDeleteAutomation: vi.fn(), onSettings: vi.fn(),
      onAddMcp: vi.fn(), onAddProject: vi.fn(), onRemoveProject: vi.fn(), onUnarchive: vi.fn(),
      onKnowledgeRequest: vi.fn(),
    } as unknown as Parameters<typeof Dialogs>[0];
    await act(async () => { root.render(<Dialogs {...props} />); await flush(); });
    const modal = container.querySelector('[role="dialog"]');
    expect(modal?.getAttribute('aria-modal')).toBe('true');
    expect(modal?.getAttribute('aria-labelledby')).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(client.historyThreads).toHaveBeenCalledOnce();
    expect(client.historyThread).not.toHaveBeenCalled();
  });
});
