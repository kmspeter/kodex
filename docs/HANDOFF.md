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
  git diff --name-only f1d833d352d9d86bb99dc5af797693e08c1a66cf..HEAD -- apps packages scripts test infra docs/adr .env.example package.json package-lock.json CODEX_UPSTREAM_COMMIT VENDOR_SOURCE_SHA256.json bin/codex-build.json
  ```

- 이 handoff 자체의 docs-only commit은 아래 제품 기준 commit 다음에 위치한다. 현재 checkout은 항상
  `git status --short --branch`와 `git rev-parse HEAD`로 다시 확인한다.

## 현재 스냅샷

| 항목 | 검증된 값 |
| --- | --- |
| 스냅샷 날짜 | 2026-09-04 (Asia/Seoul) |
| 준비 branch | `main` |
| 제품 기준 HEAD | `f1d833d352d9d86bb99dc5af797693e08c1a66cf` |
| 제품 기준 commit | `fix: verify release as physical files` |
| 완료 범위 | Phase 1~25 |
| 다음 핵심 기능 | 계정 복구와 운영 관측성 |

Phase 1~25에서 제품 DB와 인증, 인증 UI, 사용자·workspace별 runtime 격리, 공개 App Server event 기반
history projection, private pgvector RAG, Electron 제품 runtime, Saved DB History UI, HNSW 기본 검색,
workspace 전환, browserless/Electron full-stack acceptance, membership, 명시적 동의 기반 repository RAG,
인증 수명주기, hash-only invitation, workspace 관리 pagination, bounded retention, PostgreSQL 공유 abuse
throttling, workspace rename과 one-way soft archive, 공개 App Server pagination 기반 기존 thread History
backfill/reconciliation, PostgreSQL과 tenant data의 검증된 offline backup/restore, sealed versioned release와
forward-only deployment/upgrade까지 구현했다. 상세 계약은
[ADR 0001](adr/0001-product-database-boundary.md)부터
[ADR 0024](adr/0024-versioned-release-and-upgrade.md)까지가 기준이다.

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
- History는 공개 notification/server-request stream과 read-only `thread/list`, `thread/turns/list`,
  `thread/items/list` snapshot만 정규화한다. upstream SQLite, rollout JSONL 또는 그 밖의 내부 저장소를
  제품 코드가 직접 읽거나 polling하지 않는다는 [ADR 0004](adr/0004-app-server-history-projection.md)의
  경계를 유지한다.
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

## Phase 23 계약과 최종 검증

Phase 23의 원본 결정은 [ADR 0022](adr/0022-app-server-history-backfill-reconciliation.md)다.

- 인증된 tenant runtime 초기화 뒤 같은 App Server에서 active/archived thread, turn, item을 공개 pagination으로
  읽어 기존 sanitizer → durable outbox → PostgreSQL projection 경로에 넣는다. SQLite/rollout/state DB를 직접
  읽지 않으며 UI RPC, tool 실행, approval 응답을 유발하지 않는다.
- 모든 공개 `ThreadSourceKind`를 명시하고 opaque cursor loop/malformed response를 fail-visible 처리한다. 기본
  pass는 active/archived 각각 500 thread, thread당 1,000 turn/5,000 item으로 제한된다.
- Live와 snapshot event ID는 `thread → turn → item → lifecycle` parent identity를 포함한다. Pending outbox도
  event ID를 재시작 시 복원해 DB outage 중 반복 scan이 spool을 무한히 늘리지 않는다.
- 성공 뒤 15분, partial/failure 뒤 5초~5분 backoff로 재실행한다. Active turn은 scan을 미루고, defer timer가
  실행 중 request보다 먼저 끝나도 follow-up scan을 잃지 않는다. Runtime stop은 scan 취소 뒤 App Server와
  outbox를 bounded하게 정리한다.
- Snapshot에는 과거 approval 증거가 없으므로 approval을 합성하지 않는다. Credential-like field와 absolute
  path는 redaction되고 log/status에는 payload, cursor, ID, response body를 넣지 않는다.

2026-09-04에 commit `d01c10e18beb8e446e617a60e02935d96586152b` 대상으로 전체 210 unit test, lint,
typecheck, build, UI bundle/server-secret 검사, vendored Codex 6,687-file integrity, production smoke가 통과했다.
격리 실제 PostgreSQL history 8개, real `codex.exe` pre-existing thread full-stack, Electron full-stack와
workspace lifecycle/invitation/repository RAG acceptance도 통과했다. `test:history-postgres`는 이제 고유한
`--rm` pgvector container를 만들고 `finally`에서 정리한다.

## Phase 24 계약과 최종 검증

Phase 24의 원본 결정은 [ADR 0023](adr/0023-offline-backup-restore.md), 운영 절차는
[offline backup/restore runbook](operations/backup-restore.md)이다.

- Backup은 모든 Local Server/Electron을 정지한 offline 상태에서 PostgreSQL custom-format dump와
  `KODEX_DATA_ROOT`를 함께 새 directory에 만든다. Runtime start-intent와 maintenance lock의 양방향 검사로
  backup 도중 새 tenant runtime이 시작되는 경쟁을 fail-closed 처리한다.
- Manifest v1은 application version/optional commit, ordered migration ledger, DB dump와 모든 tenant regular
  file의 relative path/size/SHA-256만 기록한다. DB URL, password, absolute path와 process secret은 기록하지
  않으며 symlink/special file/unlisted file/tamper를 거부한다.
- Restore는 manifest를 먼저 검증하고 빈 PostgreSQL DB와 존재하지 않는 새 data root에만 수행한다. 복사된
  대상 tenant file도 manifest와 다시 대조한다. 실패한 `pg_restore` target은 부분 상태일 수 있어 폐기하고
  새 빈 DB에서 재시작한다.
- Source CLI와 portable runtime의 `Kodex-Backup.cmd`가 같은 구현을 사용한다. `verify-full`은 system trust
  또는 bounded `PRODUCT_DB_CA_CERT`를 사용하며 DB password는 child argument에 넣지 않는다.

2026-09-04에 commit `d694c7a97eb7f2a9cf08d8b4cbad538b785f5fe8` 대상으로 전체 212 unit test, lint,
typecheck, build, UI bundle/server-secret 검사, vendored Codex 6,687-file integrity, API full-stack, Electron
full-stack, production smoke, rebuilt portable runtime smoke가 통과했다. `test:backup-restore`는 source/target
두 실제 PostgreSQL 17 pgvector container에서 Argon2 login, workspace, History, RAG와 pending outbox의
backup→restore를 검증하며 active/runtime-start lock, existing target, unlisted file과 checksum tamper를
거부한다. Packaged `Kodex-Backup.cmd`도 Electron Node 모드에서 실제 verification code까지 로드했다.

## Phase 25 계약과 최종 검증

Phase 25의 원본 결정은 [ADR 0024](adr/0024-versioned-release-and-upgrade.md), 운영 절차는
[deployment/upgrade runbook](operations/deployment-upgrade.md)이다.

- Clean Git HEAD에서만 Windows runtime을 `Kodex-<version>-windows-x64-<commit12>` directory로 봉인한다.
  Manifest v1은 exact version/commit, migration ledger, Codex upstream/vendor provenance와 2,000개 artifact
  regular file의 path/size/SHA-256을 가진다. Local config, tenant/outbox, symlink/special/unlisted/tampered file은
  거부한다.
- Artifact의 `Kodex-Release-Verify.cmd`는 Electron ASAR 가상 tree를 끄고 실제 physical file을 검증한다.
  Product API `/api/version`은 sealed/container identity의 `{ version, commit }`을 no-store로 반환한다.
- Product API는 migration-before-listen이며 미래 ledger나 changed checksum을 만나면 port를 열지 않는다.
  Rollback은 별도 verified artifact directory 단위이며, 이전 app이 새 ledger를 모르면 down migration/ledger
  수정 대신 candidate 재배포 또는 Phase 24 backup을 새 DB/data root에 복원한다.
- Docker image는 누락돼 있던 internal `@kodex/product-contract` build/runtime workspace를 명시적으로 포함하고,
  OCI version/revision label과 runtime import를 실제 image build에서 검증했다.

2026-09-04에 최종 제품 commit `f1d833d352d9d86bb99dc5af797693e08c1a66cf`까지 대상으로 전체 215 unit,
lint, typecheck, build, UI/vendor integrity, API/Electron full-stack, backup restore와 release deployment drill이
통과했다. 실제 Docker image build/import/OCI label을 확인한 뒤 test tag를 정리했다. Clean HEAD에서 생성한
`runtime/Kodex-0.2.0-windows-x64-f1d833d352d9`는 내부 verifier와 `Kodex.cmd --smoke`를 통과했다.

## Phase 26 계약과 최종 검증

Phase 26의 원본 결정은 [ADR 0025](adr/0025-password-reset-account-recovery.md), 운영 절차는
[account recovery runbook](operations/account-recovery.md)이다.

- Opt-in HTTPS webhook 전달 경계와 fragment-only URL을 사용한다. UI bootstrap은 React/API 시작 전에 reset
  token을 주소 표시줄에서 제거한다. Provider 실패도 account 존재 여부와 같은 `202 {"ok":true}`이며 고정
  aggregate diagnostic만 남긴다.
- DB에는 CSPRNG 256-bit token의 domain-separated SHA-256만 저장한다. Email/raw token/reset URL은 reset row,
  audit, log에 넣지 않는다. 새 요청은 user lock 아래 이전 pending request를 폐기한다.
- Request/complete는 PostgreSQL 공유 address+email/address+token HMAC limiter를 사용한다. Request는 기본
  750 ms floor로 빠른 unknown-account timing 차이를 줄인다.
- Complete는 Argon2id hash를 먼저 계산하고 user/reset row를 잠가 exactly-once 소비한다. Credential 교체,
  다른 reset 폐기와 모든 active session 폐기가 한 transaction이며 invalid/expired/revoked/reused는 같은 410이다.
- Migration 0011과 retention coordinator가 terminal reset을 기본 30일 뒤 bounded oldest-first `SKIP LOCKED`로
  정리한다. Delivery 실패 request는 즉시 failed/revoked되어 재사용되지 않는다.

2026-09-04에 commit `fc6cbf5d14faeba7cbd185843cc80daeb69f58f8` 대상으로 전체 227 unit test, lint, typecheck, build, UI/vendor integrity와
production smoke가 통과했다. 실제 PostgreSQL fresh 0001~0011/immutable 0001~0010 upgrade에서 generic 응답,
hash-only schema, 동시 단회 소비, superseded/expired/reused token, 세션 전부 폐기, 이전/새 비밀번호와 delivery
failure 보상을 확인했다. Retention, abuse, auth lifecycle, invitation, backup/restore, sealed release deployment,
API/Local full-stack와 기존 Electron full-stack도 통과했다. 새 `test:desktop-password-reset`은 실제 Electron DOM,
PostgreSQL과 loopback provider에서 register→logout→request→fragment→complete→session revoke→new login을 통과했다.

## 다음 작업 우선순위와 exit criterion

1. **P1 — 관측성과 데이터 수명주기를 운영 수준으로 확장한다.** Process/DB/outbox/backfill/reauthorization의
   payload-free health/metric/alert를 만들고 history/RAG/audit/local file/export/delete/legal-hold 정책을
   별도 결정한다. Exit: failure injection으로 actionable alert와 secret-free diagnostic을 확인하고,
   retention/export/delete가 backup/WAL/replica 한계까지 문서화·검증되어야 한다.
2. **P1 — 보안 및 release acceptance를 닫는다.** Threat model, dependency/vendor provenance, artifact signing,
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
npm run test:backup-restore
npm run test:release-deployment
```

