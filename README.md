# Kodex

Kodex는 공식 오픈소스 [OpenAI Codex](https://github.com/openai/codex)의 App Server를 로컬에서 실행하는 Windows 앱입니다. UI, Local Server, 공식 Codex 전체 소스, 실행 파일, thread와 설정은 사용자의 컴퓨터에 있습니다. PostgreSQL 제품 session과 workspace membership은 필수이며, 인증되기 전에는 UI뿐 아니라 Local Server 자체가 HTTP/WebSocket/Codex runtime 접근을 거부합니다.

Kodex는 네트워크 차단기가 아닙니다. 모델 호출, Web Search, 원격 MCP, Git 네트워크 작업과 패키지 설치는 공식 Codex의 sandbox·approval과 사용자 설정에 따라 사용할 수 있습니다. Local Server는 생성 모델을 직접 호출하거나 tool을 선택하지 않으며, 공식 Codex App Server의 stdio JSONL을 localhost HTTP/WebSocket UI에 연결합니다. 예외적으로 private RAG를 명시적으로 켜면 등록 문서 chunk, 사용자가 preview에서 선택하고 다시 동의한 repository 파일 chunk, Knowledge 검색 미리보기 질의, 일반 turn의 첫 text 질의 embedding을 공식 Embeddings API에 직접 요청합니다. 자동화 prompt는 별도 opt-in일 때만 포함됩니다.

## 구조

```text
apps/ui                 React/Vite renderer와 제품 인증 게이트
apps/local-server       localhost API, 정적 UI, scheduler, Codex 수명 관리
apps/api                독립 제품 인증·사용자별 history HTTP API
apps/desktop            Electron 창과 Product API/Local Server 수명 관리
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

source 실행은 `.kodex-data/tenants/users/<user-uuid>/workspaces/<workspace-uuid>/`, desktop은 `%APPDATA%\Kodex\data\tenants\...`마다 공식 `CODEX_HOME`, projects/settings/automations JSON, 마스킹된 approval/log, `instance.lock`과 `product-history-outbox/`를 따로 저장합니다. UUID는 브라우저 입력이 아니라 DB가 인증한 scope에서만 가져오며 path segment 형식을 재검사합니다. 같은 workspace의 사용자도 raw Codex runtime과 `CODEX_HOME`을 공유하지 않습니다. immutable source/runtime root와 writable data base는 별도 신뢰 경계이며, data base로 drive root, 사용자 home, repository/source root를 지정하거나 tenant root를 data base 밖으로 탈출시킬 수 없습니다. 제품 history는 공식 App Server 공개 notification/server-request stream에서 PostgreSQL로 투영하며 upstream Codex SQLite를 직접 읽거나 polling하지 않습니다.

## 제품 PostgreSQL, 인증 수명주기, tenant runtime, 내구성 history와 private RAG (16단계까지, 필수)

`packages/product-db`는 제품 데이터의 pool, migration, SQL repository와 인증/RAG service를 소유합니다. `apps/api`가 등록·로그인과 인증된 history/knowledge API를 담당하고, Local Server도 같은 hash-only session repository를 통해 매 요청의 active user, session 만료/폐기, workspace membership을 독립적으로 확인합니다. Repository consent/trust boundary는 `docs/adr/0013-consent-repository-rag-indexing.md`, 앞선 제품 결정은 `docs/adr/0001-product-database-boundary.md` 이후 ADR에 있습니다.

`0001_initial_product_schema.sql`부터 `0007_workspace_invitations.sql`까지는 변경하지 않습니다. 새 `0008_workspace_management_pagination.sql`은 bounded member/invitation keyset page index를 추가합니다. 등록 transaction은 사용자, credential, `Personal Workspace`, owner membership과 첫 session을 원자적으로 만듭니다. Workspace page 계약은 `docs/adr/0018-workspace-management-keyset-pagination.md`, 초대 계약은 `docs/adr/0016-hash-only-workspace-invitations.md`, 인증 수명주기는 `docs/adr/0015-product-auth-lifecycle.md`, RAG private 경계와 경합 모델은 `docs/adr/0005-private-pgvector-rag.md`, ANN 결정은 `docs/adr/0008-default-embedding-hnsw.md`에 있습니다.

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

- `GET /api/health/live`: process liveness만 최소 `{ "ok": true }`로 반환합니다.
- `GET /api/health/ready`: DB에 실제 `SELECT 1`이 성공할 때만 `200`; 실패는 credential/schema 내부 정보 없이 `503 { "ok": false }`입니다. migration은 listen 전에 완료됩니다.
- `POST /api/auth/register`: `{ "email", "password", "displayName"? }`, 성공 `201`. 비밀번호는 UTF-8 12~1,024 bytes입니다.
- `POST /api/auth/login`: `{ "email", "password" }`, 성공 `200`. 존재하지 않는 이메일과 잘못된 비밀번호는 같은 `401 invalid_credentials`입니다.
- `GET /api/auth/me`: session cookie로 사용자, session 만료, workspace membership을 조회합니다.
- `PATCH /api/auth/password`: authenticated current session + exact Origin + CSRF로 현재 비밀번호를 확인하고 새 Argon2id hash를 저장합니다. 성공 `204`이며 현재 session은 유지하고 다른 활성 session을 같은 transaction에서 폐기합니다.
- `GET /api/auth/sessions`: 최대 100개 session의 UUID, current 여부, 생성/최근 확인/만료/폐기 시각만 반환합니다. token/hash/cookie/CSRF, raw IP와 전체 User-Agent는 반환하지 않습니다.
- `DELETE /api/auth/sessions/<uuid>`: 자기 session을 멱등 폐기하고 `204`; 다른 사용자 또는 없는 UUID는 같은 `404`입니다. 현재 session이면 cookie를 함께 만료합니다.
- `DELETE /api/auth/sessions`: 현재 session을 유지하고 다른 모든 미폐기 session을 종료한 뒤 `204`를 반환합니다.
- `POST /api/auth/logout-all`: 현재 session을 포함해 모든 미폐기 session을 종료하고 cookie를 만료한 뒤 `204`를 반환합니다.
- `POST /api/workspaces`: strict name으로 workspace를 만들고 호출자를 owner로 원자 추가합니다. UI는 `/me` 재검증 후 새 workspace로 즉시 전환합니다.
- `GET /api/workspaces/<uuid>/members?limit=<1..100>&cursor=<opaque>`: 현재 member에게 canonical email, display name, role, joined time의 PostgreSQL keyset page만 반환합니다. 기본 limit은 50입니다.
- `POST /api/workspaces/<uuid>/members`: owner/admin이 이미 가입한 정확한 email의 계정을 추가합니다. 초대 메일이나 token을 만드는 API가 아닙니다.
- `PATCH|DELETE /api/workspaces/<uuid>/members/<user-uuid>`: 역할 변경/제거를 수행하며 보수적 admin 제한과 last-owner 불변식을 transaction row lock으로 강제합니다.
- `POST|GET /api/workspaces/<uuid>/invitations`: owner는 admin/member/viewer, admin은 member/viewer copy-link 초대를 만들고, GET은 기본 50/최대 100의 opaque keyset cursor로 active pending page를 조회합니다. 생성 `201`만 raw token을 한 번 반환합니다.
- `DELETE /api/workspaces/<uuid>/invitations/<invitation-uuid>`: 현재 manager membership을 다시 확인하고 pending 초대를 원자 취소합니다.
- `POST /api/invitations/preview`: URL이 아닌 strict JSON `{ "token": "..." }` body로 unauthenticated masked workspace/email/role/expiry preview를 반환합니다.
- `POST /api/invitations/accept`: authenticated session, Origin, CSRF와 canonical login email 일치를 확인해 membership 생성과 invitation 사용 처리를 원자 commit합니다.
- `POST /api/auth/logout`: session/CSRF cookie와 `X-CSRF-Token` header가 필요하고 성공 시 DB session을 폐기한 뒤 `204`를 반환합니다.
- `GET /api/history/threads?workspace_id=<uuid>&limit=<n>&cursor=<opaque>`: header의 `X-Kodex-Workspace-Id`와 URL scope가 정확히 같아야 하며 현재 로그인 사용자가 만든 thread만 반환합니다. `limit`은 최대 50이고 cursor는 브라우저가 해석하지 않는 불투명 토큰입니다.
- `GET /api/history/threads/<codex-thread-id>?workspace_id=<uuid>&limit=<n>&cursor=<opaque>`: 같은 소유자 검사를 서버에서 강제하고 turn/item/tool call/approval page를 반환합니다. 다른 사용자 thread ID는 `404`입니다. 브라우저 DTO는 DB 내부 ID, source event 식별자, checksum/vector와 session/secret을 제외하고 payload를 서버에서 재필터링한 최대 4,000자 preview로 제한합니다.
- `POST /api/knowledge/documents?workspace_id=<uuid>`: `{ "documentId"?, "sourceId"?, "title", "content" }` text를 사용자 private source에 생성/갱신하고 chunk/embedding을 원자 교체합니다.
- `GET /api/knowledge/documents?workspace_id=<uuid>&limit=<n>&cursor=<opaque>`: 현재 사용자의 문서 metadata만 반환합니다. content checksum과 raw vector는 반환하지 않습니다.
- `DELETE /api/knowledge/documents/<uuid>?workspace_id=<uuid>`: 현재 사용자 소유 문서만 삭제하며 추측한 다른 사용자 ID는 `404`입니다.
- `POST /api/knowledge/query?workspace_id=<uuid>`: `{ "query", "topK"?, "threshold"? }`로 cosine 검색 preview와 document/chunk citation, score를 반환합니다. raw query/document embedding은 반환하지 않습니다.

Repository 파일 API는 Product API가 아니라 tenant Local Server에 있습니다. 둘 다 active authenticated
workspace header, Local Server session/CSRF를 요구합니다.

- `POST /api/knowledge/repository/preview`: exact body `{ "projectId": "<active-local-project-uuid>" }`. 현재 active project 안의 후보를 검사하고 일회용 token, 상대 경로, byte size/status, 제외 reason별 count와 상한만 반환합니다. 파일 내용과 absolute root는 반환하지 않습니다.
- `POST /api/knowledge/repository/confirm`: exact body `{ "previewToken", "projectId", "paths": ["relative/path"] }`. 같은 private scope/active project의 현재 preview allowlist만 다시 검증해 저장하고 파일별 `indexed`/`unchanged`, document ID와 chunk count를 반환합니다.

Knowledge mutation과 POST query는 auth와 별도로 정확한 Origin, session/CSRF cookie, `X-CSRF-Token`, URL/header workspace 일치를 모두 요구합니다. read도 매 요청 session과 membership을 다시 확인합니다. 동일 workspace owner/admin도 다른 사용자의 knowledge에는 접근하지 못합니다.

### Knowledge/RAG 개인정보 및 실행 정책

RAG는 기본 비활성입니다. `KODEX_RAG_ENABLED=true`와 서버 전용 `OPENAI_API_KEY`를 함께 설정해야 활성화됩니다. 활성화하면 (1) 등록 문서를 나눈 chunk, (2) Knowledge 화면에서 사용자가 명시적으로 실행한 검색 미리보기 질의, (3) 일반 agent `turn/start` 입력의 첫 text 질의가 OpenAI Embeddings API로 전송됩니다. `KODEX_RAG_AUTOMATIONS_ENABLED=true`도 설정한 경우에만 자동화 prompt의 첫 text 질의가 추가로 전송됩니다.

repository/source tree, clipboard, 전체 Codex thread/history는 자동 scan하거나 전송하지 않습니다. Repository 인덱싱은 Knowledge/RAG 화면에서 **후보 확인 → 상대 경로 선택 → 외부 embedding/저장 동의 → confirm**을 거쳐야 하며 Local Server만 active project root의 파일을 읽습니다. 개인정보·소스·사내 문서를 넣거나 질의하기 전에 조직의 외부 전송 정책을 확인하세요. Codex 생성 provider를 UI에서 Local로 바꿔도 RAG provider는 현재 OpenAI Embeddings API이므로, local model만 쓴다고 생각한 상태에서 `KODEX_RAG_ENABLED`를 켜지 않도록 주의해야 합니다. `OPENAI_API_KEY`와 Authorization header는 Product API/Local Server 메모리에만 있고 browser, DB, 로그, API JSON에 포함되지 않습니다.

Repository preview는 `.git`, `node_modules`, `dist/build/coverage`, `.kodex-data`, link/reparse
entry, non-file, binary/invalid UTF-8, oversized 파일과 `.env`/대표 credential·key 이름을 기본 제외하고
Git ignore를 존중합니다. Git ignore 검증 실패는 git worktree에서 fail-closed합니다. 이름 기반 secret
제외는 DLP가 아니며 source 안의 token이나 비표준 이름 secret을 모두 찾지 못합니다. Preview에는 파일
내용이 아니라 상대 경로, bounded size/status와 제외 count만 표시되므로 사용자가 경로를 검토해야 합니다.

활성화 시 기본 설정은 `text-embedding-3-small`, 1,536 dimensions, Unicode 1,600자 chunk/200자 overlap, cosine top-5, threshold 0.25, context 6,000자, 문서 60,000 code points입니다. Product API 본문 한도 기본값은 262,144 bytes로 4-byte Unicode 문서와 JSON 여유 공간을 수용합니다. `KODEX_RAG_DOCUMENT_MAX_CHARACTERS`를 늘리면 `PRODUCT_API_MAX_BODY_BYTES`도 늘려야 하며, 안전하지 않은 조합은 시작 시 설정 오류가 됩니다(본문 hard maximum 1,048,576 bytes). `.env.example`의 `OPENAI_EMBEDDING_*`, `KODEX_RAG_*`로 제한 안에서 조정합니다. 429·일시 5xx·네트워크 오류·timeout만 제한된 횟수로 재시도하고, 영구 provider 거부와 malformed 응답은 재시도하지 않습니다. 어떤 embedding/DB 오류도 agent turn 자체를 막지 않습니다.

Repository 운영 상한은 preview당 5,000 filesystem entry, 후보 500개/읽기 16 MiB, token TTL
10분/동시 256개입니다. Confirm은 최대 50개, 파일당 256 KiB, 합계 2 MiB와 500,000 Unicode
code point이며 파일별 `KODEX_RAG_DOCUMENT_MAX_CHARACTERS`도 적용합니다. Token은 user+workspace+active
project+real root에 묶인 일회용 값이고 confirm에서 metadata/type/realpath/size/UTF-8을 다시 검사합니다.
Project 또는 private scope가 바뀌거나 파일이 preview 뒤 바뀌면 새 preview가 필요합니다.

일반 `turn/start`는 첫 text query를 검색합니다. 결과는 document/chunk ID가 있는 bounded JSON block으로 원래 user input 뒤에 추가되며, block 자체가 untrusted reference이고 지시가 아니라는 경계를 포함합니다. 문서 속 prompt injection은 system/developer 권한으로 승격되지 않습니다. 결과 없음/실패는 원래 turn을 그대로 실행합니다. `turn/steer`에는 적용하지 않고 automation도 기본 미적용이며 `KODEX_RAG_AUTOMATIONS_ENABLED=true`에서만 사용합니다.

Repository source는 private scope 안의 `repository:<local-project-uuid>`, document identity는 normalized
relative path입니다. 기존 checksum이 같으면 embedding을 건너뛰고 변경 시 같은 document ID를 원자
재색인합니다. Citation은 `repository_file` source type과 bounded project label/relative-path title로
구분하며 absolute local path나 전체 파일을 agent/UI에 전달하지 않습니다. 선택 해제 또는 디스크 삭제는
기존 RAG 문서를 자동 삭제하지 않습니다. 문서 목록의 명시적 삭제만 document/chunk를 제거합니다.

dimensionless vector schema는 여러 model/dimension을 행별 지원합니다. 그중 정확히 `text-embedding-3-small` + 1,536 dimensions인 기본 조합만 `(embedding::vector(1536)) vector_cosine_ops` partial HNSW index를 사용할 수 있는 approximate cosine 경로로 검색합니다. PostgreSQL planner가 작은 corpus에 sequential scan이 더 싸다고 판단하면 이를 존중하며 제품 코드는 index scan을 강제하지 않습니다. 다른 모델 또는 차원은 기존 owner/model/dimension prefilter 뒤 exact generic cosine 검색으로 fallback하므로 모든 RAG 검색이 ANN인 것은 아닙니다.

기본 ANN 경로는 tenant/model/dimension/threshold filter가 HNSW scan 뒤 적용될 때 결과가 부족해지는 문제를 줄이기 위해 pgvector 0.8.6의 strict iterative scan을 transaction-local로 사용하고 최대 20,000 tuple, `min(topK × 8, 800)` candidate로 작업량을 제한합니다. 그래도 HNSW 자체가 approximate이므로 exact generic 경로와 nearest-neighbor 집합이 항상 같지는 않습니다. 운영자는 corpus/filter 선택도와 latency를 관찰해 `REINDEX INDEX document_chunks_openai_small_1536_hnsw_cosine_idx` 유지보수 시간을 계획해야 합니다. HNSW build와 resident graph는 문서 수에 따라 CPU, I/O와 메모리를 사용하며 migration은 transaction 안에서 index를 만들기 때문에 쓰기를 막을 수 있습니다. 이 구현 경계는 PostgreSQL 17과 pgvector 0.8.6이며, extension 또는 PostgreSQL upgrade 전 실제 migration/EXPLAIN 회귀를 다시 실행해야 합니다.

register/login/me 성공 JSON에는 사용자·workspace·session 만료와 `csrfToken`이 포함됩니다. 이 값은 session bearer가 아니라 `kodex_product_csrf` cookie와 같은 HMAC double-submit 증명이며 프론트 메모리에만 유지됩니다. logout 때도 서버는 허용 Origin, session HttpOnly cookie, CSRF cookie/header, HMAC을 모두 검증합니다.

session token은 32 random bytes이며 브라우저의 `kodex_product_session` HttpOnly cookie에만 전달됩니다. DB에는 SHA-256 hash만 저장합니다. UI는 모든 auth fetch에 `credentials: include`와 `no-store`를 사용하고 session 원문·비밀번호·CSRF token을 Web Storage, IndexedDB, URL 또는 로그에 기록하지 않습니다. Security 화면은 strict session DTO만 받고 loading/empty/error/retry를 표시하며, 비밀번호 input은 요청을 시작한 직후 지우고 pending 동안 destructive control을 비활성화합니다. cookie는 `Path=/`, `SameSite=Strict`, `Max-Age`, `Expires`를 가지며 server production profile에서는 HTTPS Origin과 `Secure`를 강제합니다. Desktop은 원격 production 배치가 아니라 exact `127.0.0.1` HTTP cookie profile이므로 `PRODUCT_API_NODE_ENV=development`를 강제하지만 Host/Origin/CSP allowlist와 renderer의 protocol/hostname 검사는 그대로 유지합니다. UI process의 공개 환경 allowlist는 개발용 `VITE_KODEX_API_URL`과 `VITE_PRODUCT_API_URL`뿐이며 그 밖의 상속된 `VITE_*`도 제거합니다. `DATABASE_URL`, `AUTH_COOKIE_SECRET`, 허용 Origin, OpenAI/provider key는 서버 환경에만 두며 `VITE_` 접두사를 붙이지 않습니다.

로그인 실패 제한은 PostgreSQL `auth_login_rate_limits`를 모든 Product API process가 공유합니다. canonical email과 Node direct socket address를 `AUTH_COOKIE_SECRET`의 domain-separated HMAC-SHA-256으로만 저장하며 `X-Forwarded-For`는 신뢰하지 않습니다. 기본 15분 window/5회/15분 block이고 `AUTH_LOGIN_RATE_LIMIT_ATTEMPTS`(2~20), `AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS`(60~3,600), `AUTH_LOGIN_RATE_LIMIT_BLOCK_SECONDS`(30~86,400)로 제한 안에서 조정합니다. block 응답은 `429`, bounded `Retry-After`, `no-store`입니다. 성공은 email bucket만 reset하고 address bucket은 유지합니다. 각 로그인 transaction은 정책 기간의 두 배보다 오래된 bucket을 `updated_at` index로 최대 100개만 기회적으로 제거하며, 시계가 이전 window 시작보다 뒤로 이동하면 window를 안전하게 초기화합니다.

앱 시작 상태는 `session 확인 중 → 로그인 필요 | 인증됨 | API 확인 불가/재시도`로 나뉩니다. runtime 실행 역할은 `owner`, `admin`, `member`이며 `viewer`는 읽기 전용 제품 membership이므로 목록에는 역할과 함께 보이지만 선택할 수 없고 Local Server HTTP/WS에서도 `403 workspace_forbidden`입니다. 실행 가능한 membership이 없으면 명확한 권한 화면을 표시하고 `KodexClient`나 runtime을 만들지 않습니다.

최초 runtime workspace는 실행 가능한 default membership, 없으면 첫 `owner`/`admin`/`member` membership입니다. 로그인한 사용자는 account menu에서 실행 가능한 membership 사이를 전환할 수 있습니다. 선택은 현재 로그인 React 메모리에만 있고 localStorage, sessionStorage, IndexedDB 또는 URL에 저장하지 않습니다. `/api/auth/me` 재검증에서 같은 사용자와 실행 가능한 membership이 유지되면 선택을 보존하고, membership 제거나 `viewer` 강등이면 기존 UI client를 즉시 unmount한 뒤 안전한 default/첫 workspace로 fallback합니다. fallback이 없으면 runtime 없는 권한 화면으로 이동하며, 사용자가 바뀌면 이전 사용자의 workspace ID를 폐기합니다.

workspace 전환은 `AuthenticatedApp`와 `KodexClient`를 `(user ID, workspace ID)` key로 완전히 다시 만들므로 이전 WebSocket, pending RPC, event reducer, active thread/project/dialog와 RAG/history 화면 상태가 새 tenant에 섞이지 않습니다. 이전 client의 UI 연결과 pending RPC는 닫히지만 서버에서 이미 실행 중인 turn을 취소했다는 뜻은 아니며 해당 작업은 서버 정책에 따라 계속될 수 있습니다. Product knowledge/history 요청과 모든 Local Server HTTP 요청은 active workspace의 `X-Kodex-Workspace-Id`/`workspace_id`를 사용하고 WebSocket URL도 같은 비밀 아닌 `workspace_id`를 사용합니다. session bearer는 계속 HttpOnly cookie에만 있습니다. 이 UI 선택에 필요한 별도 workspace-switch API는 없습니다.

Account menu의 **Workspace 관리**에서는 새 workspace 생성, 현재 member 목록, copy-link 초대 생성/한 번 복사, pending 조회/취소, 역할 변경과 제거를 Product API로 수행합니다. member와 pending 목록은 누적 **더 보기**를 제공하며 첫 page와 추가 page의 loading/error/retry를 분리하고, workspace 변경·재검증·닫기 때 이전 요청과 cursor를 폐기합니다. raw invitation token은 32 random bytes이고 생성 응답과 fragment 메모리에만 존재하며 DB에는 domain-separated SHA-256만 저장됩니다. 앱 entrypoint는 `#invite=` fragment를 React 시작 전에 회수하고 URL에서 즉시 제거하며 로그인/가입 뒤 email 일치 수락과 `/me` 재검증을 수행합니다. owner는 admin/member/viewer를, admin은 member/viewer만 초대할 수 있고 owner 초대는 금지됩니다. 마지막 owner 불변식과 사용자별 private History/RAG scope는 그대로입니다. 자세한 계약은 `docs/adr/0012-workspace-membership-management.md`, `docs/adr/0016-hash-only-workspace-invitations.md`, `docs/adr/0018-workspace-management-keyset-pagination.md`에 있습니다.

Account menu의 **Security**에서는 session 목록/개별 종료/다른 session 모두 종료, 현재 비밀번호 확인을 포함한 변경, 모든 기기 로그아웃을 수행합니다. 비밀번호 변경은 현재 session을 유지하고 다른 활성 session만 원자 폐기하며, 현재 session 개별 폐기와 모든 기기 로그아웃은 성공 즉시 UI를 unauthenticated 상태로 바꾸고 runtime/WebSocket을 unmount합니다. Local Server HTTP와 이미 열린 WebSocket은 같은 DB session을 기존 최대 5분/만료 중 빠른 재검증에서 각각 `401`/`1008`로 거부합니다.

로그인 후 사이드바의 **저장된 DB 히스토리**는 Product API의 사용자별 PostgreSQL projection만 조회하는 별도 다이얼로그입니다. 공식 Codex sidebar/thread 목록을 병합하거나 대체하지 않으며, 목록과 상세을 각각 cursor로 더 불러옵니다. projection은 비동기이므로 방금 끝난 대화가 잠시 늦게 보일 수 있습니다. 내보내기는 이 화면이 검증한 bounded DTO만 JSON Blob으로 만들고 임시 URL을 즉시 해제합니다. 세부 경계는 `docs/adr/0007-saved-db-history-ui.md`에 있습니다.

Local Server 요청 순서는 다음과 같습니다.

1. loopback `Host`와 allowlisted `Origin`을 확인합니다.
2. mutation에는 기존 `kodex_session`/`X-Kodex-CSRF`, bootstrap에는 기존 bootstrap proof를 확인합니다.
3. `kodex_product_session` 원문을 로그에 남기지 않고 SHA-256 hash로 DB session을 조회합니다.
4. active user, 미만료·미폐기 session, 정확한 workspace membership을 확인한 뒤에만 `(user UUID, workspace UUID)` runtime lease를 얻습니다.

WebSocket upgrade도 같은 순서를 사용합니다. 연결 후에는 session 만료 시각과 5분 중 빠른 시점마다 DB를 재검증하며 session 폐기 또는 membership 제거 시 code `1008`로 닫습니다. DB와 Node clock skew로 성공 재검증 후 만료 시각이 이미 지난 것으로 보이면 production 1초(테스트용 더 작은 interval은 그 값)의 최소 지연을 두어 DB tight loop를 막습니다. connection의 runtime, sequence/replay, server-request owner와 approval은 연결 시 고정되어 다른 tenant socket으로 broadcast되지 않습니다.

### 개발 hostname과 운영 cookie 배치

`npm run dev`의 기본 조합은 Vite UI `http://127.0.0.1:5173`, Local Server `http://127.0.0.1:47831`, Product API `http://127.0.0.1:47832`이며 이 개발 경로에서만 `VITE_PRODUCT_API_URL`을 사용합니다. source `npm start`는 built UI를 Local Server `47831`에서 제공하고, 요청 Host가 `127.0.0.1`이면 `127.0.0.1` Product origin을, `localhost`이면 `localhost` Product origin을 검증된 runtime meta로 선택합니다. CSP에는 전체 exact allowlist를 유지합니다. Desktop/portable은 두 포트를 launcher가 정하되 hostname을 exact `127.0.0.1`로 고정하고 같은 runtime meta 계약을 사용합니다. `KODEX_PRODUCT_API_ORIGINS`는 unique exact HTTP(S) origin만 허용하며 path, credential, 중복 또는 CSP directive 형태 문자열은 시작 시 거부됩니다. production loopback renderer는 Product API도 동일 protocol과 동일 hostname이어야 하고 port만 달라질 수 있습니다.

non-loopback 운영은 HTTPS reverse proxy가 UI와 Product API를 exact same-origin으로 제공해야 합니다. 별도 origin과 cross-site 배치는 renderer 및 cookie 정책에서 거부됩니다. production Vite build는 `VITE_PRODUCT_API_URL`을 컴파일하지 않으며 Local Server가 제공한 runtime meta가 없으면 안전하게 실패합니다.

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

Electron은 Product API를 먼저 시작해 DB-backed readiness를 확인하고, 그 다음 Local Server를 시작해 health를 확인한 뒤 renderer를 엽니다. 어느 child든 예기치 않게 종료하면 창과 다른 child를 함께 정리합니다. 정상 종료는 각 child에 graceful 종료 시간을 준 뒤 Windows process tree를 bounded 강제 정리합니다. child stdout/stderr는 desktop으로 전달하지 않아 DB URL/provider key가 launcher log로 유출되지 않습니다. renderer Node integration은 꺼져 있고 context isolation과 sandbox를 켭니다. privileged renderer에서 원격 페이지를 열지 않고 외부 링크는 OS 브라우저로 보냅니다. preload에는 파일/폴더 선택만 노출하며 key나 runtime origin을 전달하지 않습니다.

PostgreSQL 자체는 앱에 포함하지 않고 Docker도 자동으로 시작하지 않습니다. desktop/portable 실행 전 `%APPDATA%\Kodex\kodex.env`에 최소 `DATABASE_URL`과 `AUTH_COOKIE_SECRET`을 설정하거나 process environment로 주입해야 합니다. environment가 같은 key의 파일 값보다 우선합니다. 이 파일은 로그인한 사용자만 읽을 수 있도록 Windows ACL을 제한하고 백업·지원 로그·공유 폴더에 넣지 마세요. `DATABASE_URL`이 없거나 잘못됐거나 DB가 접속 불가하면 renderer를 열기 전에 실패합니다. writable tenant 데이터는 `%APPDATA%\Kodex\data`에 있고 portable 실행 파일 옆에는 쓰지 않습니다.

built UI는 Product API port를 build-time `VITE_*` 값으로 고정하지 않습니다. 검증된 Local Server가 UI 요청 Host와 같은 hostname의 exact Product API origin 하나를 HTML meta에 주입하고 전체 allowlist를 CSP `connect-src`에 유지합니다. renderer는 loopback에서 동일 protocol/hostname 또는 non-loopback exact same-origin만 허용합니다.

```powershell
npm run build
npm run runtime:bundle
# runtime\Kodex-win32-x64\Kodex.exe 실행
```

bundle은 Windows x64 Electron, Product API/Local Server/UI dist, SQL migration 0001~0008, 공식 `codex.exe`, `pg`/`argon2` runtime과 Windows native asset을 포함합니다. root `node_modules`, `.env.local`/`kodex.env`, DB URL/key, tenant data는 포함하지 않습니다. PostgreSQL service, 자동 updater, installer/signing은 portable bundle 범위 밖입니다.

## 검증

```powershell
npm run codex:verify-source
npm run typecheck
npm run lint
npm test
npm run build
npm run test:auth-lifecycle-postgres # 격리된 실제 PostgreSQL의 change-password/session/limiter + Local HTTP/WS
npm run test:tenant-auth  # Local Server HTTP/열린 WebSocket 재검증
npm run verify:ui-bundle
npm run smoke:production
npm run desktop:smoke
npm run runtime:bundle
npm run runtime:smoke
# 주입한 DATABASE_URL로 실제 두 서버와 Electron login 화면 검증
npm run desktop:smoke:postgres
npm run test:local-provider
npm run test:handshake
# DATABASE_URL을 명시한 opt-in 제품 DB 검증
npm run test:product-db
# DATABASE_URL을 명시한 opt-in 실제 인증 API 검증
npm run test:product-auth
# DATABASE_URL을 명시한 실제 Local Server tenant/WS 격리 검증
npm run test:tenant-auth
# 독립 --rm pgvector에서 workspace 생성/역할/owner lock/audit와 Local Server 권한 폐기 검증
npm run test:workspace-postgres
# 독립 fresh DB와 0001~0006 upgrade DB에서 초대 token/권한/동시 수락/audit 검증
npm run test:workspace-invitations-postgres
# DATABASE_URL을 명시한 실제 history projection/outbox/API 검증
npm run test:history-postgres
# 독립 --rm pgvector 컨테이너를 만들고 항상 정리하는 실제 RAG 검증
npm run test:rag-postgres
# 인증부터 실제 두 서버/codex.exe/DB projection/격리/logout까지의 opt-in API/WS acceptance
npm run test:full-stack
# 실제 Electron renderer DOM으로 가입/settings/agent/history/logout까지의 opt-in Desktop UI acceptance
npm run test:desktop-full-stack
# 실제 Electron renderer DOM으로 workspace 초대 생성/fragment/가입/수락/재사용 실패까지 검증
npm run test:desktop-workspace-invitation
# 실제 OpenAI 호출은 key만으로 실행되지 않으며 두 값을 모두 명시해야 함
$env:KODEX_RAG_LIVE_SMOKE = '1'; $env:OPENAI_API_KEY = '<key>'; npm run test:embedding-smoke
```

기본 `npm test`, `smoke:production`, `desktop:smoke`, `runtime:smoke`는 외부 모델·DB·Docker를 호출하지 않습니다. desktop smoke fixture는 격리 포트에서 readiness 순서, runtime Product API origin, 로그인 화면까지만 검증하며 실제 DB 검증을 가장하지 않습니다. 실제 desktop 경로는 `DATABASE_URL`을 주입한 `desktop:smoke:postgres`로 opt-in합니다. 선택적 실제 OpenAI smoke는 기본 test에 포함하지 않습니다. `test:product-db`, `test:product-auth`, `test:tenant-auth`, `test:history-postgres`는 명시한 실제 PostgreSQL에 row를 만들고 종료 시 정리합니다. `test:auth-lifecycle-postgres`, `test:workspace-postgres`, `test:workspace-invitations-postgres`, `test:rag-postgres`, `test:full-stack`, `test:desktop-full-stack`, `test:desktop-workspace-invitation`, `test:desktop-repository-rag`은 각자 고유한 `pgvector/pgvector:0.8.6-pg17` `--rm` container와 임의 loopback port를 만들고 `finally`에서 정리합니다. 인증 수명주기 harness는 실제 `0001`~`0005` ledger에서 `0006`만 upgrade하고, invitation harness는 fresh 0001~0008, 실제 0001~0006 ledger에서 0007+0008, 배포된 0001~0007 ledger에서 0008-only upgrade를 각각 검증합니다. Workspace harness는 100개 초과 동일 timestamp fixture, 중간 mutation, IDOR/cross-scope/tamper/limit와 실제 keyset index plan을 검증합니다. 이 스크립트들은 Docker Desktop 자체를 시작하거나 종료하지 않으므로 먼저 daemon을 실행해야 합니다.

Repository RAG의 명시적 동의 경계를 실제 Electron UI부터 검증하려면 Docker daemon이 준비된 상태에서 다음을 실행합니다.

```powershell
npm run test:desktop-repository-rag
```

이 명령은 임시 Git 저장소에 일반 UTF-8 문서, `.gitignore` 제외 파일, `.env`와 `.ssh` 비밀 fixture를 만들고 실제 renderer DOM에서 Settings의 project 추가와 Knowledge/RAG의 preview → 파일 선택 → consent → confirm을 수행합니다. 동일 파일 재인덱싱 skip, 내용 변경 후 동일 document identity 갱신, 검색과 agent의 안전한 상대 경로 citation, 명시적 삭제와 manual text 보존을 PostgreSQL/pgvector row와 교차 검증합니다. 별도 tenant 문서를 Product API로 만든 뒤 foreign workspace `403`, foreign document `404`, tampered active-project confirm `409`도 확인합니다. Responses 모델은 loopback이고 embedding은 acceptance 자식 프로세스에만 사전 로드한 결정적 fixture이므로 외부 모델 network나 실제 OpenAI key를 사용하지 않습니다. 성공·실패·중단 모두 Electron process tree, 임시 DB container와 파일을 정리하며, Docker daemon이 꺼져 있으면 시작 방법을 포함한 명확한 오류로 종료합니다. 자세한 경계와 비검증 범위는 [ADR 0014](docs/adr/0014-desktop-repository-rag-acceptance.md)에 기록했습니다.

### Full-stack acceptance 경계

`npm run test:full-stack`은 Node/npm dependencies, 실행 중인 Docker daemon(첫 실행은 image pull network),
현재 저장소의 `bin/codex.exe`를 요구합니다. opt-in CI job도 같은 세 전제를 artifact/runner에 준비해야 합니다.
명령은 제품을 build한 뒤 다음 경계를 한 시나리오로 검증합니다.

| 경계 | 실제 실행 | acceptance 증거 |
| --- | --- | --- |
| 프론트 계약 | Product `register/logout/login/me`, Local `bootstrap/settings` HTTP | HttpOnly product cookie, CSRF, runnable workspace와 tenant provider 설정 |
| Product API | build된 별도 server process | auth, owner→B invitation/accept/`me`, user/workspace-scoped Saved DB History list/detail |
| Local Server | build된 별도 HTTP/WS server process | invitation 전 shared workspace 거부, 수락 후 bootstrap/WS 허용, replay와 `thread/start`/`turn/start` |
| agent | 저장소의 실제 `bin/codex.exe app-server` | keyless loopback Responses, 실제 shell tool call/output, 최종 assistant/`turn/completed` |
| persistence | 임시 실제 PostgreSQL 17 + pgvector image | thread/turn/assistant/tool projection을 Product API에서 bounded polling |
| 폐기 | 실제 Product logout | Product API `401`, 새 Local 연결 거부, 기존 WS code `1008` 종료 |

```text
auth HTTP -> tenant Local HTTP -> Local WS -> real codex.exe -> loopback model/tool round trip
          -> history outbox -> PostgreSQL -> Product history API -> B invite/accept -> shared Local WS
          -> same-workspace user-private history isolation -> A logout/revocation
```

이 테스트는 실제 브라우저나 Electron renderer를 실행하지 않으므로 UI E2E가 아니라 프론트가 의존하는
HTTP/WS 계약의 full-stack acceptance입니다. 외부 OpenAI generation/API key도 쓰지 않습니다. RAG는 명시적으로
비활성화하며 embedding endpoint를 테스트용으로 바꾸지 않습니다. 실제 RAG/pgvector retrieval은 독립
`npm run test:rag-postgres`, live embedding은 별도 opt-in smoke가 담당합니다. 상세 결정은
`docs/adr/0010-full-stack-acceptance-harness.md`에 있습니다.

Windows에서 실제 command lifecycle을 안정적으로 검증하기 위해 이 테스트 tenant만 settings API로
`danger-full-access`/`never`를 사용합니다. model fixture가 호출할 수 있는 command는 고정된 로컬 echo 하나이며
shell/Web Search network를 끄고, 실제 exit code 0과 marker output을 확인합니다. 운영 기본 설정을 바꾸거나
사용자 prompt/repository 내용을 command로 실행하지 않습니다.

### Desktop UI full-stack acceptance 경계

`npm run test:desktop-full-stack`은 위 API/WS acceptance와 같은 Node/npm, 실행 중인 Docker daemon,
현재 저장소의 `bin/codex.exe` 전제를 사용하지만 별도의 제품 경계를 검증합니다. 실제 Electron desktop
bootstrap이 Product API readiness 다음 Local Server readiness를 기다리고 build된 renderer를 숨김 창에
로드합니다. 드라이버는 React 함수나 상태, HTTP API를 직접 호출하지 않고 접근 가능한 label/role/text로만
회원가입 폼 입력·제출, Settings 열기와 Local provider 저장, composer 전송, assistant/tool 결과 확인,
저장된 DB 히스토리 dialog refresh·선택·상세 확인, 계정 메뉴 로그아웃을 수행합니다.

이 명령은 테스트 tenant에만 `kodex-loopback-model`, keyless loopback `/v1`, `danger-full-access`와 `never`를
DOM으로 저장합니다. fixture가 고정한 로컬 echo command 외에 사용자 입력이나 외부 network를 shell로 전달하지
않으며 Responses 요청에 Authorization이 없고 tool output marker와 exit code 0이 돌아왔는지도 fixture에서
확인합니다. Electron user data, tenant data, fixture socket, Electron/서버/App Server process와 DB container는
격리되고 bounded cleanup됩니다. 실패하면 임시 디렉터리에 renderer screenshot과 값·본문을 제외한 DOM 구조
요약만 남기고 경로를 출력하며, 성공하면 artifact 디렉터리까지 제거합니다.

`test:full-stack`은 browser 없이 더 넓은 HTTP/WS tenant isolation과 logout socket revocation을 검증하고,
`test:desktop-full-stack`은 한 사용자 경로의 실제 DOM 표시와 상호작용을 검증합니다. 둘 다 live OpenAI/RAG,
Web Search, remote MCP, installer/package 결과는 검증하지 않습니다. 상세 결정은
`docs/adr/0011-desktop-ui-full-stack-acceptance.md`에 있습니다.

### Desktop workspace invitation acceptance 경계

`npm run test:desktop-workspace-invitation`은 invitation 전용 Electron renderer acceptance입니다. 실제 build된
Product API와 Local Server, 고유 PostgreSQL container, 격리 Electron user-data를 띄운 뒤 owner가 account menu의
**Workspace 관리**를 열어 email과 member 역할을 입력하고 링크를 생성합니다. raw link가 readonly input 한 곳에만
표시되고 pending row에는 없으며, 닫은 뒤 renderer에서 제거되는지 확인합니다.

같은 창을 생성된 `#invite=` fragment로 reload하면 entrypoint가 React render 전에 `history.replaceState`로 주소를
정리해야 합니다. 실제 DOM에서 masked preview와 회원가입을 완료한 뒤 명시적 **초대 수락** 전 target workspace
bootstrap이 `403`인지 검사합니다. 수락 후 Product `/me`가 다시 호출된 다음 account label이 invited member
workspace를 선택하고, Local bootstrap `200`, UI WebSocket connected와 별도 target-scope WebSocket `hello`까지
성공해야 합니다. 같은 fragment로 다시 진입해 사용된 token의 generic `410` terminal 화면과 안전한 후속 요청도
검증합니다.

Electron request observer는 raw token이 main-frame fragment 두 번과 strict preview/accept JSON body 외 URL,
후속 body에 나타나지 않는지만 boolean/route/status로 판정하며 request body를 artifact나 log에 저장하지 않습니다.
각 단계에서 URL/history, DOM/attribute/control value, Web Storage, Cache Storage, IndexedDB 이름, resource URL과
HttpOnly 포함 cookie value에 token이 남지 않았는지 검사합니다. PostgreSQL에서는 domain-separated expected hash,
accepted membership, pending 제거와 create/accepted audit를 교차 검증하고 raw token/hash/email이 audit에 없음을
확인합니다. 실패 screenshot은 전체 renderer text를 투명화하고 allowlist heading, control type과 element count만
보존합니다. 상세 결정은 `docs/adr/0017-desktop-workspace-invitation-acceptance.md`에 있습니다.

## 실제 한계

- 자동화는 Local Server가 켜져 있을 때만 실행되는 로컬 scheduler입니다.
- Workspace 초대 delivery는 명시적인 one-time copy-link만 제공합니다. 외부 SMTP/email delivery, reminder/resend, workspace rename/delete, expired invitation retention job과 분산 preview/accept rate limit은 아직 제공하지 않습니다.
- Password reset과 email verification은 외부 메일 전달/token 전달 인프라가 없어 제공하지 않습니다. register limit, distributed edge/WAF rate limit, trusted reverse proxy와 forwarded client IP 처리, 오래된 session row retention과 대규모 운영 cleanup job도 후속 범위입니다.
- local provider는 현재 고정 Codex가 지원하는 Responses API 호환성에 한정되며 Chat Completions 전용 서버는 지원하지 않습니다.
- Apps/Plugins/connector와 원격 MCP의 실제 범위·인증은 고정 Codex source와 사용자의 계정/서버에 따릅니다.
- History read API는 shared workspace에서도 현재 사용자의 `created_by_user_id`만 반환합니다. workspace 전체 협업 공유, 보존 기간, hard deletion/계정 삭제 cascade 정책과 사용자 export는 후속 작업입니다.
- RAG는 수동 text 등록, 명시적 동의 기반 active repository 파일 인덱싱과 미리보기/turn 질의를 지원합니다. 기본 `text-embedding-3-small`/1,536 조합은 planner 선택에 따라 HNSW ANN을 사용할 수 있고, 그 밖의 모델/차원은 exact cosine fallback입니다. Shared knowledge, 자동 repository 동기화와 retention은 후속 작업입니다.
- Portable runtime은 외부 PostgreSQL의 설치·기동·백업·upgrade를 관리하지 않으며 Windows x64 압축 배포물 수준입니다.
- SSR, cloud task, Kodex 전용 cloud backend와 배포 기능은 제공하지 않습니다.

제3자 license와 notice는 `THIRD_PARTY.md` 및 각 dependency에 포함된 license 파일을 참조하십시오.
