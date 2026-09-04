# ADR 0022: 공개 App Server snapshot 기반 History backfill과 reconciliation

- 상태: 승인
- 날짜: 2026-09-04

## 배경과 결정

기존 `RuntimeHistoryRecorder`는 tenant runtime 생성 뒤 공개 notification/server-request만 기록했다.
따라서 같은 tenant `CODEX_HOME`에 이미 존재하지만 새 event가 없는 thread는 PostgreSQL Saved DB
History에 나타나지 않았다. 공식 Codex runtime이 실행 상태의 원본이고 PostgreSQL은 회고용 projection이라는
ADR 0004와 ADR 0007의 경계는 유지한다.

인증된 `(userId, workspaceId)` runtime이 초기화된 뒤 tenant의 기존 `AppServerClient`에서 read-only 공개
method를 호출하는 background reconciler를 시작한다. SQLite, rollout JSONL, state DB 파일을 제품 코드가
직접 읽거나 polling하지 않으며, 브라우저 `handleRpc`의 active-project `cwd` 강제 경로도 재사용하지 않는다.
Snapshot은 기존 `HistoryEventNormalizer`의 sanitizer와 64 KiB 최종 한계를 거쳐 tenant durable outbox에
기록되고, 기존 PostgreSQL transaction과 `agent_events` ledger만 통해 aggregate에 반영된다. DB direct
bulk insert와 별도 history 저장소는 없다.

## Source와 pagination

한 reconciliation pass는 다음 순서로 동작한다.

1. `thread/list`를 `archived: false`, `archived: true`로 각각 호출하고 opaque `nextCursor`가 끝날 때까지
   page한다. `cwd`와 `useStateDbOnly`는 보내지 않는다.
2. 생성 protocol의 `ThreadSourceKind` 전체인 `cli`, `vscode`, `exec`, `appServer`, `subAgent`,
   `subAgentReview`, `subAgentCompact`, `subAgentThreadSpawn`, `subAgentOther`, `unknown`을 명시한다.
   이 고정 목록은 upstream pin을 바꿀 때 protocol diff와 함께 다시 검토한다.
3. 각 thread의 turn은 `thread/turns/list(sortDirection: desc, itemsView: notLoaded)`, item은
   `thread/items/list(sortDirection: desc)`로 page한다. Item의 공개 `turnId`를 page한 turn과 연결한다.

현재 pin은 turn/item pagination을 제공하므로 deprecated `thread/read(includeTurns: true)` fallback을 쓰지
않는다. Method가 unsupported이거나 response/page/cursor가 malformed이면 internal store fallback 없이 해당
pass 또는 thread를 실패 처리하고 처음부터 재시도한다. Cursor는 메모리 안에서 loop 검출에만 사용하며
checkpoint나 영구 truth로 저장하지 않는다.

## Snapshot과 수렴 identity

- Thread snapshot event는 `thread ID + archived state + official updatedAt + title + canonical project ID`의
  bounded semantic hash를 사용한다. 같은 snapshot의 반복 scan과 process restart는 같은 event ID가 된다.
- Turn은 live recorder와 같은 `thread:<threadId>:turn:<turnId>:started|completed`, item은 같은
  `thread:<threadId>:turn:<turnId>:item:<itemId>:started|completed` identity를 사용한다. 공개 item/call ID는
  서로 다른 thread에서 재사용될 수 있으므로 ledger identity에 parent aggregate를 반드시 포함한다. Terminal snapshot이 먼저 도착하거나 live started가
  나중에 도착해도 repository lifecycle rank가 completed/failed/interrupted를 되돌리지 않는다.
- Thread/turn/item/tool aggregate key도 live projection과 동일하다. Thread의 official `updatedAt`, turn의
  `startedAt`/`completedAt`, stable public ID sort key를 사용하며 scan 시각이나 page cursor를 identity와
  sort에 넣지 않는다.
- Pending outbox는 event ID를 재시작 시 다시 읽어 같은 semantic event를 중복 spool하지 않는다.
  PostgreSQL에 이미 전달된 반복 snapshot은 기존 ledger에서 멱등하게 종료된다.

