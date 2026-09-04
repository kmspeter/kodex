# Kodex account recovery runbook

이 runbook은 Phase 26 비밀번호 재설정의 provider 연결, 검증, 장애 대응 절차다. Email, reset URL/token,
비밀번호, cookie/CSRF와 delivery bearer secret을 log, ticket, metric label 또는 release artifact에 복사하지 않는다.

## Provider 준비

1. Product API 전용 webhook endpoint와 32자 이상의 별도 bearer secret을 만든다. `AUTH_COOKIE_SECRET`, DB password,
   OpenAI key를 재사용하지 않는다.
2. Provider가 다음 HTTPS POST만 받아 사용자가 요청한 비밀번호 재설정 안내를 보내도록 구성한다.

   ```json
   {
     "kind": "password_reset",
     "email": "target@example.com",
     "expiresAt": "2026-09-04T10:00:00.000Z",
     "resetUrl": "https://kodex.example.com/#password-reset=<opaque>"
   }
   ```

3. `Authorization: Bearer <secret>`를 constant-time으로 확인하고 허용된 Product API source만 받는다. 본문 크기와
   method/content type을 제한한다. 성공은 모든 2xx, 거부는 non-2xx로 반환한다.
4. Provider의 access/application log, tracing body capture, analytics link rewriting, retry/dead-letter queue에서
   email과 reset URL을 제외한다. URL fragment를 query로 바꾸거나 클릭 추적 redirect를 삽입하지 않는다.
5. 사용자가 받는 안내에는 만료 시각, 본인이 요청하지 않았을 때 무시하라는 문구와 정확한 Kodex origin을
   표시한다. Provider가 자동 재전송하지 않도록 한다.

## Product API 설정

Secret manager 또는 ACL이 제한된 `kodex.env`에 다음을 주입한다.

```dotenv
AUTH_PASSWORD_RESET_ENABLED=true
AUTH_PASSWORD_RESET_DELIVERY_URL=https://mailer.example.com/v1/kodex-password-reset
AUTH_PASSWORD_RESET_PUBLIC_ORIGIN=https://kodex.example.com
AUTH_PASSWORD_RESET_DELIVERY_BEARER_TOKEN=<distinct-secret>
AUTH_PASSWORD_RESET_DELIVERY_TIMEOUT_MS=5000
AUTH_PASSWORD_RESET_TTL_MINUTES=60
```

Production에서는 두 URL 모두 HTTPS가 아니면 Product API가 listen 전에 실패한다. Public origin은 path 없는 exact
UI origin이어야 한다. Request/complete 공유 limiter와 terminal retention은 `.env.example`의
`AUTH_PASSWORD_RESET_*_RATE_LIMIT_*`, `PRODUCT_RETENTION_PASSWORD_RESET_DAYS`로 조정한다. 제한을 완화하기 전
NAT 사용자 영향, 공격량과 provider 비용을 함께 검토한다.

## 배치와 확인

1. Phase 24 backup을 검증하고 Product API를 새 release로 올린다. Migration 0011 적용과 readiness를 확인한다.
2. 운영 도메인의 테스트 account로 한 번 요청한다. Browser/HTTP 응답은 account 존재 여부와 무관하게 exact
   `202 {"ok":true}`여야 한다.
3. Provider의 aggregate accepted count만 확인하고 inbox 링크 origin/fragment/expiry를 직접 검토한다. 링크를
   사용해 새 비밀번호를 설정하고 이전의 모든 browser/device session이 종료되는지, 이전 비밀번호가 실패하고
   새 비밀번호가 성공하는지 확인한다.
4. 같은 링크 재사용이 `410`인지 확인한다. DB에는 `token_hash`만 있고 raw token/email/reset URL column이나
   audit detail이 없어야 한다.
5. 배치 record에는 release version, migration 11, aggregate 성공/실패와 시각만 남긴다. 실제 address나 URL을
   기록하지 않는다.

Source/CI의 반복 가능한 검증은 다음과 같다.

```powershell
npm test -- test/unit/password-reset.test.ts test/unit/product-auth-client.test.ts test/unit/product-auth-ui.test.tsx
npm run test:password-reset-postgres
npm run test:retention-postgres
npm run test:abuse-rate-limit-postgres
npm run test:desktop-password-reset
```

## 장애 대응

- Webhook timeout/non-2xx/network failure: 사용자는 동일한 202를 받으며 생성 요청은 즉시 폐기된다. Aggregate
  `password_reset_delivery` failure 증가와 provider health를 확인하고 복구 후 사용자가 새 안내를 요청하게 한다.
  실패 row를 되살리거나 token을 재전송하지 않는다.
- 대량 429: address/email 또는 address/token HMAC bucket이 공유 DB에서 동작 중인지 확인한다. Raw subject를
  역추적하려 하지 말고 edge/WAF와 provider 제한을 강화한다.
- 의심되는 token 노출: delivery bearer secret을 교체하고 영향 시간대의 미처리 reset을 `revoked_at`으로
  폐기한다. 필요하면 affected account session을 별도 승인된 절차로 종료한다. Token hash로 원문을 복구할 수 없다.
- 잘못된 public origin 또는 provider secret: 기능을 `false`로 내려 요청 endpoint를 `503`으로 fail-closed한 뒤
  설정을 고쳐 재기동한다. 임시로 token을 UI/API 응답이나 운영자 화면에 노출하지 않는다.
- DB/retention 장애: password 변경 transaction은 전체 rollback된다. Aggregate maintenance failure를 조사하고
  terminal row를 임의 bulk delete하지 않는다. Backup/WAL/replica에는 retention 이후에도 과거 row가 남을 수 있다.
