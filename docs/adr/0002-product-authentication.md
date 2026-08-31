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

## 권한 경계와 남은 범위

인증 service가 반환하는 `AuthContext`는 사용자, session 만료, workspace membership을
포함한다. 이후 workspace API는 `requireWorkspaceRole`을 공통 guard로 사용해야 한다.
이번 결정은 로그인 UI, Codex worker tenant 격리, event ingestion, RAG를 연결하지 않는다.
공식 Codex source와 생성 protocol도 변경하지 않는다.
