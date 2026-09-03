# ADR 0014: Electron Repository RAG full-stack acceptance

- 상태: 승인
- 날짜: 2026-09-03

## 배경

Phase 14의 repository indexing unit/PostgreSQL integration test는 ignore/secret policy, stable source identity와
private scope를 각각 검증하지만, 실제 Electron renderer에서 사용자가 preview 결과를 보고 파일을 선택한 뒤
동의해야만 Local Server와 Product RAG로 전달되는지는 증명하지 않는다. ADR 0011의 desktop full-stack 경로는
인증, Settings, agent/tool, Saved DB History와 logout을 검증하므로 그 경로를 변경하거나 RAG 장기 실행을 기본
suite에 섞지 않고 별도 opt-in acceptance가 필요하다.

## 결정

`npm run test:desktop-repository-rag`을 추가한다. orchestration은 ADR 0011과 같은 Electron source runtime,
`startIsolatedPostgres`, 고유 user-data/data root, 임의 loopback port, bounded Windows process-tree 종료를
재사용한다. 새 명령은 임시 Git 저장소를 만들고 다음 fixture를 둔다.

- 검색 가능한 `docs/repository-note.md`, `src/example.ts`, `README.md`
- `.gitignore`로 제외되는 디렉터리와 확장자 파일
- `.env`, `.ssh/id_ed25519`처럼 이름 정책으로 제외되는 민감 파일
- stable identity update를 위한 `repository-note.md`의 초기/변경 본문

renderer driver는 public 접근성 label, role, button text와 native DOM input/change/click event만 사용한다.
Settings의 directory 선택 button은 실제 preload `contextBridge`와 `ipcRenderer.invoke`를 통과한다. explicit
acceptance flag의 main IPC handler만 소유한 임시 fixture 경로를 native dialog 결과 대신 반환하며, 정상 실행은
운영 `showOpenDialog`를 사용한다. sandboxed Electron preload는 지원되는 CommonJS `.cjs` 형식으로 bundle한다.
이 경로로 fixture project와 loopback Responses provider를 등록하고, Knowledge/RAG dialog에서 manual text를
먼저 저장한다. 그 뒤 preview → 후보 checkbox → consent checkbox → confirm을 수행한다. 선택이나 consent 전에는
confirm button이 disabled인지도 확인한다. 동일 DOM 흐름을 반복해 unchanged 결과를 확인하고, main process가
fixture 파일을 변경한 뒤 다시 DOM 흐름을 반복해 updated 결과를 확인한다. React state 함수나 request helper를
직접 호출하지 않는다.

UI 동작 뒤 acceptance driver는 같은 임시 PostgreSQL에 read-only assertion query를 실행한다. `repository_file`
source/document/chunk, 상대 `source_document_id`, embedding model/dimension, stable document/source ID, checksum과
chunk 교체, retrieval citation metadata를 확인한다. 검색 preview와 실제 agent turn 모두 repository marker를
query하고, 화면과 model output에는 `Repository Acceptance Fixture / docs/repository-note.md`만 citation으로
표시되어야 한다. 절대 fixture 경로와 excluded secret marker가 Knowledge UI, agent conversation, RAG DB row,
embedding/model fixture input에 나타나면 실패한다.

명시적 삭제 button은 renderer DOM으로 누른다. 삭제 뒤 repository query가 빈 결과인지, 이전 chunk/citation이
cascade됐는지, 먼저 만든 manual document와 manual query가 그대로 남는지를 UI와 DB에서 교차 검증한다.

## 결정적 provider와 보안 경계

generation은 keyless loopback Responses SSE fixture를 사용한다. fixture는 요청에 RAG context marker,
repository content, source type과 안전한 title이 모두 있을 때만 고정 citation을 반환한다. authorization header가
전달되면 실패한다.

운영 `OpenAIEmbeddingProvider`의 고정 HTTPS endpoint나 runtime 설정을 완화하지 않는다. explicit desktop
acceptance flag에서 시작한 Product API/Local Server 자식에만 Node `--import` hook을 전달하고, 그 hook이
`https://api.openai.com/v1/embeddings` 호출에 3차원 결정적 vector를 process 안에서 반환한다. 이 hook과 환경
변수는 정상 desktop 실행과 build 환경에 전달되지 않는다. 따라서 외부 network 없이 실제
`KnowledgeService`/repository/chunking/pgvector SQL을 통과하며 제품 코드에 test provider 선택이나 insecure
remote endpoint fallback을 추가하지 않는다.

## scope/IDOR 검증

별도 Product API session으로 foreign user/workspace/manual document를 만든다. primary browser session으로 foreign
workspace list는 `403`, primary scope를 유지한 foreign document DELETE는 존재를 숨기는 `404`여야 하며 foreign
row가 그대로 남아야 한다. Local Server bootstrap으로 만든 preview의 project ID를 임의 UUID로 바꾼 confirm은
active project binding에서 `409`여야 한다. 이 negative API 호출들은 동의 기반 indexing 성공 경로를 대신하지
않고, 성공 경로가 끝난 뒤 API/DB 경계만 교차 검증한다.

## lifecycle과 비검증 범위

build, readiness, DOM 단계, embedding, agent turn과 DB assertion에는 bounded timeout을 둔다. 성공, 실패,
SIGINT와 SIGTERM 모두 Electron/Product API/Local Server/App Server process tree, fixture sockets, 임시 Git 저장소,
user-data와 UUID 이름의 pgvector container를 정리한다. 실패 screenshot은 input/message/citation 본문을 투명하게
redact하고 구조 정보만 보존한다. Docker Desktop/daemon은 스크립트가 임의로 켜거나 끄지 않으며 daemon이
꺼져 있으면 기존 isolated PostgreSQL helper의 명확한 오류를 반환한다. Docker Desktop Model Runner 설정은
읽거나 변경하지 않는다.

이 acceptance는 live OpenAI embedding/generation 품질, remote MCP/Web Search, 운영 DB 성능, installer/signing,
symlink race를 포함한 모든 filesystem 공격 조합을 증명하지 않는다. 기본 `npm test`, 기존
`test:desktop-full-stack`, vendor source, generated protocol과 과거 migration은 변경하지 않는다.
