# ADR 0004: 공개 App Server event 기반 사용자별 제품 history projection

- 상태: 승인
- 날짜: 2026-08-31

## 결정

제품 history의 source는 tenant `KodexRuntime`이 이미 수신하는 공식 Codex App Server의 공개
notification과 server-request stream으로 한정한다. `CODEX_HOME`의 SQLite, rollout 파일 또는
그 밖의 Codex 내부 저장소를 제품 서버가 직접 읽거나 polling하지 않는다. RAG, embedding,
retention과 삭제 정책은 이 결정 범위에 포함하지 않는다.

`RuntimeManager`는 인증된 `(userId, workspaceId)` entry를 만들 때 history recorder를 App
Server 시작 전에 설치한다. recorder는 WebSocket UI subscriber와 별개이며 tenant runtime당
정확히 하나다. runtime reuse에는 같은 recorder를 재사용하고 eviction/stop에는 App Server의
마지막 event까지 받은 뒤 unsubscribe, bounded flush, retry timer 정리를 수행한다.

## 데이터 흐름과 정규화

```text
Codex App Server public stream
  -> KodexRuntime RuntimeEvent
  -> tenant HistoryEventNormalizer (redaction + size bound)
  -> tenant data root/product-history-outbox/*.json
  -> PostgreSQL transaction
       projects -> agent_threads -> agent_turns -> agent_items
                              \-> tool_calls / approvals
                              \-> agent_events (dedupe ledger)
  -> authenticated Product API history read
```

delta 원문을 무제한 축적하지 않는다. `thread/started`, thread 상태/name, `turn/started`와
`turn/completed`, `item/started`와 `item/completed`, 공개 approval request/resolve를 핵심
lifecycle로 정규화한다. item completion이 제공하는 최종 payload를 lifecycle rank로 병합하고,
command/MCP/dynamic/collaboration/file-change item은 `tool_calls`에도 별도로 투영한다. approval은
request ID, type, pending/resolved 상태와 redacted request/response를 `approvals`에 저장한다.

project는 공개 thread의 canonical project ID 또는 cwd의 SHA-256 identity로 연결한다. 원본
절대 경로는 project metadata에 저장하지 않는다. 모든 새 project/thread/turn/item/event/tool/
approval row에는 인증된 workspace와 `created_by_user_id`를 기록하며 composite FK가 같은 사용자
계층을 강제한다. 동일 workspace의 owner/admin도 Product API에서 다른 사용자의 row를 읽을 수
없다.

## 일관성 및 재전송 모델

전달은 ordered at-least-once다. redacted projection command를 tenant outbox에 fsync/atomic rename한
후 비동기로 DB에 보낸다. 하나의 PostgreSQL transaction이 정규화 상태와 `agent_events` dedupe
ledger를 함께 반영한다. stable tenant `source_instance`와 semantic `source_event_id`가 spool
replay 및 duplicate DB insert를 멱등하게 만든다.

transaction은 `(workspace_id, source_instance, source_event_id)` advisory lock을 먼저 얻고
ledger에 이미 존재하는 event면 aggregate upsert 전에 반환한다. 마지막 ledger insert도 unique
claim을 유지하며 예상 밖 경합으로 claim하지 못하면 transaction 전체를 rollback한다. 따라서
오래된 semantic event를 더 최신 관측 시각으로 다시 전달해도 thread/turn/item 최신 상태가
회귀하지 않는다.

approval identity는 raw JSON-RPC id를 DB key나 event id에 노출하지 않는다. method, thread,
turn, item, source start timestamp, approval/elicitation id와 server/mode 등 공개 correlation field,
그리고 raw id의 SHA-256만 canonical hash에 넣는다. request와 resolve는 같은 bounded identity를
공유하므로 process restart 뒤 raw JSON-RPC id가 재사용되어도 서로 다른 item approval row를
덮어쓰지 않는다.

turn/item은 source timestamp와 Codex ID로 stable sort key를 만들고 process-local WebSocket
sequence를 제품 pagination 순서로 사용하지 않는다. lifecycle rank는 completed/failed 상태가
늦게 도착한 started event로 되돌아가지 않게 한다. thread source timestamp는 오래된 상태/name
event가 최신 row를 덮지 않게 한다. API thread cursor는 immutable `(created_at, database_id)`,
turn cursor는 `(source_sort_key, database_id)`를 opaque base64url로 전달한다.

## 장애, 경계와 비밀

PostgreSQL 장애는 App Server event 처리나 agent 실행을 기다리게 하지 않는다. outbox는 앞 record
성공 전 다음 record를 보내지 않고 exponential backoff로 재시도하며 재시작 시 파일명 순서로
replay한다. 기본 한계는 event 64 KiB, tenant outbox 16 MiB/10,000 records다. 초과 시 새 event를
받지 않고 `history_outbox_overflow` 상태를 credential 없는 security/history log에 명시한다.
무제한 증가나 조용한 drop은 허용하지 않는다. 손상 record는 삭제하지 않고 queue를 멈추며
`history_spool_invalid`를 남긴다.

normalizer는 depth, object/array entry, string과 최종 serialized size를 제한한다. authorization,
cookie, password, bearer, token, secret, credential, API/private key, encrypted field와 민감 header는
재귀적으로 `[REDACTED]` 처리한다. outbox, PostgreSQL payload와 상태 log에는 session bearer,
CSRF, password hash, `OPENAI_API_KEY`, `DATABASE_URL` 원문을 쓰지 않는다.

Product API의 두 read endpoint는 매 요청 session을 다시 인증한다. URL `workspace_id`와
`X-Kodex-Workspace-Id`가 모두 유효하고 동일해야 하며 현재 membership이 있어야 한다. SQL은
항상 `(workspace_id, current user id)`를 함께 필터하고 guessed cross-user thread는 `404`,
cross-workspace 또는 membership mismatch는 `403`, 폐기/만료 session은 `401`이다.

## 후속 작업

workspace 전체 공유 history 정책, 사용자별 export, 보존 기간, project/thread hard deletion,
계정 삭제 cascade와 outbox 운영 도구는 별도 결정이 필요하다. 현재 migration은 기존 row를
보존하면서 새 projection row에 사용자 경계를 강제한다. `documents`, `document_chunks`, vector,
retrieval table은 사용하지 않으며 RAG/embedding 구현도 후속 단계다.
