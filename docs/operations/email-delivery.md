# Kodex email verification과 invitation delivery runbook

이 runbook은 Phase 32의 opt-in HTTPS webhook을 배치하고 복구하는 절차다. Email, verification/invitation URL,
raw token, session/CSRF, delivery bearer와 provider response body를 log, trace, metric label, ticket, screenshot,
dead-letter payload 또는 release artifact에 복사하지 않는다.

## Provider 계약

1. Product API 전용 HTTPS endpoint와 32~4,096자의 별도 bearer를 만든다. Cookie/operations/password-reset bearer,
   DB password나 model provider key를 재사용하지 않는다.
2. `Authorization: Bearer <secret>`와 `Content-Type: application/json`인 POST만 받고 method, content type와 body를
   제한한다. Redirect를 요구하지 말고 모든 성공은 2xx, 재시도 가능한 실패도 non-2xx로 반환한다.
3. 다음 exact 의미의 payload를 처리한다. 필드 원문은 provider 호출 수명 밖에 보존하지 않는다.

   ```json
   {
     "kind": "email_verification",
     "email": "target@example.com",
     "expiresAt": "2026-09-05T11:00:00.000Z",
     "verificationUrl": "https://kodex.example.com/#email-verification=<opaque>"
   }
   ```

   ```json
   {
     "kind": "workspace_invitation",
     "email": "target@example.com",
     "expiresAt": "2026-09-12T10:00:00.000Z",
     "invitationUrl": "https://kodex.example.com/#invite=<opaque>",
     "role": "member",
     "workspaceName": "Platform"
   }
   ```

4. Link rewriting, click tracking과 redirect를 끄고 fragment를 query로 바꾸지 않는다. Provider access/application
   log, APM body capture, retry queue와 analytics에서 email/URL을 제외한다. Provider가 자체 retry하지 않게 한다.

## Product API 설정

ACL이 제한된 `kodex.env` 또는 secret manager에 설정한다.

```dotenv
AUTH_EMAIL_DELIVERY_ENABLED=true
AUTH_EMAIL_DELIVERY_URL=https://mailer.example.com/v1/kodex-email
AUTH_EMAIL_PUBLIC_ORIGIN=https://kodex.example.com
AUTH_EMAIL_DELIVERY_BEARER_TOKEN=<distinct-secret>
AUTH_EMAIL_DELIVERY_TIMEOUT_MS=5000
AUTH_EMAIL_DELIVERY_MAX_RESPONSE_BYTES=4096
AUTH_EMAIL_DELIVERY_MAX_ATTEMPTS=4
AUTH_EMAIL_DELIVERY_RETRY_BASE_SECONDS=30
AUTH_EMAIL_DELIVERY_POLL_SECONDS=5
AUTH_EMAIL_DELIVERY_LEASE_SECONDS=60
AUTH_EMAIL_VERIFICATION_TTL_MINUTES=60
PRODUCT_RETENTION_EMAIL_VERIFICATION_DAYS=30
PRODUCT_RETENTION_EMAIL_DELIVERY_DAYS=30
```

Webhook URL은 development에서도 HTTPS여야 한다. Production public origin은 path/credential 없는 HTTPS exact
origin이어야 한다. 상세 hard range와 resend/complete limiter 변수는 `.env.example`이 기준이다. Bearer는 renderer
environment와 Vite bundle로 전달하지 않는다.

## 배치와 확인

1. 검증된 backup을 준비하고 migration job으로 0013을 적용한다. `email_verified_at IS NULL`이던 기존 user가
   backfill되어 로그인 가능한지 확인한다. Application 역할로 migration을 실행하지 않는다.
2. Provider를 활성화하기 전에 endpoint 인증, body capture 비활성화와 exact public origin을 확인한다. Provider가
   꺼져 있어도 신규 가입은 unverified이며 payload-free job만 쌓이고 raw token은 생성되지 않는다.
3. 테스트 계정을 가입해 `202 verification_pending`, `/api/auth/me`의 `401`, status의 `pending`을 확인한다.
   Inbox 링크는 fragment-only여야 하며 화면 bootstrap 직후 address bar에서 제거되어야 한다.
4. Resend가 같은 generic `202`를 반환하고 이전 링크가 `410`, 최신 링크가 한 번만 `204`인지 확인한다. 확인 뒤
   같은 session의 `/api/auth/me`가 성공하는지 확인한다.
5. Workspace 초대 생성 응답이 `{invitation,deliveryStatus:"pending"}`이고 token/URL/provider field가 없는지,
   받은 링크가 한 번만 accept되는지 확인한다.
6. DB schema에서 verification은 `token_hash`만, delivery job은 payload-free metadata만 갖는지 확인한다. 배치 기록에는
   release, migration 13, aggregate job 상태와 시각만 남긴다.

Source/CI 검증 entrypoint는 다음과 같다. 이 runbook을 수행할 때도 실제 수신 주소나 token을 출력하지 않는다.

```powershell
npm test -- test/unit/email-verification.test.ts test/unit/email-delivery.test.ts test/unit/email-verification-ui.test.tsx test/unit/workspace-management-ui.test.tsx
npm run test:email-verification-postgres
npm run test:retention-postgres
npm run test:abuse-rate-limit-postgres
npm run verify:ui-bundle
```

## 관측과 장애 대응

- `pending/retry` 증가: Provider TLS/DNS/2xx와 worker 실행 여부를 aggregate로 확인한다. Queue row를 편집하거나 token을
  복원하지 않는다. 원인을 고치면 `available_at`에 따라 자동 retry되며 attempt마다 이전 링크가 무효화된다.
- Provider가 요청을 받았는지 불명확한 timeout: 먼저 도착한 메일 링크가 retry 뒤 무효일 수 있다. 사용자에게
  pending 화면의 resend를 사용하게 하고 기존 URL을 ticket으로 받지 않는다.
- Terminal `failed`: Verification proof는 revoke되고 invitation도 revoke된다. 실패 row/token을 되살리지 말고
  verification은 authenticated resend, invitation은 관리자가 새 invitation을 만들게 한다.
- 대량 429: PostgreSQL account/address/token HMAC bucket과 edge 비용 제어를 확인한다. Raw subject를 역추적하지 않는다.
- Bearer 노출 의심: Provider와 Product API에서 secret을 교체하고 재기동한다. 열린 delivery job을 임의 dump하지 말고
  필요하면 승인된 transaction으로 취소한 뒤 사용자/관리자가 새 요청을 만들게 한다.
- Provider 중지: `AUTH_EMAIL_DELIVERY_ENABLED=false`로 재기동하면 worker가 멈춘다. Queue는 payload-free pending 상태로
  남고 verification raw token은 생성되지 않는다. 이 동안 신규 가입은 완료할 수 없으므로 가입 유입도 함께 막거나
  명시적으로 공지한다.
- Retention 실패: fixed aggregate failure만 조사한다. 임의 bulk delete나 provider payload 조회를 하지 않는다.
  PostgreSQL delete는 backup/WAL/replica/provider 보존의 secure erasure가 아니다.

SMTP/template, bounce/complaint 처리, deliverability, mailbox 접근, provider의 법적 보존과 edge DDoS/WAF는 Kodex가
관리하지 않는다.
