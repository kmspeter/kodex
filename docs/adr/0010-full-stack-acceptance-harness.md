# ADR 0010: 실제 프로세스 기반 full-stack acceptance harness

- 상태: 승인
- 날짜: 2026-09-02

## 배경

인증, tenant runtime, 공식 Codex App Server, history outbox와 PostgreSQL read API는 각각 독립 테스트가
있지만, 한 사용자 여정에서 이 경계가 모두 같은 user/workspace/session을 유지한다는 결정적 증거는 없었다.
외부 OpenAI 계정과 API key를 요구하면 반복 가능성과 CI 격리가 깨지고, 브라우저를 실행하지 않는 테스트를
UI E2E라고 부르면 실제 보장 범위도 흐려진다.

## 결정

`npm run test:full-stack`을 명시적 opt-in acceptance 명령으로 둔다. 명령은
`pgvector/pgvector:0.8.6-pg17` 이미지를 고유 container 이름과 임의 loopback port로 실행하고 제품을 build한
뒤, build된 Product API와 Local Server entrypoint를 별도 Node process로 시작한다. Local Server는 저장소의
실제 `bin/codex.exe`를 공식 `app-server --listen stdio://` 방식으로 실행한다. 테스트가 시작한 container,
process, App Server child, WebSocket, HTTP fixture socket과 임시 tenant directory는 성공·실패 모두 bounded
cleanup한다. 스크립트는 Docker Desktop을 자동 시작하거나 종료하지 않으므로 실행 전 daemon 상태를 그대로
보존한다.

외부 생성 provider 대신 기존 local-provider integration과 공유하는 keyless Responses SSE loopback fixture를
사용한다. 이 fixture만 테스트 process 안에 있다. tenant provider 설정은 파일을 미리 쓰지 않고, Product
session/workspace로 인증한 Local Server `/api/bootstrap`과 CSRF-protected `/api/settings`를 순서대로 호출해
`{ mode: 'local', baseUrl: '<loopback>/v1', model: 'kodex-loopback-model' }`로 바꾼다. fixture는 첫 응답에서
`exec_command` function call을, 두 번째 요청에서 실제 function output을 확인한 뒤 최종 assistant message를
반환한다. 요청 Authorization header가 없다는 사실도 검증하되 cookie, CSRF, bearer 또는 tool output을
console에 기록하지 않는다.

Windows의 App Server가 command lifecycle을 실제로 만들기 전에 read-only sandbox 준비에서 거부되는 환경
차이를 피하기 위해, 이 고정 fixture turn만 Local 설정 API로 `approvalPolicy: 'never'`,
`sandbox: 'danger-full-access'`, shell/Web Search network false를 선택한다. 실행 command는 fixture에 고정된
`cmd.exe /d /c echo kodex-loopback-tool`(비 Windows는 동등한 `printf`)이며 사용자 입력, repository 내용이나
외부 network를 명령으로 전달하지 않는다. 두 번째 Responses 요청에서 exit code 0과 marker output을 모두
확인해야 tool round trip으로 인정한다.

## 검증 경계

| 경계 | acceptance harness가 사용하는 실제 계약 | 확인 항목 |
| --- | --- | --- |
| 프론트 인증 계약 | Product API `register`, `logout`, `login`, `me` HTTP + cookie/CSRF | default runnable workspace, session 폐기와 재로그인 |
| Product API | build된 `apps/api/dist/main.js` process | 인증 상태 코드, Saved DB History list/detail, user/workspace scope |
| Local Server | build된 `apps/local-server/dist/main.js` HTTP/WS process | product session bootstrap, local CSRF 설정, replay와 RPC, periodic session revalidation |
| 공식 agent process | 저장소 `bin/codex.exe app-server` stdio JSONL | `thread/start`, `turn/start`, tool call/output round trip, 공식 `turn/completed` |
| PostgreSQL projection | 실제 migration과 `PostgresHistoryRepository`/Product history API | thread, completed turn, assistant item, completed shell result의 bounded polling |
| tenant isolation | 사용자 A/B의 별도 cookie와 workspace | B의 A detail `404`, non-member workspace `403`, 별도 tenant data root, cross-scope WS 거부 |
| session revocation | A의 실제 logout 후 Product API와 Local Server 재검증 | Product API `401`, 새 bootstrap/WS `401`, 기존 WS code `1008` 종료 |

흐름은 다음과 같다.

```text
Product register/logout/login
  -> authenticated Local bootstrap/settings
  -> Local WebSocket replay + thread/start + turn/start
  -> real codex.exe -> keyless loopback Responses -> real shell tool -> final message
  -> Local history recorder/outbox -> PostgreSQL -> Product Saved DB History
  -> user B isolation checks -> user A logout -> HTTP 401 + WS revocation
```

각 readiness, RPC, turn completion, projection, revocation과 전체 process에는 독립적인 timeout과 단계 이름을
둔다. port 예약은 최종 bind 전 작은 race가 있을 수 있으므로 bind 실패는 해당 process readiness 단계에서
명확히 실패하며, 재실행은 새 port/container/directory를 사용한다.

## RAG와 비검증 범위

이 시나리오는 `KODEX_RAG_ENABLED=false`와 `KODEX_RAG_AUTOMATIONS_ENABLED=false`를 강제한다. Embeddings
endpoint는 공식 OpenAI 경계 그대로 유지하며 테스트용 비공식 base URL을 추가하지 않는다. 실제 pgvector
extension, embedding/retrieval, HNSW/exact fallback은 독립 opt-in `npm run test:rag-postgres`와 live embedding
smoke의 책임이다. acceptance container가 pgvector 이미지를 쓰는 이유는 제품 migration과 기존 운영 조합을
그대로 실행하기 위한 것이며 RAG 동작을 검증한다는 뜻이 아니다.

실제 브라우저, React click/render, Electron renderer는 실행하지 않는다. 따라서 이 테스트는 브라우저 UI
E2E가 아니라 프론트가 의존하는 인증/부트스트랩 HTTP 계약부터 실제 서버/agent/DB까지의 API/WS acceptance
test다. live OpenAI generation, live embedding, Web Search, remote MCP와 외부 network도 검증하지 않는다.

## 실행 전제와 결과

로컬과 opt-in CI job에는 Node/npm dependencies, 실행 중인 Docker daemon과 저장소에서 검증된
`bin/codex.exe`가 필요하다. Docker image를 처음 받는 실행은 registry 접근도 필요하다. 기본 `npm test`에는
이 파일을 포함하지 않아 Docker/build/process 비용을 추가하지 않는다. `KODEX_AUTH_REVALIDATE_MS`는 운영 기본
5분을 유지하되 이 acceptance process만 100ms로 낮춰 logout 후 기존 socket 폐기를 bounded하게 관찰한다.
기존 migration, vendor source와 generated protocol은 변경하지 않는다.
