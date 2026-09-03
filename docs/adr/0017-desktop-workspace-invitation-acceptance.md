# ADR 0017: Electron workspace invitation full-stack acceptance

- 상태: 승인
- 날짜: 2026-09-03

## 배경

ADR 0016은 hash-only invitation 수명주기와 React 단위 테스트, 실제 PostgreSQL integration을 제공한다. 기존
ADR 0010 full-stack acceptance도 두 사용자의 invitation 전후 Local HTTP/WebSocket 권한을 확인한다. 그러나
owner가 실제 Workspace 관리 dialog에서 one-time link를 만들고, Electron entrypoint가 fragment를 회수하며,
다른 사용자가 masked preview와 인증 UI를 거쳐 명시적으로 수락한 다음 invited runtime으로 전환되는 하나의 실제
renderer 여정은 검증하지 않는다. 보안 계약상 raw token이 DOM, 주소, browser persistence, request 또는 실패
artifact에 남지 않는지도 실제 Chromium 경계에서 별도로 확인해야 한다.

## 결정

명시적 opt-in `npm run test:desktop-workspace-invitation`을 추가한다. orchestration은 다른 desktop acceptance와
같이 고유 `pgvector/pgvector:0.8.6-pg17` container, 임의 loopback Product/Local port, 격리 Electron user-data와
tenant data root를 만들고 현재 제품을 build한다. 저장소 Electron runtime은
`apps/desktop/main.mjs --workspace-invitation-acceptance`로 운영과 같은 Product readiness → Local readiness 순서를
거쳐 build된 UI를 로드한다. Docker Desktop/daemon과 Model Runner 설정은 시작, 종료 또는 변경하지 않으며 UUID
이름의 테스트 container만 `finally`에서 정리한다.

acceptance flag에서만 동적 import되는 driver는 다음 순서로 public renderer DOM을 조작한다.

1. owner 회원가입 후 account menu의 **Workspace 관리**를 연다.
2. 실제 email input과 role select를 채워 **초대 링크 생성**을 누른다.
3. one-time readonly input만 raw link를 가지며 pending row는 target email/role/expiry만 가지는지 확인하고 input을
   닫는다.
4. owner logout 뒤 현재 navigation entry를 `/#invite=<token>`으로 바꾸고 renderer를 reload한다.
5. entrypoint가 fragment를 제거한 주소에서 masked preview를 확인하고 실제 가입 form을 제출한다.
6. 명시적 accept 직전 invited workspace Local bootstrap이 `403`인지 확인한 뒤 **초대 수락**을 누른다.
7. accept 뒤 `/api/auth/me`가 다시 요청되고 invited member workspace가 account label에 선택되는지 확인한다.
8. UI WebSocket의 `connected`, target workspace bootstrap `200`과 별도 WebSocket `hello`를 확인한다.
9. 같은 fragment로 다시 reload해 used token preview `410`의 generic terminal 화면을 확인하고 **계속** 뒤 Product
   `/me`와 Local health 같은 token-free 후속 요청이 성공하는지 확인한다.

React component 함수/state, test-only renderer hook 또는 별도 browser server는 사용하지 않는다. 수락 전후 Local
authorization status처럼 화면에 표시되지 않는 경계만 sandboxed renderer의 실제 `fetch`/`WebSocket`으로
probe한다.

## raw token과 artifact 경계

raw token은 Product create response를 받은 renderer의 one-time input과 acceptance harness process memory에만
존재한다. 환경 변수, PostgreSQL query parameter, console output, screenshot filename 또는 JSON artifact에 쓰지
않는다. Electron request observer는 body bytes를 저장하지 않고 token 포함 여부와 allowlisted route/method/status만
메모리에서 계수한다. 허용되는 노출은 정확히 두 번의 main-frame `#invite=` entry와
`POST /api/invitations/preview`, 한 번의 `POST /api/invitations/accept`, reused terminal의 두 번째 preview JSON
body뿐이다. CORS `OPTIONS 204`는 POST 결과와 분리한다. query/path/다른 body에서 token을 보면 실패한다.

각 fragment 회수, accept와 terminal 단계에서 현재 URL과 Electron navigation history, DOM text/attribute/control
value, local/session storage, Cache Storage request URL, IndexedDB database name, performance resource URL과 HttpOnly를
포함한 cookie name/value를 검사한다. browser 내부 cache의 모든 byte 수준 forensic 삭제를 증명하는 테스트는
아니지만 제품이 사용하는 browser persistence와 요청 surface에는 token이 남지 않아야 한다.

실패 artifact는 screenshot을 찍기 전에 모든 renderer text를 투명화하며, redaction 주입을 확인하지 못하면 screenshot을
생성하지 않는 fail-closed 정책을 사용한다. 구조 JSON에는 loopback origin,
fragment 존재 boolean, allowlist heading, element count, control tag/name/type/disabled만 포함하며 input value,
email, password, cookie, token, request body와 자유 본문은 기록하지 않는다. diagnostic도 token, credential, email,
DB URL을 치환한 뒤 bounded message만 출력한다.

## PostgreSQL과 lifecycle 교차 검증

driver는 test DB에서 renderer가 생성한 invitation을 target/owner email로 찾고 schema의 token 계열 column이
`token_hash` 하나뿐인지 확인한다. harness memory의 raw token으로 domain-separated SHA-256 expected value를
계산해 저장 hash와 비교하지만 raw token 자체를 SQL parameter로 보내지 않는다. 수락 뒤 accepted user와 member
role, pending 제거, `workspace.invitation_created`/`workspace.invitation_accepted` audit를 확인하며 audit JSON에 raw
token, hash와 target email이 없어야 한다.

build, DOM, navigation, HTTP, WebSocket과 process shutdown은 모두 bounded다. 성공, 실패, SIGINT, SIGTERM에
Electron/Product API/Local Server/App Server process tree, DB container와 임시 user/tenant data를 정리한다.
기존 migration 0001~0007, vendored Codex와 generated protocol은 변경하지 않는다.

## 비검증 범위

이 acceptance는 SMTP/email delivery, distributed rate limit/WAF, CAPTCHA, reminder/resend, expired retention job,
live OpenAI generation/embedding, remote MCP/Web Search, installer/signing과 운영 DB 성능을 검증하지 않는다. revoked,
expired, email mismatch와 동시 수락의 상세 API/transaction matrix는 기존
`test:workspace-invitations-postgres`가 담당하며 이 renderer 경로는 현실적인 used-token terminal 실패 하나를
끝까지 검증한다.
