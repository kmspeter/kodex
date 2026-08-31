# ADR 0002: 제품 인증 API와 세션 경계

- 상태: 승인
- 날짜: 2026-08-31

## 결정

제품 인증은 기존 단일 사용자 `apps/local-server`와 분리한 `apps/api`가 담당한다.
Local Server의 bootstrap token, loopback Host/Origin 검사, Codex App Server 수명과
제품 사용자 인증은 서로 다른 신뢰 경계이며 쿠키나 secret을 공유하지 않는다.

`0001_initial_product_schema.sql`은 변경하지 않는다. `0002_password_credentials.sql`이
정규화된 이메일 DB check, Argon2id PHC 문자열만 허용하는 `password_credentials`,
그리고 정확히 32바이트인 session SHA-256 제약을 추가한다. 등록 repository는 사용자,
credential, 기본 workspace, owner membership, 첫 session을 하나의 PostgreSQL transaction에
만든다. HTTP 계층은 SQL을 소유하지 않는다.

## 비밀번호와 계정 열거 방어

비밀번호는 `argon2` 0.44.0의 Argon2id로 해시한다. PHC parameter는 버전 19,
memory 19,456 KiB, time cost 2, parallelism 1, output 32 bytes다. 입력 비밀번호는
UTF-8 기준 12~1,024 bytes만 허용하고 요청, 오류, 로그, DB 어느 곳에도 평문을 남기지
않는다. 로그인에서 사용자가 없을 때도 시작 시 만든 dummy Argon2id hash를 실제 hash와
같은 verifier로 검사하며, 잘못된 이메일과 비밀번호는 동일한 status와 body를 반환한다.

## 세션, 쿠키, CSRF

세션 bearer는 `randomBytes(32)`의 base64url 표현이다. 원문은 HttpOnly cookie로만
전달하고 DB에는 SHA-256 digest만 저장한다. lookup은 만료, `revoked_at`, 사용자 상태와
soft deletion을 함께 검사한다. 로그아웃은 session row를 폐기하고 두 cookie를 만료한다.

세션 cookie는 `Path=/`, `HttpOnly`, `SameSite=Strict`, `Max-Age`, `Expires`를 가지며
운영에서는 `Secure`를 강제한다. 별도 비-HttpOnly CSRF cookie는 서버 전용 32바이트 이상
`AUTH_COOKIE_SECRET`으로 session 원문을 HMAC-SHA-256한 값이다. 로그아웃은 허용 Origin,
CSRF cookie/header 일치, HMAC을 모두 검사한다. 등록과 로그인은 허용 Origin 및
`application/json`을 강제한다. 모든 응답은 `no-store`이며 credential, SQL, hash parser
오류를 외부에 보내지 않는다.

다른 origin/port의 브라우저 UI는 cookie 값을 직접 읽는 데 의존하지 않는다. register,
login, me 성공 응답은 같은 HMAC CSRF 증명을 `csrfToken`으로 제공한다. 이것은 session
bearer가 아니며 UI 메모리에만 머물고 logout header에만 사용한다. 서버는 응답으로 값을
제공한 뒤에도 session HttpOnly cookie, CSRF cookie/header, HMAC과 Origin을 모두 검사한다.

## 3단계 프론트 인증 게이트

React renderer는 시작 시 `/api/auth/me`를 먼저 호출하며 상태를 session 확인 중,
unauthenticated, authenticated, API unavailable/retry로 구분한다. 정확한 401만 로그인
화면으로 처리하고 network/5xx/계약 오류는 별도 복구 상태로 유지한다. 로그인 또는 등록에
성공한 뒤에만 기존 `KodexClient`를 mount하여 Local Server bootstrap과 WebSocket을
시작한다. 로그아웃은 이 runtime tree를 먼저 unmount하고 WebSocket, reconnect timer,
pending RPC, bootstrap token과 React 상태를 제거한 뒤 CSRF 보호 logout을 완료한다.

UI process의 브라우저 공개 환경 allowlist는 `VITE_KODEX_API_URL`과
`VITE_PRODUCT_API_URL`뿐이다. 그 밖의 상속된 `VITE_*`는 제거한다. session bearer와 비밀번호는 React
장기 상태, Web Storage, IndexedDB, URL, 로그에 저장하지 않는다. development에서는 UI와
API가 `localhost`/`127.0.0.1`을 섞으면 명시적 설정 오류로 중단한다. 운영 기본 배치는
HTTPS same-origin reverse proxy이며, 별도 origin은 동일-site cookie와 credentialed CORS가
호환되는 경우만 허용한다.

authenticated 상태는 session 만료 시각을 기준으로 최대 5분마다 `/me`를 재검증하고,
document가 visible/focus 상태로 돌아올 때 throttle된 재검증을 수행한다. 성공 응답은 runtime
tree를 유지한 채 context와 CSRF proof를 갱신한다. 정확한 401은 runtime을 unmount하고
unauthenticated로 전환하며, network/5xx/계약 오류는 unavailable로 분리한다. 이미 만료되거나
폐기된 session의 logout 401은 정상적인 unauthenticated 결과로 수렴한다.

## 권한 경계와 남은 범위

인증 service가 반환하는 `AuthContext`는 사용자, session 만료, workspace membership을
포함한다. 이후 workspace API는 `requireWorkspaceRole`을 공통 guard로 사용해야 한다.
프론트 게이트는 Local Server 또는 WebSocket endpoint의 authorization 경계가 아니다.
Local Server의 제품 session/workspace 권한 강제와 사용자별 Codex worker 격리는 다음
단계에서 구현한다. event DB projection, RAG, 비밀번호 복구와 이메일 검증도 연결하지 않는다.
공식 Codex source와 생성 protocol도 변경하지 않는다.
