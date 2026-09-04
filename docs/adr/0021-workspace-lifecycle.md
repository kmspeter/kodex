# ADR 0021: Workspace 이름 변경과 one-way soft archive

- 상태: 승인
- 날짜: 2026-09-04

## 배경과 결정

Workspace 관리에는 표시 이름을 고칠 경로와 더 이상 사용하지 않는 workspace를 일반 접근에서 제거할
경로가 필요하다. 이 단계는 물리 삭제가 아니라 `workspaces.deleted_at`을 기록하는 **one-way soft
archive**를 채택한다. rename은 owner/admin, archive는 owner만 수행한다. membership과 초대 권한의 기존
결정은 [ADR 0012](0012-workspace-membership-management.md)와
[ADR 0016](0016-hash-only-workspace-invitations.md)을 계속 따른다.

Product API 계약은 다음과 같다. 두 요청 모두 authenticated session, exact Origin, HttpOnly session cookie와
CSRF cookie/header HMAC을 요구하며 `Content-Type: application/json`의 exact-key body만 허용한다.

- `PATCH /api/workspaces/:id`는 owner/admin에게 `{ "name": "..." }`를 받고 갱신된 browser-safe workspace
  DTO와 `200`을 반환한다.
- `DELETE /api/workspaces/:id`는 owner에게 `{ "confirmationName": "..." }`를 받고 성공 시 body 없는 `204`를
  반환한다. 이 메서드 이름은 HTTP 계약을 위한 것이며 실제 동작은 hard delete가 아니다.

Workspace 이름과 confirmation은 이미 NFC인 string이어야 하고 앞뒤 whitespace가 없어야 한다. 1~100
Unicode code point, UTF-8 400 bytes 이하이며 연속 whitespace, ASCII control/DEL과 surrogate code point를
거부한다. 서버가 입력을 조용히 trim하거나 normalize하지 않는다. Archive confirmation은 이 parser를 통과한
뒤 transaction에서 잠근 **현재** workspace 이름과 exact string equality로 비교한다. rename 뒤 이전 이름을
보내거나 대소문자·공백·정규화가 다르면 `409 archive_confirmation_mismatch`다. 그 밖의 주요 상태는 인증
없음 `401`, 권한 또는 없거나 이미 archive된 workspace `403`, 입력 실패 `422`다.

## Lock 순서와 경합 결과

Rename, archive와 workspace-scoped invitation mutation은 먼저 active workspace row를 `FOR UPDATE`로 잠그고
그 다음 actor membership row도 `FOR UPDATE`로 잠가 현재 역할을 다시 확인한다. 이 공통 순서는 이름, 권한,
archive 여부가 서로 다른 snapshot에서 결정되지 않게 한다. Invitation accept도 token으로 workspace를 찾은
뒤 같은 workspace lock을 먼저 얻고 invitation, active user와 대상 membership을 잠근다. 따라서 create,
revoke, accept와 archive가 한 workspace에서 직렬화된다.

Archive는 lock을 보유한 transaction에서 accepted되지 않고 아직 revoked되지 않은 pending invitation을 모두
revoked로 바꾼 뒤 workspace에 `deleted_at`을 기록한다. Accept와 archive가 경쟁하면 다음 둘 중 하나만
commit 순서가 된다.

- Accept가 먼저 workspace lock을 얻으면 membership과 `accepted_at`이 commit되고, 뒤의 archive는 그
  invitation을 revoke하지 않은 채 나머지 pending invitation을 revoke한다. Accept는 `200`, archive는 `204`다.
- Archive가 먼저 lock을 얻으면 pending invitation이 revoked되고 workspace가 비활성화된다. 뒤의 preview나
  accept는 workspace 또는 token 상태를 노출하지 않는 generic `410` terminal 응답을 받는다.

동일 invitation에는 `accepted_at`과 `revoked_at`이 동시에 설정되지 않는다. Rename과 archive 경합에서
archive가 먼저면 rename은 `403`이고 archive는 `204`다. Rename이 먼저면 rename은 `200`, 이전 이름을 담은
archive는 `409`이며 owner는 새 현재 이름으로 다시 확인해야 한다. Archive 이후 rename으로 workspace를
되살리는 경로는 없다.

## 접근 차단, 보존과 audit

