# Kodex

Kodex는 공식 오픈소스 [OpenAI Codex](https://github.com/openai/codex)의 App Server를 로컬에서 실행하는 Windows 앱입니다. UI, Local Server, 공식 Codex 전체 소스, 실행 파일, thread와 설정은 사용자의 컴퓨터에 있습니다. PostgreSQL 제품 session과 workspace membership은 필수이며, 인증되기 전에는 UI뿐 아니라 Local Server 자체가 HTTP/WebSocket/Codex runtime 접근을 거부합니다.

Kodex는 네트워크 차단기가 아닙니다. 모델 호출, Web Search, 원격 MCP, Git 네트워크 작업과 패키지 설치는 공식 Codex의 sandbox·approval과 사용자 설정에 따라 사용할 수 있습니다. Local Server는 생성 모델을 직접 호출하거나 tool을 선택하지 않으며, 공식 Codex App Server의 stdio JSONL을 localhost HTTP/WebSocket UI에 연결합니다. 예외적으로 private RAG를 명시적으로 켜면 등록 문서 chunk, Knowledge 검색 미리보기 질의, 일반 turn의 첫 text 질의 embedding을 공식 Embeddings API에 직접 요청합니다. 자동화 prompt는 별도 opt-in일 때만 포함됩니다.

## 구조

```text
apps/ui                 React/Vite renderer와 제품 인증 게이트
apps/local-server       localhost API, 정적 UI, scheduler, Codex 수명 관리
apps/api                독립 제품 인증·사용자별 history HTTP API
apps/desktop            Electron 창과 Local Server 수명 관리
packages/codex-protocol 공식 바이너리에서 생성한 protocol/schema
packages/kodex-api      UI ↔ Local Server 계약
packages/product-contract 브라우저-safe auth/workspace 공개 계약
packages/shared         JSONL, sequence, 마스킹 유틸리티
packages/product-db     PostgreSQL pool, migration, auth/history와 private pgvector RAG
infra/compose.yaml      개발용 PostgreSQL 17 + pgvector, 선택적 제품 API profile
vendor/openai-codex     고정된 공식 전체 소스
bin/codex.exe           위 소스에서 빌드한 공식 App Server 바이너리
```

기존 desktop production HTTP API, WebSocket과 정적 UI는 계속 `127.0.0.1`의 같은 origin에서 제공됩니다. 개발 모드에서만 Vite dev server가 별도로 실행됩니다. 제품 인증 API는 별도 process와 포트이며 기존 Local Server의 bootstrap/session secret이나 Codex runtime을 공유하지 않습니다.

## 공식 Codex 소스 고정과 무결성

- upstream commit: `f1433fc71f2062ae3c007a03d7ff549bc582d386`
- source: `vendor/openai-codex/`
- SHA-256 manifest: `VENDOR_SOURCE_SHA256.json`
- build metadata: `bin/codex-build.json`
- protocol metadata: `packages/codex-protocol/codex-version.json`

`npm run codex:verify-source`는 manifest의 commit이 `CODEX_UPSTREAM_COMMIT`과 일치하는지 확인한 뒤 vendored source의 모든 파일을 SHA-256으로 검증합니다. 파일이 추가·삭제·변경되면 명확한 목록과 함께 실패합니다. `.git`이 없어도 검사가 생략되지 않으며 `codex:build`도 Cargo를 실행하기 전에 이 검증을 반드시 거칩니다.

현재 바이너리가 보고하는 내부 문자열 `codex-cli 0.0.0`은 정식 릴리스 버전으로 표시하지 않습니다. UI와 metadata에는 `Codex source build f1433fc71f20`으로 표시됩니다. 다른 release/tag로 바꾸려면 source·protocol 차이를 검토하고 manifest, binary, generated protocol을 함께 갱신해야 합니다.

공식 Rust 소스를 실제로 바꾸거나 바이너리/프로토콜 불일치가 확인된 경우에만 다음을 실행합니다.

```powershell
npm run codex:build
npm run codex:generate-protocol
```

## 실행

Node.js 22.13 이상에서 의존성을 준비합니다.

```powershell
npm install
```

### OpenAI 모드

루트 `.env.local` 또는 Local Server 환경에 키만 설정합니다.

```dotenv
OPENAI_API_KEY=your_openai_api_key_here
```

```powershell
npm run dev
# 또는 production
npm run build
npm start
```

OpenAI 모드가 기본값입니다. Vite/renderer 환경에서는 `OPENAI_API_KEY`와 로컬 provider key를 제거하며, bootstrap·WebSocket·번들·브라우저 저장소·Kodex 로그에도 키를 보내지 않습니다. OpenAI key는 Local Server만 읽고 이 provider를 선택했을 때만 공식 App Server에 전달합니다.

### OpenAI Responses 호환 로컬 모델

설정 창에서 provider를 `Local OpenAI-compatible`로 바꾸고 다음을 입력합니다.

- Base URL: `http://127.0.0.1:<port>/v1` 또는 `http://localhost:<port>/v1`
- Model: 로컬 서버가 노출하는 model 이름
- 선택적 인증: Local Server 환경의 `KODEX_LOCAL_LLM_API_KEY`

이 모드는 `OPENAI_API_KEY` 없이 시작합니다. 공식 Codex의 `model_providers`, `base_url`, `wire_api="responses"`, `requires_openai_auth=false` 설정을 사용하며 자체 추론 adapter는 두지 않습니다. 현재 고정 소스는 Responses wire API만 지원합니다. 로컬 서버가 Responses streaming, Codex tool call 왕복을 충분히 구현하지 않으면 호환성 오류가 표시됩니다. 로컬 모델 선택은 Web Search/원격 MCP 선택과 별개입니다.

## 로컬 데이터와 안정성

`.kodex-data/tenants/users/<user-uuid>/workspaces/<workspace-uuid>/`마다 공식 `CODEX_HOME`, projects/settings/automations JSON, 마스킹된 approval/log, `instance.lock`과 `product-history-outbox/`가 따로 저장됩니다. UUID는 브라우저 입력이 아니라 DB가 인증한 scope에서만 가져오며 path segment 형식을 재검사합니다. 같은 workspace의 사용자도 raw Codex runtime과 `CODEX_HOME`을 공유하지 않습니다. 제품 history는 공식 App Server 공개 notification/server-request stream에서 PostgreSQL로 투영하며 upstream Codex SQLite를 직접 읽거나 polling하지 않습니다.

## 제품 PostgreSQL, tenant runtime, 내구성 history와 private RAG (6단계, 필수)

`packages/product-db`는 제품 데이터의 pool, migration, SQL repository와 인증/RAG service를 소유합니다. `apps/api`가 등록·로그인과 인증된 history/knowledge API를 담당하고, Local Server도 같은 hash-only session repository를 통해 매 요청의 active user, session 만료/폐기, workspace membership을 독립적으로 확인합니다. 자세한 결정은 `docs/adr/0001-product-database-boundary.md`, `docs/adr/0002-product-authentication.md`, `docs/adr/0003-tenant-runtime-isolation.md`, `docs/adr/0004-app-server-history-projection.md`, `docs/adr/0005-private-pgvector-rag.md`에 있습니다.

`0001_initial_product_schema.sql`, `0002_password_credentials.sql`, `0003_agent_history_projection.sql`은 변경하지 않습니다. 새 `0004_user_scoped_rag.sql`은 knowledge/retrieval 계층 전체에 사용자 composite FK와 검색 index를 추가합니다. 등록 transaction은 사용자, credential, `Personal Workspace`, owner membership과 첫 session을 원자적으로 만듭니다. RAG 설계와 경합 모델은 `docs/adr/0005-private-pgvector-rag.md`에 있습니다.

로컬 DB와 API를 실행할 때 실제 암호를 커밋하지 말고 `.env.example`을 ignored `.env.local`로 복사해 모든 placeholder를 바꿉니다. `AUTH_COOKIE_SECRET`은 다음처럼 32바이트 이상 base64url 값으로 생성합니다.

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
docker compose --env-file .env.local -f infra/compose.yaml up -d postgres
$env:DATABASE_URL = 'postgresql://kodex:<local-password>@127.0.0.1:5432/kodex'
$env:PRODUCT_DB_SSL = 'disable'
npm run db:migrate
# Product API(47832), Local Server(47831), Vite UI(5173)를 함께 시작
npm run dev
```

Docker 안에서 API까지 실행하려면 명시적 profile을 사용합니다. 기본 `docker compose up`은 기존처럼 PostgreSQL만 시작합니다.

```powershell
docker compose --env-file .env.local -f infra/compose.yaml --profile product-api up --build
```

API 계약은 다음과 같습니다. 모든 응답은 `Cache-Control: no-store`이고, 상태 변경 요청은 정확히 허용한 `Origin`을 요구합니다.

- `POST /api/auth/register`: `{ "email", "password", "displayName"? }`, 성공 `201`. 비밀번호는 UTF-8 12~1,024 bytes입니다.
- `POST /api/auth/login`: `{ "email", "password" }`, 성공 `200`. 존재하지 않는 이메일과 잘못된 비밀번호는 같은 `401 invalid_credentials`입니다.
- `GET /api/auth/me`: session cookie로 사용자, session 만료, workspace membership을 조회합니다.
- `POST /api/auth/logout`: session/CSRF cookie와 `X-CSRF-Token` header가 필요하고 성공 시 DB session을 폐기한 뒤 `204`를 반환합니다.
- `GET /api/history/threads?workspace_id=<uuid>&limit=<n>&cursor=<opaque>`: header의 `X-Kodex-Workspace-Id`와 URL scope가 정확히 같아야 하며 현재 로그인 사용자가 만든 thread만 반환합니다.
- `GET /api/history/threads/<codex-thread-id>?workspace_id=<uuid>&limit=<n>&cursor=<opaque>`: 같은 소유자 검사를 서버에서 강제하고 turn/item/tool call/approval page를 반환합니다. 다른 사용자 thread ID는 `404`입니다.
- `POST /api/knowledge/documents?workspace_id=<uuid>`: `{ "documentId"?, "sourceId"?, "title", "content" }` text를 사용자 private source에 생성/갱신하고 chunk/embedding을 원자 교체합니다.
- `GET /api/knowledge/documents?workspace_id=<uuid>&limit=<n>&cursor=<opaque>`: 현재 사용자의 문서 metadata만 반환합니다. content checksum과 raw vector는 반환하지 않습니다.
- `DELETE /api/knowledge/documents/<uuid>?workspace_id=<uuid>`: 현재 사용자 소유 문서만 삭제하며 추측한 다른 사용자 ID는 `404`입니다.
- `POST /api/knowledge/query?workspace_id=<uuid>`: `{ "query", "topK"?, "threshold"? }`로 cosine 검색 preview와 document/chunk citation, score를 반환합니다. raw query/document embedding은 반환하지 않습니다.

Knowledge mutation과 POST query는 auth와 별도로 정확한 Origin, session/CSRF cookie, `X-CSRF-Token`, URL/header workspace 일치를 모두 요구합니다. read도 매 요청 session과 membership을 다시 확인합니다. 동일 workspace owner/admin도 다른 사용자의 knowledge에는 접근하지 못합니다.

### Knowledge/RAG 개인정보 및 실행 정책

RAG는 기본 비활성입니다. `KODEX_RAG_ENABLED=true`와 서버 전용 `OPENAI_API_KEY`를 함께 설정해야 활성화됩니다. 활성화하면 (1) 등록 문서를 나눈 chunk, (2) Knowledge 화면에서 사용자가 명시적으로 실행한 검색 미리보기 질의, (3) 일반 agent `turn/start` 입력의 첫 text 질의가 OpenAI Embeddings API로 전송됩니다. `KODEX_RAG_AUTOMATIONS_ENABLED=true`도 설정한 경우에만 자동화 prompt의 첫 text 질의가 추가로 전송됩니다.

repository/source tree, clipboard, 전체 Codex thread/history는 자동 scan하거나 전송하지 않습니다. 개인정보·소스·사내 문서를 넣거나 질의하기 전에 조직의 외부 전송 정책을 확인하세요. Codex 생성 provider를 UI에서 Local로 바꿔도 RAG provider는 현재 OpenAI Embeddings API이므로, local model만 쓴다고 생각한 상태에서 `KODEX_RAG_ENABLED`를 켜지 않도록 주의해야 합니다. `OPENAI_API_KEY`와 Authorization header는 Product API/Local Server 메모리에만 있고 browser, DB, 로그, API JSON에 포함되지 않습니다.

활성화 시 기본 설정은 `text-embedding-3-small`, 1,536 dimensions, Unicode 1,600자 chunk/200자 overlap, cosine top-5, threshold 0.25, context 6,000자, 문서 60,000 code points입니다. Product API 본문 한도 기본값은 262,144 bytes로 4-byte Unicode 문서와 JSON 여유 공간을 수용합니다. `KODEX_RAG_DOCUMENT_MAX_CHARACTERS`를 늘리면 `PRODUCT_API_MAX_BODY_BYTES`도 늘려야 하며, 안전하지 않은 조합은 시작 시 설정 오류가 됩니다(본문 hard maximum 1,048,576 bytes). `.env.example`의 `OPENAI_EMBEDDING_*`, `KODEX_RAG_*`로 제한 안에서 조정합니다. 429·일시 5xx·네트워크 오류·timeout만 제한된 횟수로 재시도하고, 영구 provider 거부와 malformed 응답은 재시도하지 않습니다. 어떤 embedding/DB 오류도 agent turn 자체를 막지 않습니다.

일반 `turn/start`는 첫 text query를 검색합니다. 결과는 document/chunk ID가 있는 bounded JSON block으로 원래 user input 뒤에 추가되며, block 자체가 untrusted reference이고 지시가 아니라는 경계를 포함합니다. 문서 속 prompt injection은 system/developer 권한으로 승격되지 않습니다. 결과 없음/실패는 원래 turn을 그대로 실행합니다. `turn/steer`에는 적용하지 않고 automation도 기본 미적용이며 `KODEX_RAG_AUTOMATIONS_ENABLED=true`에서만 사용합니다.

현재 dimensionless vector schema는 model+dimension을 행별 지원하는 대신 하나의 안전한 고정-dimension HNSW/IVFFlat index를 두지 못합니다. 사용자/model/dimension B-tree prefilter 뒤 exact cosine sequential scan이므로 대규모 corpus는 느려질 수 있습니다. typed partition/ANN index, retention/expiry, workspace 공유 지식과 immutable citation 보존은 후속 작업입니다.

register/login/me 성공 JSON에는 사용자·workspace·session 만료와 `csrfToken`이 포함됩니다. 이 값은 session bearer가 아니라 `kodex_product_csrf` cookie와 같은 HMAC double-submit 증명이며 프론트 메모리에만 유지됩니다. logout 때도 서버는 허용 Origin, session HttpOnly cookie, CSRF cookie/header, HMAC을 모두 검증합니다.

session token은 32 random bytes이며 브라우저의 `kodex_product_session` HttpOnly cookie에만 전달됩니다. DB에는 SHA-256 hash만 저장합니다. UI는 모든 auth fetch에 `credentials: include`와 `no-store`를 사용하고 session 원문·비밀번호·CSRF token을 Web Storage, IndexedDB, URL 또는 로그에 기록하지 않습니다. 비밀번호 input은 요청을 시작한 직후 지웁니다. cookie는 `Path=/`, `SameSite=Strict`, `Max-Age`, `Expires`를 가지며 `NODE_ENV=production`에서는 HTTPS Origin과 `Secure`를 강제합니다. UI process의 공개 환경 allowlist는 `VITE_KODEX_API_URL`과 `VITE_PRODUCT_API_URL`뿐이며 그 밖의 상속된 `VITE_*`도 제거합니다. `DATABASE_URL`, `AUTH_COOKIE_SECRET`, 허용 Origin, OpenAI/provider key는 서버 환경에만 두며 `VITE_` 접두사를 붙이지 않습니다.

앱 시작 상태는 `session 확인 중 → 로그인 필요 | 인증됨 | API 확인 불가/재시도`로 나뉩니다. runtime 실행 역할은 `owner`, `admin`, `member`이며 `viewer`는 읽기 전용 제품 membership이므로 Local Server HTTP/WS에서 `403 workspace_forbidden`입니다. 실행 가능한 membership이 없으면 명확한 권한 화면을 표시하고 `KodexClient`나 runtime을 만들지 않습니다. 선택은 실행 가능한 default membership 또는 첫 membership으로 고정하며 workspace 전환 API는 제공하지 않습니다. UI는 모든 Local Server HTTP 요청에 `X-Kodex-Workspace-Id`, WebSocket URL에는 비밀이 아닌 `workspace_id`를 보냅니다. session bearer는 계속 HttpOnly cookie에만 있습니다.

Local Server 요청 순서는 다음과 같습니다.

1. loopback `Host`와 allowlisted `Origin`을 확인합니다.
2. mutation에는 기존 `kodex_session`/`X-Kodex-CSRF`, bootstrap에는 기존 bootstrap proof를 확인합니다.
3. `kodex_product_session` 원문을 로그에 남기지 않고 SHA-256 hash로 DB session을 조회합니다.
4. active user, 미만료·미폐기 session, 정확한 workspace membership을 확인한 뒤에만 `(user UUID, workspace UUID)` runtime lease를 얻습니다.

WebSocket upgrade도 같은 순서를 사용합니다. 연결 후에는 session 만료 시각과 5분 중 빠른 시점마다 DB를 재검증하며 session 폐기 또는 membership 제거 시 code `1008`로 닫습니다. DB와 Node clock skew로 성공 재검증 후 만료 시각이 이미 지난 것으로 보이면 production 1초(테스트용 더 작은 interval은 그 값)의 최소 지연을 두어 DB tight loop를 막습니다. connection의 runtime, sequence/replay, server-request owner와 approval은 연결 시 고정되어 다른 tenant socket으로 broadcast되지 않습니다.

### 개발 hostname과 운영 cookie 배치

개발 기본 조합은 UI `http://127.0.0.1:5173`, Local Server `http://127.0.0.1:47831`, 제품 API `http://127.0.0.1:47832`입니다. built UI는 `47831`, 제품 API는 `47832`를 사용합니다. `npm run dev`와 `npm start`가 세 process의 정확한 allowlist를 함께 설정합니다. `PRODUCT_API_PORT`를 바꾸면 Local Server는 해당 포트의 `127.0.0.1`/`localhost` origin을 CSP `connect-src`에 사용하며, 명시적 배치는 `KODEX_PRODUCT_API_ORIGINS`에 comma-separated exact HTTP(S) origin만 허용합니다. path, credential, 중복 또는 CSP directive 형태 문자열은 시작 시 거부됩니다. built UI의 `VITE_PRODUCT_API_URL`도 같은 origin으로 build해야 합니다. 포트는 달라도 hostname은 정확히 같아야 하며 `localhost`와 `127.0.0.1`을 섞지 않습니다.

운영은 HTTPS same-origin reverse proxy가 UI와 `/api/auth/*`를 함께 제공하는 구성이 기본입니다. 제품 API를 별도 origin으로 둘 때는 동일-site HTTPS hostname, credentialed CORS allowlist, `Secure`/`SameSite=Strict` cookie가 모두 호환되어야 합니다. cross-site 배치는 현재 cookie 정책과 호환되지 않습니다. production Vite build에서 `VITE_PRODUCT_API_URL`을 생략하면 UI origin을 사용합니다.

`RuntimeManager`의 기본 정책은 최대 active runtime 8개, idle timeout 15분, sweep 1분입니다. `KODEX_MAX_ACTIVE_RUNTIMES`, `KODEX_RUNTIME_IDLE_MS`, `KODEX_RUNTIME_SWEEP_MS`로 조정합니다. 동시 생성은 하나로 합치고 active WebSocket/HTTP lease가 있는 runtime은 eviction하지 않습니다. 최대치에서 모든 runtime이 leased 상태면 `503`을 반환합니다. tenant runtime마다 UI WebSocket 수와 무관한 history subscriber를 정확히 하나 설치한 뒤 App Server를 시작하며, 종료·eviction은 subscriber, retry timer, scheduler, pending approval/automation, App Server process와 data lock을 정리합니다.

History subscriber는 thread/turn/item lifecycle과 tool/approval을 정규화하고 재귀 credential redaction 및 기본 64 KiB event 한계를 적용한 뒤 tenant root의 outbox에 먼저 원자적으로 기록합니다. DB transaction은 project/thread/turn/item/tool/approval 상태와 deduplicated `agent_events`를 함께 반영합니다. 전달 모델은 ordered at-least-once이고 `(source_instance, source_event_id)`와 monotonic lifecycle merge로 재시도·재시작·out-of-order를 흡수합니다. DB 장애는 agent 실행을 막지 않으며 250 ms부터 최대 30초까지 retry합니다. 기본 outbox는 tenant당 16 MiB/10,000 records로 제한되고 초과·손상·DB 불가는 credential 없는 명시적 history state log로 남습니다.

## 연결 복구, 승인, 자동화, 재시작

- WebSocket event는 process epoch와 sequence를 가집니다. `hello`는 cursor를 전진시키지 않으며 reconnect replay는 중복 제거 후 reducer에 한 번만 적용됩니다.
- buffer gap 또는 Local Server epoch 변경 시 streaming 임시 상태를 지우고 `thread/list`, active `thread/read`/`thread/resume`으로 재동기화합니다.
- approval/user-input은 가장 최근 활동한 UI 하나에만 할당됩니다. request registry가 중복 응답, timeout, owner disconnect와 App Server restart를 처리하고 다른 UI는 읽기 전용으로 표시합니다.
- scheduler는 명시적 project/cwd를 사용하며 UI active project를 바꾸지 않습니다. automation claim과 다음 실행 시각을 한 저장 작업으로 기록하고 automation별 in-flight lock으로 장기 실행 중복을 막습니다. 재시작 때 실행 중이던 작업은 `interrupted`로 보존하고 overdue 작업은 한 번만 다시 claim합니다.
- App Server는 전체 restart 횟수와 연속 실패를 분리합니다. 안정 실행 시간이 지난 뒤에만 연속 실패를 초기화하며 exponential backoff와 최대 횟수 이후 `failed`를 유지합니다. UI에서 수동 재시작할 수 있습니다.

지원하는 핵심 event는 agent/reasoning/plan delta, command/process 출력과 종료, file change/patch/turn diff, token usage, thread status, warning/error, approval/user input입니다. 알 수 없는 notification은 비밀값을 마스킹한 method/metadata만 진단 로그에 남깁니다. 별도 host dynamic tool registry가 없으므로 `item/tool/call`을 지원한다고 표시하지 않습니다.

## 설정

UI 설정은 실제 Codex 요청/설정에 연결된 항목만 노출합니다: provider/model, sandbox, approval, shell network, Web Search, sidebar/detail panel. Web Search 변경은 active thread를 다음 turn 전에 resume하여 반영합니다. Remote MCP는 가짜 boolean이 아니라 공식 config write/reload 경로로 추가합니다.

## Windows desktop와 runtime bundle

Electron은 기존 Node Local Server를 그대로 관리하면서 Windows 창과 수명 관리를 얇게 제공하기 때문에 사용합니다. renderer Node integration은 꺼져 있고 context isolation과 sandbox를 켭니다. privileged renderer에서 원격 페이지를 열지 않고 외부 링크는 OS 브라우저로 보냅니다. preload에는 파일/폴더 선택만 노출하며 API key를 전달하지 않습니다.

현재 source의 `npm run dev`/`npm start` 경로는 Product API, Local Server와 UI를 함께 관리합니다. 기존 Electron/portable runtime launcher는 Product API process와 PostgreSQL lifecycle을 아직 함께 관리하지 않으며, 기존 `KODEX_DATA_ROOT`가 repository 밖을 가리키는 배치도 새 tenant-root 제약과 호환되지 않습니다. 따라서 이 단계에서는 `runtime:bundle` 결과를 tenant 인증이 통합된 배포물로 간주하지 않습니다. desktop 통합은 별도 후속 작업입니다.

## 검증

```powershell
npm run codex:verify-source
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:ui-bundle
npm run smoke:production
npm run runtime:bundle
npm run runtime:smoke
npm run test:local-provider
npm run test:handshake
# DATABASE_URL을 명시한 opt-in 제품 DB 검증
npm run test:product-db
# DATABASE_URL을 명시한 opt-in 실제 인증 API 검증
npm run test:product-auth
# DATABASE_URL을 명시한 실제 Local Server tenant/WS 격리 검증
npm run test:tenant-auth
# DATABASE_URL을 명시한 실제 history projection/outbox/API 검증
npm run test:history-postgres
# 독립 --rm pgvector 컨테이너를 만들고 항상 정리하는 실제 RAG 검증
npm run test:rag-postgres
# 실제 OpenAI 호출은 key만으로 실행되지 않으며 두 값을 모두 명시해야 함
$env:KODEX_RAG_LIVE_SMOKE = '1'; $env:OPENAI_API_KEY = '<key>'; npm run test:embedding-smoke
```

기본 `npm test`는 외부 모델이나 DB를 호출하지 않으며 embedding도 deterministic fake provider를 사용합니다. 선택적 실제 OpenAI smoke는 기본 test에 포함하지 않습니다. `test:product-db`, `test:product-auth`, `test:tenant-auth`, `test:history-postgres`는 실제 PostgreSQL row를 만들고 종료 시 정리합니다. `test:rag-postgres`는 전용 `pgvector/pgvector:0.8.6-pg17` `--rm` 컨테이너를 생성해 nearest-neighbor, model/dimension filter, 멱등/원자 교체, 사용자/workspace 격리, run/citation, cascade, session/membership 폐기를 검증하고 `finally`에서 container를 중지·제거합니다.

## 실제 한계

- 자동화는 Local Server가 켜져 있을 때만 실행되는 로컬 scheduler입니다.
- local provider는 현재 고정 Codex가 지원하는 Responses API 호환성에 한정되며 Chat Completions 전용 서버는 지원하지 않습니다.
- Apps/Plugins/connector와 원격 MCP의 실제 범위·인증은 고정 Codex source와 사용자의 계정/서버에 따릅니다.
- History read API는 shared workspace에서도 현재 사용자의 `created_by_user_id`만 반환합니다. workspace 전체 협업 공유, 보존 기간, hard deletion/계정 삭제 cascade 정책과 사용자 export는 후속 작업입니다.
- RAG는 현재 수동 text 문서 등록, 명시적 미리보기/turn 질의와 exact cosine sequential scan만 지원합니다. repository connector, shared knowledge, retention과 ANN index는 후속 작업입니다.
- Electron/portable runtime은 Product API lifecycle과 tenant data root를 아직 통합하지 않았습니다. 현재 지원 실행 경로는 source의 `npm run dev`/`npm start`입니다.
- SSR, cloud task, Kodex 전용 cloud backend와 배포 기능은 제공하지 않습니다.

제3자 license와 notice는 `THIRD_PARTY.md` 및 각 dependency에 포함된 license 파일을 참조하십시오.
