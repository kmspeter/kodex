# ADR 0020: PostgreSQL-shared product abuse throttling

## 상태

Accepted — 2026-09-03

## 맥락

로그인은 이미 PostgreSQL 공유 실패 제한을 사용하지만 가입, unauthenticated invitation preview, invitation accept에는
process-local 또는 공유 제한이 없었다. 따라서 Product API process를 여러 개 실행하면 한 process의 memory limiter는
우회할 수 있고, valid-format random invitation token 조회와 대량 계정 생성이 DB/Argon2 비용을 계속 만들 수 있었다.
SMTP/email delivery, CAPTCHA, edge WAF 또는 신뢰한 reverse proxy 경계는 이 로컬 연구 제품의 현재 범위에 없다.

## 결정

새 immutable migration `0010_product_abuse_rate_limits.sql`은 `product_abuse_rate_limits` table 하나와 oldest-first
cleanup index 하나를 추가한다. primary key는 고정 `action`, 고정 `subject_kind`, 32-byte `subject_hash`이며 row에는
bounded attempt count, window 시작, block 종료, updated 시각만 있다. 허용 조합은 다음뿐이다.

- `register`: direct socket address, canonical email
- `invitation_preview`: direct socket address, presented valid-format token
- `invitation_accept`: authenticated account, direct socket address, presented valid-format token

`subject_hash`는 `AUTH_COOKIE_SECRET`을 key로 하고 version + action + kind를 모두 domain에 넣은 HMAC-SHA-256이다.
action 또는 kind가 다르면 같은 원문도 같은 hash가 될 수 없으며 invitation table의 token SHA-256을 복사하지 않는다.
raw/canonical email, IP/address, invitation token, invitation-table hash, user/session ID, cookie/CSRF, body, User-Agent,
`Forwarded`/`X-Forwarded-For`는 limiter row, 로그, error, audit, cursor 또는 metric에 저장하지 않는다.

각 요청의 모든 bucket은 key 순으로 정렬하고 한 PostgreSQL transaction에서 insert-if-absent 후 `FOR UPDATE`로 잠근다.
따라서 여러 API process가 같은 state를 공유하고, 겹치는 multi-bucket 요청도 lock order가 같아 partial counter update와
deadlock을 피한다. 현재 request를 더한 count가 configured attempts에 도달하면 그 bucket을 block하고 그 request도
고정된 `429`로 거절한다. 이미 active block인 request는 transaction 전체를 rollback하므로 어느 bucket count도 늘리지
않고 block 종료 시각도 연장하지 않으며, attacker가 바꾼 새 email/token의 0-count row도 남기지 않는다. `Retry-After`는
최소 1초, 해당 action의 configured block 이내이며 public response는 어떤 bucket이 제한했는지 말하지 않는다. exact
block/window boundary에서는 새 window를 시작하고, clock rewind도 보수적으로 window를 초기화한다.

가입은 strict body/canonical-email validation 다음, Argon2와 user/session/workspace repository 작업 전에 address+email을
소비한다. 성공이나 account conflict도 소비하며 성공 뒤 address를 reset하지 않아 서로 다른 email의 대량 가입도 direct
peer bucket으로 제한한다. Preview는 malformed token validation error는 유지하지만 valid-format token은 invitation lookup
전에 address+token을 소비한다. Accept는 session, exact Origin, CSRF와 body/token validation을 먼저 통과한 뒤 account+
address+token을 소비하고 invitation lookup/mutation을 시작한다. 기존 invitation unavailable masking, email 일치, workspace
membership/tenant/private history/RAG authorization은 바꾸지 않는다.

모든 설정은 listen 전에 strict integer와 hard range를 검증한다.

| action | attempts 기본값 | window 기본값 | block 기본값 |
| --- | ---: | ---: | ---: |
| register | 5 | 3,600초 | 3,600초 |
| invitation preview | 10 | 900초 | 900초 |
| invitation accept | 5 | 900초 | 900초 |

각 action은 `AUTH_<ACTION>_RATE_LIMIT_ATTEMPTS`(2..100),
`AUTH_<ACTION>_RATE_LIMIT_WINDOW_SECONDS`(60..86,400),
`AUTH_<ACTION>_RATE_LIMIT_BLOCK_SECONDS`(30..86,400)를 사용한다. `<ACTION>`은 `REGISTER`,
`INVITATION_PREVIEW`, `INVITATION_ACCEPT`이다.

Phase 20 retention sweep는 모든 abuse policy의 `max(window, block) × 2`보다 오래된 hash-only row를 별도 bounded batch로
삭제한다. `updated_at, action, subject_kind, subject_hash` deterministic order, `LIMIT`, `FOR UPDATE SKIP LOCKED`를 사용하고
아직 active인 block은 보존한다. 로그에는 table별 aggregate delete count와 고정 error class만 추가하며 cleanup endpoint,
bucket inspection/reset API, browser state 또는 public metric은 만들지 않는다.

## 결과와 한계

이것은 Product API application-level throttling이다. edge WAF, CAPTCHA, account reputation, email ownership 증명 또는
proxy-aware global client identity가 아니다. 서버는 Node의 direct socket peer만 사용하고 `Forwarded`와
`X-Forwarded-For`를 무시한다. 따라서 NAT 뒤 사용자는 address bucket을 공유한다. reverse proxy 뒤 배치하면 별도로
설계하고 검증한 trusted-proxy 경계가 생기기 전까지 모든 요청이 그 proxy의 address bucket을 공유한다. 여러 지역/DB를
분리한 배치는 하나의 global limit가 아니며 같은 PostgreSQL을 공유하는 process들만 같은 state를 본다.

hash-only 저장은 원문 노출을 줄이지만 secure erasure 또는 익명화를 보장하지 않는다. `AUTH_COOKIE_SECRET` rotation은
새 hash namespace를 만들 뿐 기존 row를 즉시 지우지 않으며 stale retention이 처리한다. PostgreSQL DELETE의 MVCC/WAL/
backup 한계와 autovacuum 운영은 ADR 0019와 같다. Email delivery, password reset/verification, CAPTCHA, WAF, trusted-proxy
지원, admin reset/inspection endpoint는 이 결정에 포함하지 않는다.
