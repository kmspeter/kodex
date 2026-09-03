# ADR 0016: hash-only workspace copy-link invitation lifecycle

- 상태: 승인
- 날짜: 2026-09-03

## 배경과 범위

기존 workspace 관리는 이미 가입한 계정을 관리자가 email로 즉시 추가할 수만 있었다. 가입 전 사용자와 링크를
전달받은 기존 사용자를 같은 안전한 흐름으로 다루기 위해 Product API와 PostgreSQL이 invitation 생성, pending
조회, 취소, preview, 수락을 소유한다. 이번 전달 수단은 관리자가 링크를 한 번 복사하는 방식뿐이다. SMTP,
외부 email delivery, reminder, password-reset email은 구현하지 않는다.

`0007_workspace_invitations.sql`은 workspace, canonical target email, 요청 역할, 생성자, 32-byte token hash,
만료, 수락자와 accepted/revoked 시각을 저장한다. target email은 수락 계정 일치와 관리자 pending 목록에 필요한
제품 PII이며 secret token과 다르다. 관리자 목록 이외의 API에는 raw email을 반환하지 않고 audit에는 email을
기록하지 않는다. 기존 `0001`~`0006`은 변경하지 않는다.

## 토큰과 브라우저 경계

서버는 `crypto.randomBytes(32)`로 256-bit entropy의 unpadded base64url token을 만들고
`SHA-256("kodex-workspace-invitation-v1\\0" || decoded-token)`만 DB에 저장한다. raw token은 생성 `201` 응답에
정확히 한 번만 포함하며 DB, audit, server log, 오류에 기록하지 않는다. unique hash collision은 전체 transaction을
최대 3회만 재시도한다. token은 정확히 43자의 canonical base64url이 아니면 DB 조회 전에 `422`로 거부한다.

preview와 accept는 query/path가 아닌 JSON `{token}` body만 사용한다. 모든 응답은 기존 Product API의
`Cache-Control: no-store, max-age=0`, Host allowlist, body limit, CORS/security header를 유지한다. 공유 URL은
`location.origin/#invite=<token>`이다. renderer entrypoint가 React 시작 전에 fragment를 메모리로 회수하고
`history.replaceState`로 URL에서 즉시 제거한다. token은 Web Storage, IndexedDB, cookie, analytics/log에 쓰지
않으며 terminal preview/accept 성공·실패 또는 닫기 뒤 메모리 상태에서 제거한다.

## 권한, transaction과 상태 정책

| 행위 | owner | admin | member/viewer |
| --- | --- | --- | --- |
| pending 목록 | 허용 | 허용 | 거부 |
| 초대 생성 | admin/member/viewer | member/viewer | 거부 |
| 초대 취소 | admin/member/viewer | member/viewer | 거부 |
| owner 역할 초대 | 금지 | 금지 | 금지 |

모든 workspace-scoped 행위는 URL의 workspace ID를 권한 증명으로 신뢰하지 않고 현재 `workspace_members` row를
다시 조회한다. 생성/목록/취소 transaction은 workspace row를 먼저 `FOR UPDATE`로 잠가 같은 workspace의 pending
중복과 개수 제한을 직렬화한다. 기본 TTL은 7일이며 `WORKSPACE_INVITATION_TTL_HOURS`는 1~720시간,
`WORKSPACE_INVITATION_PENDING_LIMIT`은 1~500, 기본 100 밖이면 시작을 거부한다. expired/accepted/revoked row는
active 조회에서 제외되고 같은 token으로 다시 활성화되지 않는다.

수락은 hash로 workspace를 찾은 뒤 workspace, invitation, active user와 기존 membership을 transaction에서 잠근다.
미만료·미사용·미취소 상태와 로그인 user의 DB canonical email exact match를 확인하고 membership INSERT와
`accepted_at/accepted_by_user_id` 갱신을 같은 commit에 넣는다. 같은 token의 동시 수락은 workspace/invitation
lock 때문에 정확히 하나만 `200`이고 나머지는 generic terminal 실패다. 이미 member인 경우 invitation 역할로
조용히 승격·강등하지 않는다. 기존 membership과 invitation을 모두 그대로 둔 채 `409 invitation_conflict`로
거부하므로 관리자가 기존 membership 또는 invitation을 명시적으로 정리해야 한다. 기존 last-owner 정책은
변경하지 않는다.

성공 생성/취소/수락은 `workspace.invitation_created`, `workspace.invitation_revoked`,
`workspace.invitation_accepted`를 audit에 기록한다. workspace/actor/invitation ID와 requested role만 기록하고 raw
email, token/hash, request body는 기록하지 않는다.

## REST 계약과 UI

- `POST /api/workspaces/:id/invitations` — session + exact Origin + CSRF, `{email,role}`, `201` one-time
  `{invitation,token}`
- `GET /api/workspaces/:id/invitations` — session + manager membership, `200 {invitations}`; active pending만 반환
- `DELETE /api/workspaces/:id/invitations/:invitationId` — session + exact Origin + CSRF, 성공 `204`
- `POST /api/invitations/preview` — exact Origin, `{token}`, 인증 없이 허용, `200`
  `{workspaceName,role,targetEmailHint,expiresAt}`
- `POST /api/invitations/accept` — authenticated session + exact Origin + CSRF, `{token}`, 성공 `200` workspace DTO

malformed DTO/token은 `422`, 인증 없음은 `401`, CSRF/권한/email mismatch/cross-workspace는 `403`, pending 중복,
상한, 기존 membership은 `409`, 없는 cancel ID는 `404`다. 알 수 없음, 만료, 취소, 재사용 token은 preview/accept
모두 동일한 `410 invitation_unavailable` body를 반환해 상태를 구별하지 않는다. preview는 account 존재 여부를
조회하거나 노출하지 않는다.

Workspace 관리 화면은 관리자에게 role 선택, pending 목록, 취소, loading/empty/error/retry와 disabled 상태를
제공한다. 생성 raw link는 닫기 전 한 번만 표시되며 server에서 다시 조회할 수 없다. Clipboard API 실패 시
readonly input 전체를 선택해 수동 복사를 안내한다. fragment invite는 unauthenticated AuthGate에서도 masked
preview를 보이고 로그인/가입 뒤 명시적 accept를 제공한다. 수락 뒤 `/api/auth/me`를 다시 조회하며 역할이
owner/admin/member이면 초대 workspace를 메모리 default로 선택해 Local Server bootstrap/WS 권한 검사를 새로
거친다. strict browser DTO는 pending/preview에서 token/hash/secret extra field를 거부한다.

## 남은 한계

분산 preview/accept rate limit, CAPTCHA/WAF, 대규모 expired row retention job, server-side pagination, resend와
reminder, SMTP/email delivery는 후속 범위다. 256-bit bearer token이 온라인 추측 방어의 주 경계이며 Product API
Host/Origin/body limit은 보조 경계다. invitation membership은 Saved DB History나 RAG 데이터 공유를 뜻하지 않고
기존 사용자별 private scope를 그대로 유지한다.
