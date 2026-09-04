# ADR 0025: Hash-only 일회용 비밀번호 재설정

- 상태: 승인
- 날짜: 2026-09-04

## 배경과 결정

비밀번호를 잊은 사용자는 기존 session 없이 계정을 복구해야 한다. 이 경로는 계정 존재 여부, reset token,
새 비밀번호를 노출하지 않으면서 전달 provider 장애와 동시 사용을 안전하게 처리해야 한다. Phase 26은 email
verification과 일반 email 발송 시스템을 만들지 않고, 운영자가 선택한 HTTPS webhook을 비밀번호 재설정 전달
경계로 사용한다. 기능은 `AUTH_PASSWORD_RESET_ENABLED=true`일 때만 활성화된다.

`POST /api/auth/password-reset/request`는 exact JSON email을 받아 알려진 active account와 알 수 없는 account에
항상 `202 {"ok":true}`를 반환한다. PostgreSQL 공유 limiter는 socket address와 normalized email을
action/kind-domain-separated HMAC으로만 저장한다. 정상 처리 경로는 기본 750 ms까지 padding해 빠른 unknown-account
응답의 timing 차이를 줄인다. Provider 거부, timeout, network 실패도 같은 공개 응답이며 고정 aggregate log만
남긴다. Rate limit `429`, malformed input `400`, 기능 미설정 `503`은 계정 존재 여부와 무관한 경계 오류다.

알려진 account에는 CSPRNG 256-bit token을 생성하고, DB에는
`SHA-256("kodex-password-reset-v1\\0" || token)` 32바이트만 저장한다. Email, raw token, reset URL은
`password_reset_requests`, audit, application log에 저장하지 않는다. 새 요청은 user row lock 아래 기존 미처리
요청을 폐기하고 하나만 만든다. 기본 만료는 60분이며 15분~24시간 범위에서만 설정할 수 있다.

Webhook은 bearer-authenticated exact JSON `kind`, `email`, `expiresAt`, `resetUrl`을 한 번 받는다. URL secret은
query가 아닌 `#password-reset=<token>` fragment에만 있고 UI bootstrap이 React/API 시작 전에 history replacement로
주소 표시줄에서 제거한다. Provider는 URL/token을 log, retry queue, analytics, support payload에 보존하지 않아야
한다. 전달 실패 시 해당 DB 요청을 즉시 delivery-failed/revoked 처리하며 자동 재시도하지 않는다.

`POST /api/auth/password-reset/complete`는 token과 UTF-8 12~1,024-byte 새 비밀번호만 받는다. Token 대상 조회
전 Argon2id hash를 계산하고 address/token HMAC limiter를 적용한다. Repository는 candidate user와 reset row를
잠가 미사용·미폐기·미실패·미만료 상태를 한 번만 소비한다. 같은 transaction에서 credential을 바꾸고 해당
사용자의 모든 active session과 다른 pending reset을 폐기한 뒤 token/email 없는 audit event를 기록한다.
성공은 cookie를 지우는 `204`, 잘못됨·만료·폐기·재사용은 같은 `410 reset_unavailable`이다.

## 보존과 운영

Migration `0011_password_reset_recovery.sql`은 hash-only table, pending-user uniqueness, terminal retention index와
reset abuse action을 추가한다. Terminal timestamp는 `COALESCE(consumed_at, revoked_at, expires_at)`이며 기본 30일,
`PRODUCT_RETENTION_PASSWORD_RESET_DAYS` 1~3,650일 범위다. Bounded oldest-first `SKIP LOCKED` sweep는 기존
session/invitation/limiter cleanup과 같은 coordinator에서 실행된다.

운영 절차와 provider 책임은 [account recovery runbook](../operations/account-recovery.md)에 둔다. Cookie secret과
delivery bearer secret은 별개로 생성하고 secret manager에서 주입한다. Production public origin과 webhook은
HTTPS여야 하며 UI와 Product API의 기존 same-origin 배치를 유지한다.

## Acceptance와 비목표

`npm run test:password-reset-postgres`는 fresh 0001~0011 DB와 실제 immutable 0001~0010 ledger upgrade를 각각
실행한다. 실제 loopback webhook과 Product HTTP를 통해 known/unknown 응답 일치, hash-only schema, fragment URL,
동시 두 번 사용 중 정확히 한 번 성공, 기존 모든 session 폐기, 이전 비밀번호 거부, 새 비밀번호 로그인과
provider 실패 보상을 검증한다. Retention harness는 reset boundary와 index plan을 별도로 확인한다.
`npm run test:desktop-password-reset`은 실제 PostgreSQL, Product API, Local Server, Electron renderer와 loopback
delivery provider를 함께 실행해 DOM 회원가입/로그아웃/generic 요청, fragment 조기 제거, 새 비밀번호 설정,
별도 active session 폐기, 이전 비밀번호 거부와 새 비밀번호 로그인을 검증한다.

외부 SMTP/transactional-email 제품의 실제 inbox delivery, bounce/complaint 처리, email 소유권 verification,
MFA recovery, support-assisted recovery는 이 단계 범위가 아니다. 750 ms padding은 일반적인 빠른 provider에서
응답 차이를 줄이는 방어층이며 느린 provider의 통계적 timing 차이를 완전히 제거하는 durable delivery queue는
제공하지 않는다. Edge rate limit/WAF와 provider 자체 abuse·privacy 통제가 추가로 필요하다.