인증 context는 `deleted_at IS NULL`인 workspace만 membership으로 구성하므로 archive된 workspace는
`GET /api/auth/me`의 `workspaces`와 `defaultWorkspace`에서 제외된다. Workspace member/invitation mutation과
read, Product History/Knowledge API, Local Server HTTP/새 WebSocket authorization도 매번 이 active context를
기준으로 거부한다. 이미 열린 Local Server WebSocket은 세션 만료 또는 운영 기본 최대 5분 주기의 DB 재검증에
실패하면 code `1008`로 닫힌다.

Archive transaction은 workspace row의 `deleted_at`/`updated_at`, pending invitation의 `revoked_at`과 lifecycle
audit만 변경한다. Workspace/member와 project, saved history, RAG source/document/chunk/query/citation, 기존
audit 및 그 밖의 product row는 삭제하지 않는다. 사용자/workspace ID로 분리된 로컬 tenant runtime 파일도
삭제하거나 이동하지 않는다. 보존은 향후 restore를 약속하는 것이 아니라, 현재 archive가 파괴적 cleanup을
수행하지 않는다는 안전 경계다.

Lifecycle audit은 `workspace.renamed`와 `workspace.archived`, workspace/actor/target ID, 고정된 bounded
`operation`만 기록한다. Raw 이전·새 workspace 이름과 confirmation을 details에 넣지 않는다. Invitation audit도
role 같은 bounded metadata만 허용하며 raw target email이나 bearer token/token hash를 details에 넣지 않는다.

## UI 일관성

UI는 owner/admin에게 rename을, owner에게만 별도 danger 영역의 archive를 표시한다. Archive button은 사용자가
화면의 현재 이름을 exact하게 입력하기 전에는 활성화되지 않는다. 성공한 archive는 `/me` 재요청을 기다리기
전에 해당 workspace ID를 사용자별 local tombstone set에 넣고 선택 목록과 active runtime에서 즉시 제거한다.
그래서 직전의 stale account 응답이나 상위 component의 stale props가 archive된 workspace를 다시 선택지에
삽입하지 못한다. 이어 받은 `/me`가 같은 user인지 확인한 뒤만 account context를 갱신하며, active runtime
client는 fallback workspace로 전환하면서 닫힌다. 이 즉시 전환은 현재 UI runtime에 대한 보장이며, 다른
renderer나 기기에서 이미 열린 연결은 위의 bounded 재인가 시점에 닫힌다.

Dialog의 rename/archive 요청은 workspace/user scope와 request identity를 기억한다. Workspace 전환, account
변경, dialog unmount 뒤 도착한 completion은 새 scope의 pending 상태를 풀거나 `/me` 결과를 적용하지 않는다.

## 비목표, 검증 경계와 남은 위험

다음은 이 결정의 비목표다.

- self-service 또는 운영자 restore
- hard delete, secure erasure와 storage overwrite
- project/history/RAG/audit/product row 또는 로컬 tenant 파일의 cascading cleanup
- workspace별 retention, backup/WAL/replica/snapshot 폐기와 사용자 export

Unit 경계는 exact request shape, CSRF/Origin, 상태/DTO parsing, 역할별 UI, exact confirmation, stale rename
completion과 stale account 응답 방어를 검증한다. PostgreSQL integration은 workspace/actor lock에 의한
rename/archive 및 accept/archive 경합, pending revoke, archive 뒤 `/me` 제외와 workspace endpoint `403`,
대표 project/history/RAG/audit/member row 보존, lifecycle audit의 이름/email/token 비포함을 실제 transaction으로
검증한다.

Browserless `npm run test:full-stack` acceptance는 실제 Product API `DELETE /api/workspaces/:id`, Local Server, PostgreSQL,
`codex.exe`와 loopback Responses를 함께 실행한다. Archive 전에 owner A와 invited member B가 같은 workspace에
열어 둔 Local WebSocket은 archive `204` 뒤 모두 code `1008`로 닫힌다. A/B의 `/api/auth/me` session은 계속
`200`이고 archived workspace만 목록에서 제외되며, archived workspace의 Product history와 A/B의 Local
bootstrap/새 WebSocket은 `403`이다. 동시에 A의 별도 fallback socket과 B의 personal socket은 `OPEN`을 유지해
unrelated workspace와 session이 archive에 함께 폐기되지 않음을 확인한다. 이어지는 A logout은 별도 경계로
fallback Product history와 Local bootstrap/새 WebSocket `401`, 기존 fallback socket `1008`을 계속 검증한다.
관련 공개 계약은 [README](../../README.md)에 요약한다.