Thread project는 canonical `projectId`가 있으면 이를 사용하고, 없으면 cwd hash와 bounded basename만 쓴다.
원본 absolute `cwd`/`path` field는 sanitizer가 `[ABSOLUTE_PATH_REDACTED]`로 바꾼다. Snapshot metadata에는
공개 source/history mode/runtime status와 parent/fork correlation만 두고 rollout path나 Git path는 넣지
않는다.

## Bounds, scheduling, failure와 stop

Reconciliation은 runtime `initialize()` 뒤 timer에서 시작하므로 Local bootstrap과 agent turn을 기다리게
하지 않는다. 한 tenant에서 reconciler는 하나이며 thread를 직렬 처리한다. 기본 한계는 page 50,
active/archived 각각 thread 500, thread당 turn 1,000, item 5,000, request 15초다. Page 사이에는 event loop에
양보한다. 한계를 만나면 더 읽지 않고 `partial/truncated` 상태와 payload 없는 limit/count log를 남긴다.

성공 뒤 기본 15분마다 처음부터 reconciliation한다. 실패/partial은 5초부터 최대 5분까지 exponential
backoff로 처음부터 재시도한다. 한 thread의 turn/item failure는 다른 thread와 archived scan을 계속하지만,
thread-list failure와 outbox overflow는 pass를 중단한다. DB unavailable은 기존 outbox가 담당하며 agent
실행을 막지 않는다. Pending event ID dedupe와 16 MiB/10,000 record outbox 상한 때문에 반복 scan이
무제한 spool을 만들지 않는다.

Runtime eviction/manager shutdown은 먼저 reconciler를 cancel하고 App Server를 멈춰 pending request를
깨운 뒤 recorder와 outbox를 bounded flush한다. Status는 running/stopped, 마지막 result/time/failure phase,
next run time과 aggregate count만 가진다. Log도 고정 kind/phase/limit, count, retry delay만 포함하며 ID,
cursor, cwd, response body, credential을 포함하지 않는다.

환경 변수는 `.env.example`의 `KODEX_HISTORY_RECONCILIATION_*` 계약을 따른다. 값은 시작 시 hard range를
검사하고 retry initial이 maximum보다 크면 listen 전에 실패한다.

## Approval과 UI 한계

공개 thread/turn/item snapshot에는 과거 JSON-RPC approval request/response correlation이 없다. 따라서
backfill은 approval row를 만들거나 pending prompt를 열고 응답하지 않는다. 과거 tool call은 공개 final
item에서 복원하지만 그 실행에 approval이 있었는지, 누가 어떤 결정을 했는지는 추정하지 않는다. Live
approval은 계속 server-request와 resolve event에서만 기록한다.

Saved DB History UI는 공식 sidebar와 분리된 private projection이고 backfill도 이를 바꾸지 않는다.
복원 가능한 범위는 thread metadata/archive 상태, turn lifecycle, 공개 user/assistant/item payload와
command/MCP/dynamic/file/collaboration tool final state다. Page/resource limit 또는 공개 snapshot 부재로 일부
과거 record가 빠질 수 있으며 approval history는 위 제한을 가진다.

## Acceptance 경계

고정 protocol fixture는 active/archived와 모든 source kind, opaque multi-page thread/turn/item, malformed 및
반복 cursor, per-thread partial failure, retry, hard limit과 cancellation을 검증한다. Snapshot normalizer는
thread/status, terminal turn, user/assistant와 다섯 public tool family, redaction/absolute path/serialized size,
approval 미생성을 검증한다.

실제 PostgreSQL suite는 snapshot과 live started/completed의 교차 순서, 반복 ingest, lifecycle 비회귀,
approval 0건, 사용자/workspace 격리와 outage replay를 검증한다. Full-stack acceptance는 tenant
`CODEX_HOME`에 실제 `codex.exe`로 non-ephemeral thread/turn/tool을 먼저 만든 뒤 Local runtime을 bootstrap하고,
새 turn 없이 Product Saved DB History list/detail에서 thread, completed turn, assistant item과 completed tool
result가 나타나는지 검증한다. 기존 live projection, workspace/session archive/revocation과 UI acceptance는
회귀 suite로 유지한다.
