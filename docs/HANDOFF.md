# Kodex project handoff

## 목적과 갱신 규칙

이 문서는 작업 사이에 현재 구현 기준, 검증된 경계, 바로 다음 작업과 안전 제약을 보존하는 영구
handoff다. 실행법과 공개 제품 계약은 [README](../README.md), 이미 결정된 이유와 세부 불변식은
[ADR](adr/)가 원본이다. 여기서는 다음 작업자가 저장소를 다시 역추적하지 않고 안전하게 이어가는 데
필요한 연결 정보만 유지한다.

- 제품 기능, migration, 신뢰 경계, 고정 Codex source/protocol 또는 표준 검증 범위가 바뀐 커밋마다
  이 문서의 스냅샷 날짜·기준 commit·완료 Phase·공백·우선순위·검증 결과를 함께 갱신한다.
- 특정 시점의 통과 결과에는 날짜와 검증 대상 commit을 함께 적는다. 현재 checkout에서 다시 실행하지
  않은 과거 결과를 최신 결과처럼 옮겨 쓰지 않는다.
- 아래 기준 commit 뒤 `apps/`, `packages/`, `scripts/`, `test/`, `infra/`, ADR, 환경 계약,
  `package*.json`, 고정 source나 protocol metadata에 변경이 있으면 이 문서를 stale 후보로 본다. 먼저
  다음 명령으로 범위를 확인한다.

  ```powershell
  git diff --name-only 3924217e19d1f200ccf54d50e02b97fef096c7df..HEAD -- apps packages scripts test infra docs/adr .env.example package.json package-lock.json CODEX_UPSTREAM_COMMIT VENDOR_SOURCE_SHA256.json bin/codex-build.json
  ```

- 이 handoff 자체의 docs-only commit은 아래 제품 기준 commit 다음에 위치한다. 현재 checkout은 항상
  `git status --short --branch`와 `git rev-parse HEAD`로 다시 확인한다.

## 현재 스냅샷

| 항목 | 검증된 값 |
| --- | --- |
| 스냅샷 날짜 | 2026-09-04 (Asia/Seoul) |
| 준비 branch | `main` |
| 제품 기준 HEAD | `3924217e19d1f200ccf54d50e02b97fef096c7df` |
| 제품 기준 commit | `feat: add workspace rename and soft archive` |
| 완료 범위 | Phase 1~22 |
| 다음 핵심 기능 | 기존 Codex thread의 PostgreSQL History initial backfill/reconciliation |

Phase 1~22에서 제품 DB와 인증, 인증 UI, 사용자·workspace별 runtime 격리, 공개 App Server event 기반
history projection, private pgvector RAG, Electron 제품 runtime, Saved DB History UI, HNSW 기본 검색,
workspace 전환, browserless/Electron full-stack acceptance, membership, 명시적 동의 기반 repository RAG,
인증 수명주기, hash-only invitation, workspace 관리 pagination, bounded retention, PostgreSQL 공유 abuse
throttling, workspace rename과 one-way soft archive까지 구현했다. 상세 계약은
[ADR 0001](adr/0001-product-database-boundary.md)부터
[ADR 0021](adr/0021-workspace-lifecycle.md)까지가 기준이다.

## 아키텍처와 주요 신뢰 경계

```text
Electron / React renderer
  |-- same-origin localhost HTTP/WS --> Local Server --> tenant Codex App Server (stdio JSONL)
  |                                      |                `-- tenant CODEX_HOME
  |                                      `-- durable redacted history outbox
  `-- separate product HTTP ----------> Product API ----> PostgreSQL + pgvector
