# ADR 0011: Electron renderer DOM full-stack acceptance

- 상태: 승인
- 날짜: 2026-09-02

## 배경

ADR 0010의 `test:full-stack`은 실제 Product API, Local Server, `codex.exe`, Responses tool loop와 PostgreSQL
projection을 한 경계에서 검증하지만 HTTP와 WebSocket client가 직접 계약을 호출한다. 따라서 React 폼,
Settings와 composer event, Saved DB History dialog 표시, 계정 메뉴 logout이 같은 제품 경계에 연결되었다는
증거는 아니며 UI E2E로 부를 수 없다. 반대로 Playwright 같은 별도 브라우저 runtime이나 test-only UI server를
추가하면 Electron 제품 bootstrap과 build 결과를 우회하게 된다.

## 결정

명시적 opt-in `npm run test:desktop-full-stack`을 추가한다. orchestration script는 기존
`startIsolatedPostgres` helper로 고유 이름·임의 loopback port의 `pgvector/pgvector:0.8.6-pg17` container를
만들고, ADR 0010과 같은 Responses loopback fixture를 process 안에서 재사용한다. 제품 build 후 저장소의
Electron runtime으로 `apps/desktop/main.mjs --full-stack-acceptance`를 실행한다. Desktop coordinator가 운영과
동일하게 Product API readiness, Local Server readiness 순서로 실제 build entrypoint를 시작하고 build된 UI를
로드한다. 별도 UI/test server는 없다.

acceptance flag일 때만 desktop main이 작은 `full-stack-acceptance-driver.mjs`를 동적 import한다. 정상 실행과
기본 smoke bundle에는 이 driver import나 실행이 없다. 창은 `show:false`이지만 실제 Chromium renderer,
layout/event loop와 cookie jar를 사용하며, 전용 Electron user-data와 tenant data root로 기존 사용자 세션을
격리한다. acceptance credential과 fixture 주소는 server child 환경에서 제거한다.

driver는 `webContents.executeJavaScript`로 다음 public DOM 동작만 수행한다.

1. 로그인 shell에서 회원가입 tab을 누르고 표시 이름, email, password label의 input을 채운 뒤 form submit
   button을 누른다.
2. 인증된 app shell, 사용자명과 현재 runtime workspace label을 확인한다.
3. Sidebar의 Settings와 Agent section을 열고 provider select를 Local로 바꾸며 loopback `/v1`,
   `kodex-loopback-model`, sandbox `danger-full-access`, approval `never`를 DOM change event로 저장한다.
4. 접근 가능한 `Message` composer를 채우고 send button을 눌러 실제 `codex.exe app-server` turn을 만든다.
   renderer conversation에 고정 assistant와 echo tool marker가 표시될 때까지 bounded polling한다.
5. Sidebar의 저장된 DB 히스토리 dialog를 열고 목록 refresh button을 bounded하게 누른 뒤 방금 thread를
   선택한다. 상세 DOM에 completed turn, assistant marker와 tool marker가 모두 표시되어야 통과한다.
6. dialog를 닫고 계정 메뉴 logout button을 누른 뒤 로그인 shell 복귀와 authenticated app shell 제거를
   확인한다.

내부 React 함수/state, Product/Local HTTP 직접 호출, DB 직접 조회를 통과 조건으로 사용하지 않는다. selector는
제품 접근성 label/role/text에 한정하며 test-only `data-testid`나 renderer backdoor를 추가하지 않는다.

## 결정적 provider와 안전 경계

외부 OpenAI key와 network를 사용하지 않는다. ADR 0010의 keyless Responses fixture는 첫 응답에 플랫폼별로
고정된 echo `exec_command`만 반환하고, 두 번째 요청의 function output에서 marker와 exit code 0을 확인한 뒤
고정 assistant message를 stream한다. orchestration process는 모든 fixture 요청에 Authorization header가
없음도 확인한다. `danger-full-access`/`never`는 UUID email, 임시 Product DB와 임시 tenant root를 쓰는 이
acceptance tenant에만 UI를 통해 저장하며, prompt나 repository 내용은 command로 조립하지 않는다.

## lifecycle과 진단

전체 build, Electron scenario, readiness, DOM 단계와 history projection에는 bounded timeout을 둔다. 성공, 실패,
SIGINT와 SIGTERM 모두 Electron process tree, Product API, Local Server, `codex.exe`, WebSocket, fixture HTTP
socket, PostgreSQL container와 runtime temp data를 정리한다. Windows child는 graceful IPC/SIGTERM 후 필요한
경우 hidden `taskkill /T /F`로 bounded 종료하여 EBUSY와 잔존 process를 줄인다. Docker Desktop 자체는 자동으로
시작하거나 종료하지 않으며 실행 전에 daemon이 준비되어 있어야 한다.

실패할 때만 임시 artifact 경로를 보존한다. `renderer-failure.png`와 `renderer-structure.json`을 남기되 구조
요약은 origin, allowlisted heading, element count와 control type/name/disabled 상태만 포함한다. input value,
cookie, CSRF/session token, environment secret, email, prompt, tool payload나 자유 본문은 JSON 및 console에
기록하지 않는다. 성공하면 Electron user-data를 포함한 임시 root를 제거한다.

## ADR 0010과 비검증 범위

`test:full-stack`은 browser 없이 A/B tenant isolation, HTTP status와 기존 WebSocket revocation을 더 깊게
검증한다. 이번 명령은 실제 Electron DOM 사용자 여정과 Product DB projection의 화면 표시를 검증하며 그
API/WS isolation suite를 대체하지 않는다. 기본 `npm test`와 `desktop:smoke`에 Docker/Electron 장기 실행을
추가하지 않는다.

live OpenAI generation/embedding, RAG ingestion/retrieval, Web Search, remote MCP, 임의 shell command,
운영 PostgreSQL, OS installer/package/code signing/auto-update는 이 acceptance의 검증 범위가 아니다. 기존
migration, vendor source와 generated protocol은 수정하지 않는다.
