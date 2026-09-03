# ADR 0015: Product authentication lifecycle and shared login abuse limits

- 상태: 승인
- 날짜: 2026-09-03

## 배경

Product authentication은 register/login/logout/me와 SHA-256 session hash, Argon2id credential,
Origin/CSRF cookie 경계까지 제공하지만 사용자가 비밀번호를 바꾸거나 활성 세션을 확인·폐기할 수 없었다.
또한 로그인 실패 제한이 없어서 Product API process를 여러 개 실행할 때 process-local counter로는 공격자가
제한을 우회할 수 있다. Local Server HTTP와 열린 WebSocket은 이미 같은 `auth_sessions` row를 재검증하므로
새 인증 수명주기도 그 단일 폐기 경계를 유지해야 한다.

## 결정

### 비밀번호와 세션

`PATCH /api/auth/password`는 authenticated current session, exact allowed Origin, HttpOnly session cookie,
CSRF cookie/header와 HMAC double-submit을 모두 요구한다. 입력은 `currentPassword`와 `newPassword`만 허용하고
새 비밀번호에는 기존 등록 정책인 UTF-8 12~1,024 bytes를 그대로 적용한다. 서버는 새 Argon2id hash를 먼저
계산한 뒤 transaction에서 active account와 credential row를 `FOR UPDATE`로 잠그고 현재 비밀번호를 검증한다.
성공하면 credential을 바꾸고 현재 session ID를 제외한 다른 미폐기·미만료 session을 같은 transaction에서
폐기한다. 현재 세션을 유지하는 이유는 성공 응답과 Security UI가 끊기지 않게 하면서 탈취된 다른 세션을
즉시 무효화하기 위해서다. 사용자가 현재 세션까지 끝내려면 session revoke나 logout-all을 명시적으로 선택한다.

세션 API는 다음과 같다.

- `GET /api/auth/sessions`: 최대 100개를 `{id,current,createdAt,lastSeenAt,expiresAt,revoked,revokedAt}`로 반환
- `DELETE /api/auth/sessions/:id`: 자기 계정의 한 세션을 멱등 폐기하고 `204`; 다른 사용자/없는 ID는 동일 `404`
- `DELETE /api/auth/sessions`: 현재 세션을 유지하고 나머지 미폐기 세션을 폐기한 뒤 `204`
- `POST /api/auth/logout-all`: 현재 세션을 포함한 모든 미폐기 세션을 폐기하고 `204`

현재 세션을 개별 폐기하거나 logout-all을 하면 Product API는 session/CSRF cookie를 같은 응답에서 정확히
만료시킨다. browser client도 성공 즉시 CSRF를 메모리에서 지우고 unauthenticated event를 발생시켜 React
runtime과 WebSocket을 unmount한다. 세션 DTO에는 token/hash/cookie/CSRF, raw IP, 전체 User-Agent를 넣지 않는다.
클라이언트는 exact key와 UUID/ISO date/revoked 일관성을 엄격히 검사한다.

성공 mutation은 `audit_logs`에 `password_changed`, `session_revoked`, `logout_all`을 기록한다. actor/target ID,
current/scope와 revoke count만 bounded JSON으로 기록하며 password, token/hash, raw IP/User-Agent, request body는
기록하지 않는다.

### 로그인 남용 제한

새 `0006_auth_lifecycle.sql`은 `auth_login_rate_limits`를 추가한다. 기존 `0001`~`0005`는 변경하지 않는다.
table은 32-byte `bucket_hash`, window 시작, 실패 횟수, block 종료와 update 시각만 가진다. Product API는
`AUTH_COOKIE_SECRET`을 domain-separated HMAC-SHA-256 key로 사용해 다음 두 bucket을 만든다.

1. `login-email`: `trim().toLowerCase()`한 canonical email
2. `login-address`: Node HTTP connection의 직접 `request.socket.remoteAddress`

`X-Forwarded-For`, `Forwarded`와 유사 header는 신뢰하지 않는다. trusted reverse proxy 목록과 canonical client
address 처리는 별도 배치 결정 전에는 지원하지 않는다. 두 bucket row를 hash 정렬 순서로 transaction에서
upsert하고 `FOR UPDATE`로 잠근 상태에서 dummy/real Argon2 검증을 수행하므로 여러 Product API process와 동시
요청도 하나의 실패 예산을 공유한다. 기본값은 15분 window, 5회 실패, 15분 block이다. 설정은 각각 2~20회,
60~3,600초, 30~86,400초 hard range 밖이면 시작을 거부한다. 제한 도달/활성 block은 `429`, bounded
`Retry-After`(1~86,400초), `Cache-Control: no-store`를 반환한다.

성공 로그인은 canonical email bucket만 0으로 reset한다. 같은 직접 주소에서 다른 계정으로 발생한 실패를
한 계정의 성공이 지우지 않도록 address bucket은 유지한다. 존재하지 않는 account도 dummy Argon2와 같은
limiter 경로 및 generic invalid-credentials 응답을 사용한다. raw email/password/session/IP는 limiter table이나
로그에 저장하지 않는다. 각 로그인 transaction은 현재 window/block 중 더 긴 기간의 두 배보다 오래된 bucket을
`updated_at` index와 `FOR UPDATE SKIP LOCKED`로 최대 100개만 기회적으로 제거한다. 별도 무제한 table scan이나
동시 요청의 active bucket 삭제 없이 HMAC bucket이 영구 누적되는 것을 제한한다. 시스템 시계가 이전 window
시작보다 뒤로 이동한 경우에는 해당 window를 현재 주입 시각으로 초기화해 미래 window와 DB 제약 충돌을 막는다.

### Local Server와 UI

Local Server의 모든 HTTP authorization과 열린 WebSocket periodic reauthorization은 계속 같은 hash-only
`auth_sessions` repository를 사용한다. 비밀번호 변경으로 폐기된 다른 세션, 개별 폐기, logout-all은 새 bypass나
push channel 없이 기존 최대 5분/만료 중 빠른 재검증에서 HTTP `401` 또는 WebSocket close code `1008`이 된다.

계정 메뉴의 Security dialog는 strict session list, 개별/다른 세션 폐기, 비밀번호 변경과 logout-all을 실제
`ProductAuthClient`에 연결한다. password input은 request promise를 만들기 직전에 local 변수로만 캡처하고 React
state에서 즉시 지운다. Web Storage, IndexedDB, URL에는 쓰지 않는다. loading/empty/error/retry와 pending 동안
모든 destructive control disabled 상태를 제공한다.

## 제외 범위와 결과

외부 메일 전달·token 수명·확인 링크가 필요한 password reset과 email verification은 구현한 척하지 않고 후속
범위로 남긴다. register rate limit, distributed edge/WAF limit, trusted reverse proxy와 forwarded client address도
이번 결정에 포함하지 않는다. DB limiter는 Product API가 PostgreSQL에 도달한 뒤의 application 방어이며 DDoS
network boundary를 대체하지 않는다. 오래된 session row의 retention과 대규모 운영 cleanup job은 후속 범위다.
