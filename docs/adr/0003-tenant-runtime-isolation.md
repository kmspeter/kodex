# ADR 0003: Local Server tenant 권한과 사용자별 Codex runtime 격리

- 상태: 승인
- 날짜: 2026-08-31

## 결정

프론트 인증 gate는 보안 경계로 간주하지 않는다. Local Server는 safe readiness
`GET /api/health`, CORS preflight와 정적 로그인 UI 외의 `/api/*` 및 `/ws`에서 제품
session과 workspace membership을 직접 검증한다. 브라우저가 보낸 user ID 또는 role은
받지 않으며, 오직 DB 조회 결과의 user/workspace UUID와 role만 사용한다.

브라우저-safe `@kodex/product-contract`가 session cookie 이름,
`X-Kodex-Workspace-Id` header, WebSocket `workspace_id` query key, workspace role과 공개 auth
DTO를 소유한다. 이 package는 DB driver, Argon2, cookie HMAC secret 또는 서버 구현을
포함하지 않는다.

## HTTP와 WebSocket 인증 순서

HTTP는 loopback Host/Origin을 먼저 확인한다. mutation은 기존 local bootstrap session과
CSRF proof를 계속 요구한다. 이어 `kodex_product_session` cookie 원문을 SHA-256 digest로
변환해 `auth_sessions`를 조회하고, session 미폐기·미만료, active user, 요청 workspace의
membership을 검사한다. 이 모든 검사가 성공한 뒤에만 runtime lease를 얻는다.

WebSocket은 upgrade socket을 pause하고 같은 검증을 비동기로 끝낸 뒤 공식 `ws`
`handleUpgrade`를 호출한다. 제품 bearer는 cookie에만 있고 URL의 `workspace_id`는 비밀이
아닌 명시적 scope다. 연결은 upgrade 때 인증한 `(userId, workspaceId)` runtime에 고정된다.
session 만료 시각과 5분 중 빠른 시점에 DB를 다시 확인하고, session 폐기·만료 또는
membership 제거 시 policy violation code `1008`로 닫는다. DB/Node clock skew로 성공
재검증 직후 만료 시각이 과거로 보이는 경우 production 1초의 최소 지연을 적용해 0ms DB
loop를 막되, 아직 미래인 실제 만료 시각은 늦추지 않는다. timer, runtime subscription,
UI ownership과 lease는 모든 close/rejection/shutdown 경로에서 한 번만 정리한다.

오류와 security event에는 cookie, session 원문, DB URL, email/display name을 기록하지
않는다. security log는 거부 종류와 status만 기록한다.

## RuntimeManager와 저장 경계

`RuntimeManager` key는 서버가 인증한 `${userUuid}:${workspaceUuid}`다. source 기본 data root
예시는 다음과 같으며 UUID 이외 segment를 tenant 입력으로 사용하지 않는다. desktop의 외부
userData 경계와 child lifecycle은 ADR 0006에서 확장한다.

```text
.kodex-data/tenants/
  users/10000000-0000-4000-8000-000000000001/
    workspaces/20000000-0000-4000-8000-000000000001/
      codex-home/
      logs/
      settings.json
      projects.json
      automations.json
      approvals.jsonl
      instance.lock
```

각 entry는 별도 `KodexRuntime`, `LocalStore`, `ProjectStore`, scheduler와 공식 Codex App
Server process를 가진다. 동시 acquire는 하나의 initialization promise로 합친다. 기본 최대
runtime은 8, idle timeout은 15분, sweep은 1분이며 환경 설정으로 제한 범위 안에서 바꿀 수
있다. active HTTP/WS lease는 eviction을 막고, 최대치에서 모든 runtime이 leased이면 새
runtime 생성 대신 `503`을 반환한다. eviction과 shutdown은 App Server, scheduler,
pending approval/automation과 file lock을 정리한다.

동일 workspace의 서로 다른 사용자도 raw runtime과 `CODEX_HOME`을 공유하지 않는다.
runtime 실행은 `owner`, `admin`, `member` membership만 허용하며 `viewer`는 제품의 읽기
전용 role로 남는다. authorizer와 RuntimeManager가 모두 이 정책을 검사하고 UI도 실행 가능한
membership만 선택한다.
공식 Codex SQLite는 사용자별 실행 원본이며 제품 서버가 직접 읽거나 공유하지 않는다.
향후 협업 history는 App Server 공개 protocol event를 제품 PostgreSQL에 projection하여
workspace 단위로 공유한다.

## Broadcast와 ownership

Local HTTP router는 singleton runtime을 갖지 않는다. HTTP request마다 lease의 runtime을
사용하고, WebSocket은 자신의 runtime에만 subscribe한다. sequence buffer, replay epoch,
active UI ordering, server request owner와 approval registry는 `KodexRuntime` instance 내부에
남으므로 tenant 사이에 전달될 전역 broadcast registry가 없다.

## 실행과 남은 범위

제품 인증이 필수이므로 `npm run dev`와 `npm start`는 Product API, Local Server와 UI를
함께 시작한다. PostgreSQL은 명시적으로 compose에서 먼저 시작할 수 있다. 개발 origin은
UI `127.0.0.1:5173`, Local Server `127.0.0.1:47831`, Product API
`127.0.0.1:47832`이며 built UI는 `47831`을 사용한다.
Local Server의 built UI CSP는 검증된 exact HTTP(S) Product API origin 집합에서만
`connect-src`를 만들며 custom `PRODUCT_API_PORT` 또는 `KODEX_PRODUCT_API_ORIGINS`와 맞춘다.
ADR 0006에 따라 built UI의 runtime meta는 요청 Host와 동일 hostname인 Product API
origin이 정확히 하나일 때만 선택한다.

Electron/portable runtime의 Product API process, 외부 PostgreSQL dependency와 writable
tenant data base 통합은 ADR 0006에서 결정한다. 제품 DB thread/event projection, RAG,
비밀번호/이메일 복구와 shared raw runtime은 이 결정 범위에 포함하지 않는다.
`0001`/`0002` migration과 vendored Codex/protocol은 변경하지 않는다.
