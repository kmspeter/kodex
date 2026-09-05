# ADR 0031: Email verification과 payload-free invitation delivery

- 상태: 승인
- 날짜: 2026-09-05

## 배경

기존 가입은 계정 생성과 동시에 완전한 Product session을 발급했고 Workspace 초대는 hash-only token 원문을
browser에 한 번 반환했다. Phase 32는 기존 사용자를 잠그지 않으면서 신규 이메일 소유권을 확인하고, 선택적으로
외부 email provider를 통해 확인/초대 링크를 전달해야 한다. Provider 장애를 HTTP 요청 수명에 묶거나 token,
email, URL, provider response를 durable queue와 log에 남기는 방식은 허용하지 않는다.

## 결정

Migration `0013_email_verification_delivery.sql`만 새로 추가한다. 기존 `users.email_verified_at IS NULL` row는
`created_at`으로 backfill해 모두 verified로 취급한다. 이후 Product API의 신규 가입은 user, credential,
Personal Workspace, owner membership, 제한 session과 `email_delivery_jobs` row를 한 transaction에서 만들며
`email_verified_at`은 NULL로 둔다. 제한 session은 status/resend/logout에만 사용할 수 있고 `/api/auth/me`,
Workspace, History, Knowledge와 Local runtime bootstrap에는 사용할 수 없다.

Verification token은 provider 호출 직전에 Node CSPRNG로 정확히 32 bytes를 생성한다. Browser와 API는 canonical
43-character unpadded base64url만 받고, DB에는 domain-separated SHA-256만 저장한다. Token은 만료, resend,
delivery terminal failure, 성공 consume 중 하나로 terminal이 되며 consume은 user row lock 아래 단 한 번만
성공한다. Resend는 이전 proof와 열린 job을 폐기하고 새 payload-free job을 만든다. 잘못됨, 만료, 폐기,
재사용은 모두 `410 verification_unavailable`이다.

`GET /api/auth/email-verification/status`는 제한 session을 요구한다. Resend는 exact Origin, HttpOnly session,
CSRF cookie/header HMAC과 exact `{}` body를 요구하고 항상 `202 {"ok":true}`이다. 이미 verified인 session에도
같은 응답을 반환한다. Complete는 password-reset complete와 같은 fragment bearer 경계로 exact Origin과 exact
`{"token"}`을 요구한다. PostgreSQL 공유 limiter는 resend에 account/address, complete에 address/token HMAC
bucket을 사용하며 raw subject를 저장하지 않는다.

Browser URL은 `/#email-verification=<token>`이다. `main.tsx`가 React bootstrap 전에 fragment를 제거하고 token을
메모리로만 넘긴다. Query string, Web Storage, IndexedDB, log, audit, renderer environment에는 넣지 않는다.

## Email delivery 경계

`AUTH_EMAIL_DELIVERY_ENABLED=true`일 때만 outbound worker를 시작한다. Webhook URL은 환경에 관계없이 HTTPS이고
production public origin도 HTTPS exact origin이어야 한다. Server-only bearer, redirect 거부, bounded timeout,
bounded response body와 fixed error를 적용한다. Provider에는 다음 두 payload 중 하나만 순간적으로 전달한다.

- `email_verification`: email, expiry, fragment-only `verificationUrl`
- `workspace_invitation`: email, Workspace name, role, expiry, fragment-only `invitationUrl`

Durable `email_delivery_jobs`에는 kind, target FK, 상태, attempt, availability, lease, fixed error code와 시각만 둔다.
Email, token/hash, URL, payload와 provider response column은 금지한다. Worker는 `FOR UPDATE SKIP LOCKED`와 expiring
lease로 claim하고 exponential retry한다. Secret을 durable하게 재사용할 수 없으므로 매 attempt에 token을 새로
만들고 이전 hash를 폐기/교체한다. Provider가 요청을 받은 뒤 응답이 유실된 모호한 실패에서는 먼저 도착한 링크가
후속 retry로 무효화될 수 있으며, 이는 stale token을 계속 유효하게 두는 것보다 안전한 선택이다.

Delivery 설정이 없으면 worker와 raw verification token을 만들지 않는다. 신규 계정과 payload-free job은 pending에
남으므로 운영자는 가입을 받기 전에 provider를 구성해야 한다. 이후 provider를 활성화하면 backlog를 처리한다.
기존 verified 사용자는 영향받지 않는다. Workspace invitation은 설정 시 raw token을 생성/반환하지 않고 delivery
job만 만들며, 설정하지 않은 배치는 기존 one-time copy-link 계약을 유지한다.

## 보존과 결과

Terminal verification proof와 delivery job은 각각 기본 30일 후 bounded oldest-first retention으로 정리한다.
이 삭제는 WAL, replica, snapshot, dump 또는 provider 보존을 지우는 secure erasure가 아니다. 로그는
`category`, `kind`, `outcome`, `attempt` 같은 고정 cardinality만 허용한다.

이 결정은 SMTP client, template engine, bounce/complaint ingestion, reminder scheduler, provider message ID,
delivery status 공개 API를 추가하지 않는다. Provider 자체의 payload 처리와 inbox 보안은 운영 신뢰 경계다.

## 검증

Targeted unit tests는 canonical fragment 제거, strict DTO, pending/resend/status UI, bearer/redirect/timeout/body bound,
payload-free retry/terminal log와 invitation delivery 상태를 검증한다. Disposable PostgreSQL harness는 fresh 0001~0013,
immutable 0001~0012 → 0013 backfill, unverified session 격리, resend rotation, concurrent single consume, shared limiter,
delivery retry rotation, hash-only DB와 retention index/query를 검증한다.