```

- `apps/ui`는 browser-safe 계약만 소비한다. Product session은 HttpOnly cookie이며 CSRF, credential,
  provider key와 DB 연결 정보가 renderer payload, Web Storage, bundle 또는 log에 들어가면 안 된다.
- `apps/api`는 별도 process/port에서 인증, workspace, Saved DB History, Knowledge API를 제공한다.
  Local Server bootstrap secret이나 Codex runtime을 공유하지 않는다.
- `apps/local-server`는 매 요청에서 Product session과 active workspace membership을 다시 확인한다.
  runtime과 writable data root는 인증된 `(userId, workspaceId)`마다 분리하며 UUID/path escape를 다시
  검증한다. 같은 workspace의 다른 사용자도 `CODEX_HOME`, outbox와 raw runtime을 공유하지 않는다.
- 공식 Codex App Server가 실행/resume/archive의 원본이다. PostgreSQL `agent_*`, `tool_calls`,
  `approvals`는 회고용 Saved DB History projection이며 공식 runtime 목록과 병합하지 않는다.
- History는 공개 notification/server-request stream만 정규화한다. upstream SQLite, rollout JSONL 또는
  그 밖의 내부 저장소를 제품 코드가 직접 읽거나 polling하지 않는다는
  [ADR 0004](adr/0004-app-server-history-projection.md)의 경계를 유지한다.
- PostgreSQL History와 RAG는 항상 `(workspace_id, created_by_user_id)` private scope다. Workspace
  owner/admin도 다른 사용자의 row를 읽을 수 없다. Archived workspace는 새 Product/Local 접근에서
  제외되지만 관련 DB row와 tenant 파일은 현재 보존된다.
- Local Server는 생성 모델이나 tool을 자체 선택하지 않는다. RAG만 명시적 opt-in일 때 허용된 text를
  외부 embedding provider에 보낼 수 있으며, repository 인덱싱은 preview → 선택 → 동의 → confirm을
  거쳐야 한다.

주요 디렉터리 책임은 [README의 구조](../README.md#구조)를 따른다. 고정 upstream source는
`vendor/openai-codex/`, 생성 protocol은 `packages/codex-protocol/`, 제품 DB schema와 repository는
`packages/product-db/`, runtime 및 history 전달은 `apps/local-server/`가 소유한다.

## Phase 22 계약과 최종 검증

Phase 22의 원본 결정은 [ADR 0021](adr/0021-workspace-lifecycle.md)이다.

- `PATCH /api/workspaces/:id` rename은 owner/admin, `DELETE /api/workspaces/:id` soft archive는 owner만
  가능하다. 두 요청 모두 authenticated session, exact Origin, CSRF와 exact-key JSON body를 요구한다.
- 이름은 trim/normalize하지 않는 strict NFC 계약이다. Archive는 transaction에서 잠근 현재 이름과
  `confirmationName`의 exact equality를 요구한다.
- Rename/archive/invitation mutation은 active workspace row 다음 actor membership row의 공통 lock
  순서를 사용한다. Archive는 pending invitation을 취소한 뒤 `deleted_at`을 기록하며 hard delete나
  restore를 수행하지 않는다.
- Archived workspace는 `/me`, 새 History/Knowledge/Local bootstrap/WS 접근에서 제외된다. 기존 Local
  WebSocket은 bounded 주기 재인가 실패 시 `1008`로 닫히고 unrelated workspace/session은 유지된다.
- UI는 archive tombstone으로 stale account 응답이 대상을 되살리지 못하게 하며 fallback workspace로
  전환한다. Audit에는 bounded operation과 ID만 기록하고 이름, email, token을 넣지 않는다.

2026-09-04에 제품 기준 commit `3924217e19d1f200ccf54d50e02b97fef096c7df` 대상으로 다음 최종
검증이 통과한 상태로 handoff되었다.

- 전체 unit test, lint, typecheck, build, vendored source integrity
- 실제 PostgreSQL suites와 fresh/upgrade migration 경로; invitation은 `0001~0006`, `0001~0007`,
  `0001~0008` ledger에서 최신 migration까지의 경로 포함
- browserless `test:full-stack`
- Electron acceptance 4종: desktop full-stack, workspace lifecycle, workspace invitation,
  consent-based repository RAG
- production smoke

이는 해당 날짜와 commit의 증거다. Live OpenAI generation, 장시간 운영 재인가 cadence, visual pixel
fidelity, 배포/복원은 이 결과가 증명하지 않는다.

## 현재 핵심 공백: initial backfill/reconciliation

현재 History는 **runtime-event-only projection**이다. `RuntimeHistoryRecorder`가 tenant runtime 생성 시점
이후 받은 공개 event만 outbox에 넣으므로, 그 전에 `CODEX_HOME`에 존재하던 공식 Codex thread는 새
lifecycle event가 발생하지 않으면 PostgreSQL Saved DB History에 나타나지 않는다. DB 장애 뒤 outbox
replay는 이미 정규화된 event를 복구하지만, recorder가 한 번도 관측하지 않은 과거 thread를 만들지는
못한다. 이 때문에 공식 sidebar와 Saved DB History 사이의 초기 누락을 메우는 backfill과 이후 bounded
reconciliation이 없다.

Backfill은 공식 runtime 원본을 PostgreSQL 원본으로 바꾸는 기능이 아니다. 읽기 전용 공개 App Server
method로 tenant의 기존 thread를 열거하고, 현재 projection 형식으로 안전하게 재생성하는 보조 경로여야
한다. UI의 official thread list와 Saved DB History를 계속 분리한다.

### 구현을 시작할 파일

| 파일 | 현재 책임 / backfill 시 확인할 지점 |
| --- | --- |
| [`apps/local-server/src/runtime-manager.ts`](../apps/local-server/src/runtime-manager.ts) | 인증된 tenant runtime 생성·재사용·종료와 recorder 설치 순서. Backfill의 시작, 취소, runtime eviction 상호작용을 여기서 결정한다. |
| [`apps/local-server/src/runtime.ts`](../apps/local-server/src/runtime.ts) | UI RPC project/cwd 강제, 공개 runtime event와 approval ownership. Browser RPC와 내부 read-only reconciliation 경로를 혼동하지 않는다. |
| [`apps/local-server/src/process/app-server-client.ts`](../apps/local-server/src/process/app-server-client.ts) | 초기화된 tenant App Server에 typed request를 보내는 경계. 별도 process나 raw store reader를 만들기 전에 이 경로를 사용한다. |
| [`apps/local-server/src/history/recorder.ts`](../apps/local-server/src/history/recorder.ts) | live event normalizer와 tenant outbox 연결. Backfill과 live recorder가 한 tenant에서 중복 실행돼도 멱등이어야 한다. |
| [`apps/local-server/src/history/normalizer.ts`](../apps/local-server/src/history/normalizer.ts) | 공개 event → bounded/redacted `HistoryIngestEvent`. Snapshot용 변환을 추가하더라도 sanitizer, lifecycle rank, source timestamp 규칙을 공유한다. |
| [`apps/local-server/src/history/durable-outbox.ts`](../apps/local-server/src/history/durable-outbox.ts) | atomic rename/fsync, ordered at-least-once, bounded queue와 retry. Backfill도 DB에 직접 우회 insert하지 않는다. |
| [`apps/local-server/src/history/sanitize.ts`](../apps/local-server/src/history/sanitize.ts) | 민감 키 redaction과 depth/entry/string/serialized-size 상한. 과거 item payload에도 동일하게 적용한다. |
| [`packages/product-db/src/history-types.ts`](../packages/product-db/src/history-types.ts) | ingest/scope/read 계약. Backfill provenance나 checkpoint가 필요하면 명시적인 계약으로 추가한다. |
| [`packages/product-db/src/history-repository.ts`](../packages/product-db/src/history-repository.ts) | advisory lock, `agent_events` dedupe ledger, aggregate upsert, lifecycle/source-time 회귀 방지, private read scope. |
| [`packages/product-db/migrations/0003_agent_history_projection.sql`](../packages/product-db/migrations/0003_agent_history_projection.sql) | 현재 user-scoped history 제약과 index. 이 파일은 immutable이며 필요한 schema는 새 migration으로만 추가한다. |
| [`apps/api/src/server.ts`](../apps/api/src/server.ts) | Saved DB History read authorization와 public DTO filtering. Backfill 운영 상태를 공개할 필요가 생겨도 credential/source payload를 노출하지 않는다. |
| [`test/unit/history-projection.test.ts`](../test/unit/history-projection.test.ts) | sanitizer, semantic identity, outbox replay/overflow, recorder lifecycle의 unit 기준. |
| [`test/integration/history-postgres.test.ts`](../test/integration/history-postgres.test.ts) | 실제 PostgreSQL 멱등, out-of-order, outage replay, tenant isolation과 cursor 기준. |
| [`test/acceptance/full-stack.test.ts`](../test/acceptance/full-stack.test.ts) | real `codex.exe` → outbox → PostgreSQL → Product History와 workspace/session 격리 acceptance. |

### 사용할 공개 protocol method

- `thread/list`: opaque `cursor`/`nextCursor`로 tenant thread를 page한다. `useStateDbOnly`는 rollout
  scan-and-repair 의미를 바꾸므로 성능 편의로 임의 활성화하지 않는다. UI 경로는 active project `cwd`를
  강제하지만 initial tenant backfill의 project 범위는 별도로 결정하고 테스트해야 한다.
- `thread/read`: metadata-only read가 가능하다. `includeTurns: true` full hydration은 현재 생성 protocol에서
  deprecated이므로 새 구현의 기본 pagination으로 삼지 않는다.
- `thread/turns/list`: opaque cursor로 turn을 page한다. 필요한 item detail 수준과 정렬 방향을 명시하고,
  같은 turn이 live event와 겹칠 때 source timestamp/lifecycle rank를 보존한다.
- `thread/items/list`: thread 전체 또는 turn별 item을 page한다. Tool snapshot은 공개 item의 최종 필드에서
  유도하되 output delta를 다시 합성하거나 원본 크기로 저장하지 않는다.

생성 type의 기준은
[`ThreadListParams`](../packages/codex-protocol/src/generated/v2/ThreadListParams.ts),
[`ThreadReadParams`](../packages/codex-protocol/src/generated/v2/ThreadReadParams.ts),
[`ThreadTurnsListParams`](../packages/codex-protocol/src/generated/v2/ThreadTurnsListParams.ts),
[`ThreadItemsListParams`](../packages/codex-protocol/src/generated/v2/ThreadItemsListParams.ts)다. Generated 파일을
직접 고치지 않는다. 현재 고정 source가 제공하는 공개 method만 사용하며 SQLite/rollout parsing fallback을
추가하지 않는다.

### 반드시 유지할 설계 제한

- **Tenant:** backfill scope는 브라우저가 보낸 user/workspace ID가 아니라 현재 인증과 active membership이
  만든 runtime lease에서만 얻는다. 해당 tenant `CODEX_HOME` 밖을 scan하거나 다른 user/workspace row를
  연결하지 않는다. Archived workspace를 background 작업이 다시 활성화해서도 안 된다.
- **멱등성:** event identity는 page cursor, 관측 순서, 실행 시각이 아니라 thread/turn/item ID와 semantic
  lifecycle/provenance에서 안정적으로 만든다. 재시작·처음부터 재열거·live event 경합이 동일 결과를 내야
  한다. 기존 `(workspace_id, source_instance, source_event_id)` ledger와 lifecycle rank/source timestamp
  회귀 방지를 우회하지 않는다.
- **Outbox:** redaction과 최종 byte bound를 적용한 뒤 tenant outbox에 기록한다. PostgreSQL outage가 agent
  실행을 막지 않아야 하고, 16 MiB/10,000 record 기본 상한, overflow/invalid spool의 fail-visible 동작을
  유지한다. 대량 backfill은 queue 용량과 DB 부하를 고려해 bounded page/batch와 양보·취소가 필요하다.
- **Reconciliation 상태:** opaque protocol cursor를 영구 truth로 간주하지 않는다. 실패 시 안전하게 처음부터
  재열거해도 dedupe되는 설계를 우선하고, durable checkpoint가 필요하면 새 schema/migration, version,
  invalid-cursor 복구와 tenant key를 명시한다.
- **Approval:** live approval은 server-request와 resolve event의 공개 correlation으로만 기록된다. 과거 thread
  snapshot에 같은 증거가 없다면 approval을 추정하거나 `approved`로 만들어서는 안 된다. Missing approval은
  명시적 한계로 남기고, backfill이 approval prompt를 다시 열거나 응답, tool 실행, `turn/start`/resume을
  유발하지 않게 한다.
- **비밀과 payload:** full path, session/cookie/CSRF, authorization header, DB URL, provider key, raw request ID,
  credential-like field를 checkpoint, outbox, DB, metric, log에 넣지 않는다. Project 표시에는 현재와 같이
  canonical project ID 또는 cwd hash와 bounded basename만 사용한다.
- **권한과 가용성:** backfill은 read-only background 보조 작업이다. 로그인/Local bootstrap/agent turn을
  기다리게 하지 않고, membership/session 폐기와 runtime stop 시 bounded하게 중단한다.

## 다음 작업 우선순위와 exit criterion

1. **P0 — Backfill/reconciliation ADR과 protocol fixture를 확정한다.** Source 범위, 시작 시점과 반복 정책,
   pagination, provenance/event ID, live-event 경합, approval 누락, checkpoint/재시작, resource limit와 관측
   상태를 결정한다. Exit: 새 ADR이 승인되고 고정 protocol fixture로 빈 history, 여러 page, cursor 실패,
   malformed/oversized payload, runtime stop의 기대 결과가 테스트로 고정되어야 한다.
2. **P0 — Tenant-scoped initial backfill을 구현한다.** 초기화된 tenant App Server를 공개 read method로만
   page하고 기존 sanitizer → outbox → repository 경로에 넣는다. Exit: 기존 thread/turn/item/tool이 Saved DB
   History에 나타나고, 두 번 실행·중간 crash·DB outage·live event 교차 실행 후 row와 상태가 중복/회귀하지
   않으며 cross-user/workspace와 archived scope가 거부되어야 한다. Approval은 증거가 없을 때 생성되지
   않아야 한다.
3. **P0 — Bounded reconciliation과 acceptance를 완성한다.** startup을 막지 않는 scheduling, backoff,
   cancellation, progress/error의 redacted observability를 추가한다. Exit: unit + 실제 PostgreSQL + real
   `codex.exe` full-stack에서 사전 존재 thread import, 재시작 resume, outbox capacity, Product History UI 표시와
   session/membership 폐기를 검증하고 전체 표준 suite가 통과해야 한다.
4. **P1 — 배포와 upgrade runbook을 만든다.** Versioned Windows artifact, Product API/PostgreSQL 배치,
   migration-before-listen, health/readiness, secret 주입, 실패/rollback 책임을 정한다. Exit: production-like
   clean host에서 설치 → migrate → smoke → version 확인을 재현하고 실패 시 이전 artifact로 서비스 복구가
   문서화·연습되어야 한다.
5. **P1 — 백업/복원과 재해 복구를 검증한다.** PostgreSQL과 tenant data/outbox의 일관된 범위, 암호화,
   접근권한, RPO/RTO, WAL/snapshot retention을 정한다. Exit: 격리 환경 restore drill에서 인증, workspace,
   History/RAG와 pending outbox를 검증하고 측정한 RPO/RTO와 키 관리 절차를 기록해야 한다.
6. **P1 — 계정 복구를 설계한다.** Email verification/password reset 전달 경계, hash-only one-time token,
   expiry/revoke/rate limit/session 폐기와 generic error를 정한다. Exit: token 원문 비저장, enumeration 방지,
   경합·재사용·만료·세션 폐기와 실제 전달 실패 경로가 PostgreSQL/acceptance에서 검증되어야 한다.
7. **P1 — 관측성과 데이터 수명주기를 운영 수준으로 확장한다.** Process/DB/outbox/backfill/reauthorization의
   payload-free health/metric/alert를 만들고 history/RAG/audit/local file/export/delete/legal-hold 정책을
   별도 결정한다. Exit: failure injection으로 actionable alert와 secret-free diagnostic을 확인하고,
   retention/export/delete가 backup/WAL/replica 한계까지 문서화·검증되어야 한다.
8. **P1 — 보안 및 release acceptance를 닫는다.** Threat model, dependency/vendor provenance, artifact signing,
   least privilege, installer/update, recovery와 release checklist를 합친다. Exit: release candidate가 고정
   acceptance matrix, secret scan, vendor integrity, migration/restore drill과 서명 검증을 모두 통과해야 한다.

## 표준 실행과 검증

Node.js 22.13 이상과 설치된 의존성을 전제로 한다. 실제 secret이나 `.env.local` 값은 문서/commit/명령
출력에 남기지 않는다. 전체 설명과 각 harness의 비검증 범위는 [README의 검증](../README.md#검증)이 기준이다.

```powershell
npm install
npm run dev

