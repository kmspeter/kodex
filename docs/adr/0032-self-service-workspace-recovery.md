# ADR 0032: Owner 전용 self-service Workspace recovery

- 상태: 승인
- 날짜: 2026-09-05

## 배경

Workspace archive는 접근을 즉시 막되 application row와 tenant file을 보존하는 soft-delete 경계다. 기존에는
운영자도 사용자의 archive를 되돌리는 제품 경로가 없었다. 반면 permanent deletion은 durable Product/Local
worker가 application row와 알려진 tenant root를 제거하는 별도 파괴 절차다. Self-service recovery가 이 절차를
취소하거나 backup restore·forensic recovery처럼 동작해서는 안 된다.

Phase 33은 verified account owner가 자신이 archive한 Workspace를 제한된 목록에서 찾아 복구할 수 있게 한다.
다른 tenant, admin, member와 존재하지 않는 ID에는 Workspace 존재 여부를 누출하지 않고, password와 명시적
확인을 다시 요구하며, lifecycle worker와의 경합에서는 복원보다 삭제 안전성을 우선한다.

## 결정

새 migration은 추가하지 않는다. `workspaces.deleted_at`과 `purge_requested_at`, 기존
`data_lifecycle_jobs`, `data_lifecycle_job_workspaces`, `data_lifecycle_local_targets`, `data_legal_holds`가
복원 가능성과 영구 삭제 증거를 표현하기에 충분하다. Migration 0001~0013과 vendor/generated/source pin은
변경하지 않는다.

`GET /api/workspaces/archived`는 현재 verified account가 owner인 대상만 반환한다. 다음 조건을 모두 만족해야 한다.

- Workspace row와 현재 owner membership이 존재하고 `deleted_at IS NOT NULL`이다.
- `purge_requested_at IS NULL`이다.
- Workspace나 account에 연결된 lifecycle job/job-workspace tombstone이 없다.
- 알려진 Local installation의 lifecycle target이 없다.
- Workspace 또는 account scope의 active legal hold가 없다.

목록은 `deleted_at DESC, id DESC` keyset으로 정렬하며 기본 50개, 최대 100개다. Opaque cursor는 account ID에
묶어 authenticated encryption하므로 다른 account에서 재사용할 수 없다. 조건을 만족하지 않는 대상은 목록에
부분 상태나 이유를 노출하지 않는다.

`POST /api/workspaces/:id/restore`는 authenticated verified session, exact Origin, HttpOnly session,
CSRF cookie/header와 exact JSON `{ "confirmation", "confirmationName", "currentPassword" }`를 요구한다.
Phrase는 대소문자와 공백까지 정확한 `RESTORE WORKSPACE`이고, 이름은 transaction에서 잠근 현재 이름과 exact
equality여야 한다. 현재 비밀번호는 기존 Argon2 credential verification 경계를 그대로 사용하고 request 또는
audit payload로 보존하지 않는다.

Repository transaction은 Workspace와 owner membership을 잠근 뒤 current user/credential/session을 잠그고
검증한다. 이어 purge 요청, lifecycle job/job-workspace tombstone, Local target과 active legal hold를 잠가 다시
확인한다. Worker가 관련 row를 이미 잠근 경합은 기다려 삭제 절차와 교착하거나 뒤집지 않고 명시적 conflict로
실패한다. 영구 삭제의 requested/running/completed 상태, tombstone, 알려진 Local 삭제 target 또는 불완전한
application 보존 증거는 모두 fail-closed다. 없는 ID와 다른 tenant/non-owner는 같은 forbidden 경계다. 이미
active인 대상에 대한 duplicate restore는 명시적 conflict다.

성공 mutation은 `workspaces.deleted_at`만 NULL로 바꾸고 stable `workspace.restored` audit action을
payload-free details와 함께 남긴다. `updated_at`, membership, invitation, project, History/RAG, tenant file,
runtime start intent는 수정하지 않는다. Archive 때 취소된 invitation이나 그 밖에 이미 삭제된 row/file을
재생성하지 않는다. 이후 `/api/auth/me`, Product/Local 요청과 runtime bootstrap은 일반 active-workspace
authorization과 membership revalidation을 새로 거쳐야 한다.

## Renderer와 runtime 경계

Workspace 관리 UI는 account-scoped **Archived Workspaces** 목록을 bounded page로 읽고 한 대상만 복구한다.
Password, confirmation name과 phrase는 제출 시 즉시 component state에서 지우고 account/selection/dialog 변경
시에도 초기화한다. Stale 응답은 account/selection generation과 mounted 상태를 확인한 뒤 반영한다. Server
credential, session token, CSRF proof는 renderer storage나 log에 남기지 않는다.

Restore 뒤 active Workspace fallback은 유지하되 복구된 Workspace의 Local runtime을 자동 시작하거나 자동
선택하지 않는다. 사용자가 명시적으로 runtime start를 선택한 뒤에도 Product/Local authorization이 다시
검증된다.

## 결과와 비목표

이 기능은 보존된 soft archive의 접근 플래그만 되돌린다. Permanent deletion을 취소하지 않고, lifecycle row나
tombstone을 삭제하지 않으며, 운영 backup/WAL/replica/snapshot/manual copy에서 데이터를 가져오지 않는다.
Application row 또는 tenant file이 실제로 사라진 incident는 이 endpoint로 고치지 않고 별도 승인된
backup/forensic 절차로 다룬다. Private History/RAG의 `(workspace_id, created_by_user_id)` scope와 공식 App
Server/tenant filesystem 경계는 변하지 않는다.

## 검증

Unit/API/browser parser tests는 strict DTO와 cursor account binding, exact Origin/CSRF/body, current password,
name/phrase, secret clearing과 no-auto-runtime을 검증한다. Disposable PostgreSQL harness는 cross-tenant,
non-owner, legal hold, running worker lock, permanent deletion/tombstone, duplicate restore, revoked invitation
불변, retained/deleted application row와 정상 authorization 회복을 검증한다.