`test:history-postgres`를 포함한 독립 harness는 실행 중인 Docker daemon과
`pgvector/pgvector:0.8.6-pg17` image를 요구하며
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
  `0011_*.sql`까지 수정·이름 변경·재정렬하지 않는다. Schema 변경은 다음 연속 번호의 새 migration과
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

- 현재 제품은 SSR/cloud task/Kodex 전용 cloud backend, installer/update service와 자동 배포 control plane을
  제공하지 않는다. Portable runtime은 외부 PostgreSQL 설치·기동·upgrade를 관리하지 않는다. Offline
  backup 도구는 application-level 암호화/서명, retention scheduler, WAL/PITR을 제공하지 않는다.
- Email verification, SMTP invitation delivery, self-service workspace restore, hard delete,
  secure erasure, 사용자 export, workspace별 content retention은 아직 없다.
- Retention은 일부 terminal auth/invitation/password-reset/abuse row의 bounded cleanup이다. PostgreSQL MVCC, autovacuum,
  WAL/replica/snapshot/backup과 로컬 tenant file의 삭제를 보장하지 않는다.
- History는 사용자 private projection이고 bounded backfill/reconciliation 때문에 지연되거나 configured
  limit 밖 record가 누락될 수 있다. Outbox가 가득 차거나 손상되면 새 event 수신이 fail-visible하게 멈춘다.
  운영 metric/alert와 repair 도구는 아직 제한적이다.
- Workspace archive는 one-way 접근 차단이지 데이터 삭제가 아니다. DB row와 로컬 파일이 누적되며 다른
  client의 기존 socket은 기본 bounded 재인가 주기까지 잠시 살아 있을 수 있다.
- RAG의 OpenAI embedding 경로는 generation provider가 local이어도 별도다. 명시적 consent와 조직의 외부
  전송 정책이 필요하며 이름 기반 secret 제외는 DLP가 아니다.
- Abuse limiter는 같은 PostgreSQL을 공유하는 application process 범위다. Edge WAF/CAPTCHA, trusted proxy,
  forwarded client identity, multi-database global limiting을 제공하지 않으며 NAT/proxy 사용자가 bucket을
  공유할 수 있다.
- Full-stack harness는 production 운영 수명, 외부 OpenAI/remote MCP/Web Search, 실제 email,
  installer/signing과 장시간 authorization cadence를 증명하지 않는다. 각 운영 기능에는 별도 acceptance와
  runbook이 필요하다.