npm run codex:verify-source
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:ui-bundle
npm run smoke:production
```

History/backfill 변경의 최소 직접 검증은 다음이다.

```powershell
npm test -- test/unit/history-projection.test.ts
npm run test:history-postgres
npm run test:tenant-auth
npm run test:full-stack
```

실제 PostgreSQL 검증 중 `test:history-postgres`와 일부 opt-in suite는 안전한 test DB의 `DATABASE_URL`을
명시해야 한다. 독립 harness는 실행 중인 Docker daemon과 `pgvector/pgvector:0.8.6-pg17` image를 요구하며
자신의 `--rm` container를 정리한다. Docker daemon 자체를 시작하거나 종료하지 않는다.

Phase 22 회귀와 Electron acceptance 4종은 다음으로 재검증한다.

```powershell
npm run test:workspace-postgres
npm run test:workspace-invitations-postgres
npm run test:auth-lifecycle-postgres
npm run test:retention-postgres
npm run test:abuse-rate-limit-postgres
npm run test:rag-postgres
npm run test:desktop-full-stack
npm run test:desktop-workspace-lifecycle
npm run test:desktop-workspace-invitation
npm run test:desktop-repository-rag
```

문서-only 변경은 최소한 링크 대상, 명령 이름, diff와 whitespace를 확인한다.

```powershell
git diff -- README.md docs/HANDOFF.md
git diff --check
git status --short
```

## 안전 규칙

- 적용된 migration은 checksum ledger 계약이다. `packages/product-db/migrations/0001_*.sql`부터
  `0010_*.sql`까지 수정·이름 변경·재정렬하지 않는다. Schema 변경은 다음 연속 번호의 새 migration과
  fresh DB 및 실제 upgrade ledger 검증으로 추가한다.
- `vendor/openai-codex/`, `VENDOR_SOURCE_SHA256.json`, `CODEX_UPSTREAM_COMMIT`, `bin/codex-build.json`,
  `packages/codex-protocol/src/generated/`와 `schema/`를 일반 기능 작업에서 손대지 않는다. Upstream pin을
  의도적으로 바꿀 때만 source 차이를 review하고 manifest, binary와 generated protocol을 함께 갱신한다.
  Generated protocol은 손으로 편집하지 않는다.
- `.env.local`, 실제 credential, cookie/CSRF/session proof, token, DB URL, 사용자 문서/경로를 commit하거나
  diagnostic에 복사하지 않는다. `.env.example`에는 placeholder와 변수 계약만 둔다.
- Tenant root와 `product-history-outbox/`를 임의 삭제·이동·공유하지 않는다. Backfill 장애 해결을 이유로
  spool을 버리지 말고 invalid/overflow 상태와 원인을 먼저 보존한다.
- 승인 정책을 우회하거나 backfill에서 approval에 자동 응답하지 않는다. Test의
  `danger-full-access`/`never`는 격리 fixture의 고정 command에만 허용되며 운영 기본이 아니다.
- `git reset --hard`, `git clean -fdx`, force push, 기존 변경 덮어쓰기, 운영 DB의 `DROP`/`TRUNCATE`, broad
  filesystem delete, 무검증 volume 삭제를 하지 않는다. 파괴 작업이 필요하면 정확한 대상, backup/복구와
  승인을 먼저 확인하고 격리된 disposable 환경을 우선한다.
- 작업 전후 `git status --short --branch`를 확인하고 관련 파일만 stage한다. Vendor, generated artifact,
  runtime data, `.env.local` 또는 사용자의 unrelated 변경을 docs/feature commit에 섞지 않는다.

## 알려진 비목표와 운영 위험

- 현재 제품은 SSR/cloud task/Kodex 전용 cloud backend, installer/update service와 완성된 배포 시스템을
  제공하지 않는다. Portable runtime은 외부 PostgreSQL 설치·기동·upgrade·backup을 관리하지 않는다.
- Password reset/email verification, SMTP invitation delivery, self-service workspace restore, hard delete,
  secure erasure, 사용자 export, workspace별 content retention은 아직 없다.
- Retention은 일부 terminal auth/invitation/abuse row의 bounded cleanup이다. PostgreSQL MVCC, autovacuum,
  WAL/replica/snapshot/backup과 로컬 tenant file의 삭제를 보장하지 않는다.
- History는 사용자 private projection이고 지연될 수 있다. 현재 backfill 부재 외에도 outbox가 가득 차거나
  손상되면 새 event 수신이 fail-visible하게 멈춘다. 운영 metric/alert와 repair 도구는 아직 제한적이다.
- Workspace archive는 one-way 접근 차단이지 데이터 삭제가 아니다. DB row와 로컬 파일이 누적되며 다른
  client의 기존 socket은 기본 bounded 재인가 주기까지 잠시 살아 있을 수 있다.
- RAG의 OpenAI embedding 경로는 generation provider가 local이어도 별도다. 명시적 consent와 조직의 외부
  전송 정책이 필요하며 이름 기반 secret 제외는 DLP가 아니다.
- Abuse limiter는 같은 PostgreSQL을 공유하는 application process 범위다. Edge WAF/CAPTCHA, trusted proxy,
  forwarded client identity, multi-database global limiting을 제공하지 않으며 NAT/proxy 사용자가 bucket을
  공유할 수 있다.
- Full-stack harness는 production 운영 수명, 외부 OpenAI/remote MCP/Web Search, 실제 email, backup restore,
  installer/signing과 장시간 authorization cadence를 증명하지 않는다. 각 운영 기능에는 별도 acceptance와
  runbook이 필요하다.