별도 `npm run test:desktop-workspace-lifecycle` acceptance는 실제 build와 Electron desktop bootstrap을 사용한다.
Public DOM에서 fallback personal workspace를 남긴 채 archive target을 만들고, `수명주기 팀 Ω`로 rename한 다음
account button과 dialog가 Unicode 현재 이름을 표시하는지 확인한다. Archive 입력은 틀린 이름에서 button이
비활성이고 화면의 현재 이름과 exact match한 뒤에만 DOM이 실행한다. Renderer request observer는 해당 target에
`PATCH 200` 다음 `DELETE 204`가 발생했는지 확인한다. 성공 뒤 dialog와 archived 선택지가 사라지고 fallback
runtime은 `connected`, fallback Local bootstrap은 `200`이어야 한다.

같은 Product/Local session으로 `/api/auth/me`가 `200`과 fallback workspace를 유지하면서 archived target만
제외하는지, archived Product History와 Local bootstrap이 각각 `403`인지 직접 probe한다. Archive 전 target
bootstrap에서 받은 Local session proof와 Electron cookie jar로 archive 뒤 **새** target WebSocket을 열어
handshake HTTP `403`도 확인한다. PostgreSQL 교차 검증은 renderer가 만든 workspace row와 최종 Unicode 이름을
보존한 채 `deleted_at`이 설정되고, target/user membership 수와 전체/active session 수가 바뀌지 않았는지
검사한다. Audit는 동일 actor/target의 exact `workspace.renamed` → `workspace.archived` 순서와 각각 bounded
`{ operation: "rename" | "archive" }` details만 허용하며 raw email, 이전/새 이름을 포함하지 않아야 한다.
이 Electron DB fixture는 project/history/RAG row를 별도로 만들지 않으므로 그 대표 row 보존 증거는 위
PostgreSQL integration이 담당한다.

두 acceptance의 WebSocket 책임은 겹쳐 쓰지 않는다. Browserless full-stack만 archive 전에 이미 열려 있던
owner/member socket의 code `1008` 폐기와 unrelated socket 생존을 직접 기다린다. Electron lifecycle은 archive
후 새 handshake `403`과 fallback runtime을 직접 검증하며 기존 열린 socket의 `1008`을 기다리지 않는다.
두 하네스는 `KODEX_AUTH_REVALIDATE_MS=100`을 자신이 시작한 Local Server에만 주입한다. 이는 browserless의
기존 socket 폐기 속도 관찰 경계를 가속하는 test-only 설정이지 production 기본 5분이 실제로 경과했거나
장시간 revalidation cadence가 정확하다는 증거가 아니다. Electron의 새 handshake `403` 통과 조건도 이
주기적 재검증 대기에 의존하지 않는다.

Electron lifecycle harness는 고유 `pgvector/pgvector:0.8.6-pg17` `--rm` container, 임의 loopback port,
격리 Electron user-data와 tenant data root, 생성한 `example.invalid` 계정만 사용한다. OpenAI key와 local LLM
key를 비우고 RAG를 끄므로 제품 시나리오에 외부 서비스 network나 실계정은 필요하지 않다. 다만 image가
로컬에 없으면 최초 Docker registry pull은 실행 전제다. 성공, 실패, SIGINT와 SIGTERM에는 Electron과 자식
process tree, PostgreSQL container 및 임시 runtime data를 bounded cleanup한다. 실패 때만 renderer 전체 text를
투명화한 screenshot과 control value·자유 본문을 제외한 DOM 구조를 임시 경로로 옮겨 보존하고, redaction
style을 주입하지 못하면 screenshot을 만들지 않는다. Diagnostic은 credential, DB URL, workspace/account 입력과
Local session proof를 치환한다.

이 검증은 모든 product table의 장기 보존, 로컬 tenant 파일의 byte-level inventory, 이미 실행 중인 외부 작업의
즉시 중단, backup/WAL/replica에서의 제거 또는 미래 schema migration의 보존 성질을 증명하지 않는다. 다른
client의 열린 Local Server WebSocket은 설정된 주기적 재검증 전까지 살아 있을 수 있고, archive가 남기는
DB/로컬 저장공간은 retention과 운영 cleanup이 추가되기 전까지 계속 누적된다. Restore와 물리 삭제를 도입할
때에는 참조 무결성, export, 법적 보존, 안전한 파일 경로 검증과 실패 복구를 별도 ADR로 결정해야 한다.
Electron DOM automation은 visual pixel fidelity, IME composition 또는 긴 실제 시간의 authorization
revalidation 주기를 검증하지 않는다.
