# ADR 0012: 제품 workspace 생성과 existing-account membership 관리

- 상태: 승인
- 날짜: 2026-09-03

> 후속 결정: pending copy-link invitation은 ADR 0016에서 추가되었다. 이 문서의 existing-account 직접 추가
> 계약과 last-owner 정책은 그대로 유지된다.

## 배경과 결정

메모리 전용 workspace 전환은 이미 여러 membership을 안전하게 reconcile하지만 membership을 만드는 제품
경로가 없었다. Product API가 workspace 생성과 member read/add/update/delete를 소유하고 PostgreSQL을
권한의 기준으로 사용한다. UI는 브라우저-safe allowlist DTO만 읽으며 mutation 뒤 항상 `/api/auth/me`를
재검증한다. 새 workspace 생성자는 owner로 같은 transaction에서 추가되고, UI는 생성 성공 후 그
workspace를 즉시 선택한다. membership 변경은 기존 reconcile 규칙을 사용하므로 제거나 viewer 강등은
현재 runtime을 폐기하고 다른 실행 가능한 membership으로 fallback한다.

이번 단계의 "추가"는 가입·활성 상태인 기존 계정의 canonical lowercase email을 정확히 찾는 기능이다.
메일 초대, pending membership, invite token, 이메일 발송은 만들지 않는다. 존재하지 않는 email은 일관된
`404 not_found`를 반환한다. 이 응답은 계정 존재 여부를 확인하는 신호가 될 수 있으므로 운영 배포는
사용자/IP별 rate limit과 abuse monitoring을 reverse proxy 또는 향후 API limiter에서 추가해야 한다.
현재 구현은 본문/필드 길이를 제한하지만 분산 rate limit은 제공하지 않는다.

## 권한과 owner 불변식

| 행위 | owner | admin | member/viewer |
| --- | --- | --- | --- |
| member 목록 조회 | 허용 | 허용 | 허용 |
| 기존 계정 추가 | 모든 역할 | member/viewer만 | 거부 |
| 역할 변경 | 모든 역할 | member/viewer 사이만 | 거부 |
| 제거 | 모든 역할 | member/viewer, 또는 자기 자신 | 거부 |
| owner/admin 권한 변경 | 허용 | 거부 | 거부 |

owner 승격은 owner만 할 수 있다. 별도 transfer endpoint 대신 먼저 다른 멤버를 owner로 승격한 다음 기존
owner를 강등/제거하는 두 단계 정책을 쓴다. 자기 자신 제거는 위 표의 관리 권한 안에서 허용하지만 마지막
owner는 자신을 포함해 누구도 강등하거나 제거할 수 없다. 모든 mutation은 workspace row를 `FOR UPDATE`로
잠근 transaction에서 실행하고 owner row도 잠근 뒤 남은 owner를 확인한다. 따라서 두 owner를 동시에
강등/제거해도 하나만 commit된다. `workspaces.owner_user_id`는 권한 기준이 아니라 legacy 대표 owner
reference이며 실제 권한은 `workspace_members.role`이다. 대표 owner가 바뀌면 같은 transaction에서 갱신한다.

## API, 오류, audit와 누출 경계

- `POST /api/workspaces`
- `GET|POST /api/workspaces/:id/members`
- `PATCH|DELETE /api/workspaces/:id/members/:userId`

read는 authenticated session을, write는 exact Origin, HttpOnly session cookie, CSRF cookie/header HMAC을 모두
검사한다. 입력은 exact-key parser를 사용하고 workspace name은 NFC, 1~100 Unicode code point, 앞뒤/연속
공백과 control character 금지를 적용한다. 역할은 `owner/admin/member/viewer` enum만 허용한다. 상태 계약은
`401` 인증 없음, `403` scope/권한/CSRF 거부, `404` 기존 계정 또는 membership 없음, `409` 중복/last-owner,
`422` 유효성 실패다. 비멤버가 workspace 또는 target ID를 추측하면 target 존재와 관계없이 `403`이다.

성공 mutation은 같은 transaction의 `audit_logs`에 고정 action, actor/workspace/target ID, 이전·다음 역할
같은 bounded metadata만 기록한다. email, display name, password hash, session token/해시와 요청 body는 audit
details에 넣지 않는다. 응답도 user ID, canonical email, display name, role, joined time만 허용한다.

## Local Server와 private 데이터

Local Server는 별도 cache나 test bypass 없이 기존 주기적 `findAuthContext` 재검증을 계속 사용한다.
member에서 viewer로 강등되거나 membership이 제거되면 새 bootstrap/WS upgrade는 `403`, 열린 WS는 다음
재검증에 code `1008`로 닫힌다. viewer는 Product member read는 가능하지만 runtime은 사용할 수 없다.

Workspace membership은 데이터 공유 권한이 아니다. Saved DB History의 thread/project read와 RAG의 source,
document, chunk, query/citation은 계속 `(workspace_id, created_by_user_id)` 또는 동등한 user scope를 요구한다.
실제 PostgreSQL history/RAG integration은 같은 workspace의 A/B가 서로의 데이터를 읽지 못함을 검증한다.

## 남은 한계

초대/이메일/가입 전 pending member, workspace 삭제·rename, 대량 member 관리, 감사 로그 UI/export, 분산 rate
limit은 범위 밖이다. member 목록은 현재 최대 10,000개의 strict response를 허용하지만 server pagination은
없다. owner transfer는 원자적인 단일 제품 동작이 아니라 위의 안전한 두 단계 절차다.
