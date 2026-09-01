import type {
  ProductHistoryApprovalDto,
  ProductHistoryItemDto,
  ProductHistoryPreviewDto,
  ProductHistoryThreadDetailDto,
  ProductHistoryThreadSummaryDto,
  ProductHistoryToolCallDto,
  ProductHistoryTurnDto,
} from '@kodex/product-contract';
import { Database, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProductAuthClient } from '../auth/product-auth';

const PAGE_SIZE = 20;

function displayTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ko-KR') : '—';
}

function Preview({ value, label }: { value: ProductHistoryPreviewDto; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const locallyLong = value.content.length > 600;
  const content = !expanded && locallyLong ? `${value.content.slice(0, 600)}…` : value.content;
  return <div className="saved-history-preview">
    <span>{label}{value.truncated ? ' · 서버에서 제한됨' : ''}</span>
    <pre>{content}</pre>
    {locallyLong && <button className="history-expand" type="button" onClick={() => setExpanded((current) => !current)}>{expanded ? '접기' : '펼치기'}</button>}
  </div>;
}

function ItemEntry({ item }: { item: ProductHistoryItemDto }) {
  return <article className="saved-history-entry">
    <header><strong>item · {item.itemType}</strong><span>{item.role ?? 'role 없음'} · {item.status} · {displayTime(item.startedAt)}</span></header>
    <Preview value={item.payload} label="payload" />
  </article>;
}

function ToolEntry({ call }: { call: ProductHistoryToolCallDto }) {
  return <article className="saved-history-entry">
    <header><strong>tool · {call.toolName}</strong><span>{call.status} · {displayTime(call.requestedAt)}</span></header>
    <Preview value={call.arguments} label="arguments" />
    {call.result && <Preview value={call.result} label="result" />}
  </article>;
}

function ApprovalEntry({ approval }: { approval: ProductHistoryApprovalDto }) {
  return <article className="saved-history-entry is-approval">
    <header><strong>approval · {approval.approvalType}</strong><span>{approval.status} · {displayTime(approval.requestedAt)}</span></header>
    <Preview value={approval.requestPayload} label="request" />
    {approval.responsePayload && <Preview value={approval.responsePayload} label="response" />}
  </article>;
}

function TurnSection(props: {
  approvals: ProductHistoryApprovalDto[];
  items: ProductHistoryItemDto[];
  toolCalls: ProductHistoryToolCallDto[];
  turn: ProductHistoryTurnDto;
}) {
  return <section className="saved-history-turn">
    <header><div><strong>turn</strong><code>{props.turn.turnId}</code></div><span>{props.turn.status} · {displayTime(props.turn.startedAt)}</span></header>
    <div className="saved-history-events">
      {props.items.map((item) => <ItemEntry item={item} key={`item:${item.itemId}`} />)}
      {props.toolCalls.map((call) => <ToolEntry call={call} key={`tool:${call.callId}`} />)}
      {props.approvals.map((approval) => <ApprovalEntry approval={approval} key={`approval:${approval.requestId}`} />)}
      {props.items.length + props.toolCalls.length + props.approvals.length === 0 && <p className="dialog-empty">이 turn에 저장된 항목이 없습니다.</p>}
    </div>
  </section>;
}

export function downloadSavedHistoryJson(value: unknown, threadId: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `kodex-saved-history-${threadId.replace(/[^A-Za-z0-9_-]/gu, '_')}.json`;
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

export function SavedHistoryDialog(props: { client: ProductAuthClient; workspaceId: string }) {
  const [threads, setThreads] = useState<ProductHistoryThreadSummaryDto[]>([]);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProductHistoryThreadSummaryDto | null>(null);
  const [detail, setDetail] = useState<ProductHistoryThreadDetailDto | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [listRetry, setListRetry] = useState<{ cursor?: string; replace: boolean }>({ replace: true });
  const [detailRetryCursor, setDetailRetryCursor] = useState<string | undefined>();
  const listGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);

  const loadThreads = useCallback(async (cursor?: string, replace = false): Promise<void> => {
    const generation = ++listGenerationRef.current;
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    setLoadingList(true);
    setListError('');
    try {
      const page = await props.client.historyThreads(props.workspaceId, {
        cursor,
        limit: PAGE_SIZE,
        signal: controller.signal,
      });
      if (generation !== listGenerationRef.current) return;
      setThreads((current) => replace ? page.threads : [...current, ...page.threads]);
      setListCursor(page.nextCursor);
      setListRetry({ replace: true });
    } catch (reason) {
      if (generation !== listGenerationRef.current) return;
      setListError(reason instanceof Error ? reason.message : String(reason));
      setListRetry({ cursor, replace });
    } finally {
      if (generation === listGenerationRef.current) {
        listAbortRef.current = null;
        setLoadingList(false);
      }
    }
  }, [props.client, props.workspaceId]);

  useEffect(() => {
    void loadThreads(undefined, true);
    return () => {
      listGenerationRef.current += 1;
      detailGenerationRef.current += 1;
      listAbortRef.current?.abort();
      detailAbortRef.current?.abort();
    };
  }, [loadThreads]);

  const loadDetail = useCallback(async (thread: ProductHistoryThreadSummaryDto, cursor?: string): Promise<void> => {
    const generation = ++detailGenerationRef.current;
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setLoadingDetail(true);
    setDetailError('');
    try {
      const page = await props.client.historyThread(props.workspaceId, thread.threadId, {
        cursor,
        limit: PAGE_SIZE,
        signal: controller.signal,
      });
      if (generation !== detailGenerationRef.current) return;
      setDetail((current) => !cursor || !current ? page : {
        ...page,
        turns: [...current.turns, ...page.turns],
        items: [...current.items, ...page.items],
        toolCalls: [...current.toolCalls, ...page.toolCalls],
        approvals: [...current.approvals, ...page.approvals],
        omitted: {
          items: current.omitted.items || page.omitted.items,
          toolCalls: current.omitted.toolCalls || page.omitted.toolCalls,
          approvals: current.omitted.approvals || page.omitted.approvals,
        },
      });
      setDetailRetryCursor(undefined);
    } catch (reason) {
      if (generation !== detailGenerationRef.current) return;
      setDetailError(reason instanceof Error ? reason.message : String(reason));
      setDetailRetryCursor(cursor);
    } finally {
      if (generation === detailGenerationRef.current) {
        detailAbortRef.current = null;
        setLoadingDetail(false);
      }
    }
  }, [props.client, props.workspaceId]);

  function selectThread(thread: ProductHistoryThreadSummaryDto): void {
    setSelected(thread);
    setDetail(null);
    setDetailError('');
    void loadDetail(thread);
  }

  const unassignedApprovals = useMemo(() => detail?.approvals.filter((approval) => approval.turnId === null) ?? [], [detail]);

  return <div className="dialog-body saved-history-dialog">
    <div className="dialog-intro"><div className="dialog-icon"><Database size={20} /></div><div><h3>저장된 DB 히스토리</h3><p>Product DB에 비동기로 투영된 현재 사용자의 기록입니다. 최신 대화는 잠시 늦게 나타날 수 있으며, 공식 Codex 사이드바·스레드의 실행 상태와는 별도입니다.</p></div></div>
    <div className="saved-history-layout">
      <section className="saved-history-list" aria-label="저장된 DB 히스토리 목록" aria-busy={loadingList}>
        <header><strong>저장된 스레드</strong><button className="icon-button" aria-label="목록 다시 시도" disabled={loadingList} onClick={() => void loadThreads(undefined, true)}><RefreshCw size={13} /></button></header>
        {listError && <div className="saved-history-error" role="alert"><span>{listError}</span><button className="secondary-action" onClick={() => void loadThreads(listRetry.cursor, listRetry.replace)}>다시 시도</button></div>}
        {!listError && threads.map((thread) => <button className={`saved-history-thread ${selected?.threadId === thread.threadId ? 'is-current' : ''}`} key={thread.threadId} onClick={() => selectThread(thread)}><strong>{thread.title ?? '제목 없는 스레드'}</strong><span>{thread.projectName} · {thread.status}</span><time>{displayTime(thread.updatedAt)}</time></button>)}
        {!listError && !loadingList && threads.length === 0 && <p className="dialog-empty">이 workspace에 저장된 내 DB 히스토리가 없습니다.</p>}
        {loadingList && <p className="dialog-empty"><LoaderCircle className="spin" size={13} /> 목록을 불러오는 중…</p>}
        {!loadingList && listCursor && <button className="secondary-action history-more" onClick={() => void loadThreads(listCursor)}>목록 더 보기</button>}
      </section>
      <section className="saved-history-detail" aria-label="저장된 DB 히스토리 상세" aria-busy={loadingDetail}>
        {!selected && <p className="dialog-empty">왼쪽에서 저장된 스레드를 선택하세요.</p>}
        {selected && <header className="saved-history-detail-heading"><div><strong>{selected.title ?? '제목 없는 스레드'}</strong><span>{selected.projectName} · {selected.status}</span></div>{detail && <button className="secondary-action" onClick={() => downloadSavedHistoryJson(detail, selected.threadId)}><Download size={12} /> 안전한 JSON 내보내기</button>}</header>}
        {detailError && selected && <div className="saved-history-error" role="alert"><span>{detailError}</span><button className="secondary-action" onClick={() => void loadDetail(selected, detailRetryCursor)}>다시 시도</button></div>}
        {loadingDetail && !detail && <p className="dialog-empty"><LoaderCircle className="spin" size={13} /> 상세를 불러오는 중…</p>}
        {detail && <div className="saved-history-turns">
          {unassignedApprovals.length > 0 && <section className="saved-history-turn"><header><strong>thread approvals</strong></header>{unassignedApprovals.map((approval) => <ApprovalEntry approval={approval} key={approval.requestId} />)}</section>}
          {detail.turns.map((turn) => <TurnSection key={turn.turnId} turn={turn} items={detail.items.filter((item) => item.turnId === turn.turnId)} toolCalls={detail.toolCalls.filter((call) => call.turnId === turn.turnId)} approvals={detail.approvals.filter((approval) => approval.turnId === turn.turnId)} />)}
          {!loadingDetail && detail.turns.length === 0 && unassignedApprovals.length === 0 && <p className="dialog-empty">저장된 turn 또는 이벤트가 없습니다.</p>}
          {(detail.omitted.items || detail.omitted.toolCalls || detail.omitted.approvals) && <p className="saved-history-warning">응답 크기 제한으로 일부 하위 이벤트가 생략되었습니다.</p>}
          {loadingDetail && <p className="dialog-empty"><LoaderCircle className="spin" size={13} /> 다음 페이지를 불러오는 중…</p>}
          {!loadingDetail && detail.nextCursor && <button className="secondary-action history-more" onClick={() => void loadDetail(selected!, detail.nextCursor ?? undefined)}>상세 더 보기</button>}
        </div>}
      </section>
    </div>
  </div>;
}
