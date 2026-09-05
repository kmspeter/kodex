# ADR 0027: 운영 수준 데이터 수명주기와 legal hold

- 상태: 승인
- 날짜: 2026-09-05

## 데이터 분류와 보존 결정

Kodex의 온라인 사용자 데이터는 PostgreSQL의 계정·membership·History·RAG·audit와 각 Local Server 설치의
`tenants/users/<user UUID>/workspaces/<workspace UUID>`에 나뉜다. 인증 credential과 token hash는 export 대상이
아니며, embedding vector도 원문 재현에 필요하지 않으므로 export하지 않는다. History payload와 RAG 원문처럼
사용자가 만든 content는 삭제 요청 전까지 보존한다. 자동 age-based content 삭제는 이 Phase에서 추정하지 않는다.

사용자 export는 비밀번호를 다시 확인한 뒤 durable `user_export` job으로 만든다. Product worker는 category별
row bound와 전체 16 MiB bound 안에서 JSON을 생성한다. Password/session/reset/invitation material, abuse bucket,
provider credential, raw embedding과 query embedding은 포함하지 않는다. Artifact는 기본 7일 뒤 만료하며 만료된
내용은 worker가 지운다. Export는 현재 사용자의 private History/RAG와 자신이 actor인 bounded audit만 포함하고,
shared workspace의 다른 사용자 private data나 member directory를 포함하지 않는다.

## 삭제 상태 전이

계정 삭제는 현재 비밀번호와 exact `DELETE MY ACCOUNT`, Workspace 영구 삭제는 owner의 현재 비밀번호와 현재
Workspace 이름 및 exact `DELETE WORKSPACE`를 요구한다. 요청 transaction은 중복 open job을 하나로 합치고 다음
상태를 즉시 적용한다.

- 계정은 `pending_deletion`으로 바꾸고 모든 session과 pending reset을 폐기한다.
- Workspace는 `deleted_at`과 `purge_requested_at`을 기록하고 pending invitation을 폐기한다.
- 다른 사용자가 남은 Workspace를 소유한 계정은 먼저 소유권을 이전하거나 Workspace를 별도 처리해야 한다.
  계정 삭제가 다른 사용자의 Workspace access와 data를 암묵적으로 삭제하지 않는다.
- 계정이 혼자 소유한 Workspace는 같은 account job의 삭제 범위로 archive하고, shared workspace에서는 삭제
  사용자의 membership과 private project/History/RAG/audit만 제거한다.

Job은 `pending → running → waiting_local/blocked_legal_hold → completed`로 진행한다. Product와 Local worker는
`FOR UPDATE SKIP LOCKED`, expiring lease, bounded retry를 사용하므로 여러 process와 worker 재시작에도 이어진다.
오류에는 fixed code/class만 기록하고 UUID, 경로, payload, cursor, credential 또는 provider/DB 오류문을 log하지
않는다. 중단 중 partial filesystem 또는 DB cleanup은 같은 target을 재실행해 수렴하는 idempotent 연산이다.

## Local filesystem과 설치 재조정

DB에는 absolute path를 저장하지 않는다. Local Server는 자체 random installation UUID와 strict UUID directory
scan으로 발견한 `(user_id, workspace_id)`만 등록한다. 삭제 job은 알려진 모든 설치 target이 완료될 때까지
application row를 삭제하지 않는다. Local worker는 해당 installation의 target만 claim하고 RuntimeManager의
직렬화 경계에서 active lease가 0인지 확인하고 runtime을 종료한 뒤 `instance.lock`이 없는 exact tenant root만
삭제한다. Parent는 empty-directory 제거만 허용하며 다른 user/workspace root를 recursive 삭제하지 않는다.

오프라인이었던 설치는 재시작 시 완료된 job tombstone까지 다시 대조해 늦게 발견한 tenant root를 삭제한다.
다만 영구적으로 다시 연결되지 않는 장치, 별도 수동 복사본, backup, PostgreSQL WAL/replica/snapshot까지 온라인
요청이 물리적으로 지울 수는 없다. 이 한계는 UI, API 응답과 운영 runbook에 표시한다.

## Legal hold와 신뢰 경계

Legal hold는 browser/session API가 아니라 Origin이 없는 server-only operations bearer API로만 생성·해제한다.
User hold는 그 사용자의 private data를 포함하는 account/Workspace 삭제를, Workspace hold는 해당 Workspace 삭제를
막는다. Product finalization과 Local filesystem cleanup은 같은 scope의 Workspace 행과 관련 User 행을 정렬된 순서로
잠근 뒤 hold를 재검사한다. Hold 생성도 target 행을 잠그므로 새 hold와 물리 삭제 사이에 선형화 순서가 생긴다.
Local cleanup은 이 DB transaction 안에서 실행되고 완료 acknowledgement도 함께 commit된다.
이미 물리 삭제된 data를 hold가 복구하지는 못하므로 운영자는 삭제 요청보다 먼저 hold를 설정해야 한다.

Workspace member/admin은 다른 사용자의 export, lifecycle job 또는 local target을 읽거나 조작할 수 없다. Official
Codex App Server의 SQLite/rollout/state DB를 읽지 않으며, 승인 정책을 바꾸지 않는다. Product DB worker와 Local
filesystem worker만 각각 자신의 저장 경계를 삭제하고 durable acknowledgement로 연결한다.

## 삭제 내용과 한계

Workspace finalization은 FK cascade로 project, History, tool/approval, RAG, membership, invitation과 workspace audit를
삭제한다. Account finalization은 shared workspace의 해당 사용자 private History/RAG/project와 actor audit,
membership, target-email invitation을 먼저 삭제한 뒤 credential/session/reset과 user row를 삭제한다. Lifecycle
job/tombstone에는 재조정에 필요한 UUID와 aggregate state만 제한적으로 남고 content는 남지 않는다. Released legal
hold와 그 target audit은 application row finalization에서 지우지만, 늦게 다시 연결되는 Local 설치를 삭제하려면
lifecycle job/local target의 payload-free UUID tombstone은 현재 별도 만료 없이 보존해야 한다.

`0012`는 새 `agent_threads`가 creator가 다른 private project를 참조하지 못하도록 creator-scope FK를 추가한다. FK는
upgrade 중 과거 application bug나 수동 SQL이 만든 비정상 참조 때문에 migration 자체를 막지 않도록 `NOT VALID`로
추가되며 새 row에는 즉시 적용된다. Account deletion은 요청 시점과 finalization 시점에 legacy mismatch를 다시 찾아
`scope_conflict`로 fail-closed 하고, 다른 사용자의 thread를 cascade로 삭제하지 않는다.

이 기능은 cryptographic erasure, storage block overwrite, `VACUUM FULL`, backup 암호화/서명, WAL/PITR/replica/
snapshot retention 또는 연결되지 않은 장치의 원격 삭제를 주장하지 않는다. 운영자는 runbook에 따라 별도 보존
매체의 만료와 폐기를 수행해야 한다.
