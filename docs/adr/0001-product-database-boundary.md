# ADR 0001: 제품 PostgreSQL과 Codex 내부 저장소의 경계

- 상태: 승인
- 날짜: 2026-08-31

## 배경

현재 Kodex desktop/local-server는 단일 사용자 로컬 앱이며, `.kodex-data`의 JSON과 공식 Codex가 `CODEX_HOME` 안에서 관리하는 내부 저장소를 사용한다. 향후 실제 로그인, 사용자별 history, workspace 권한, audit, RAG가 필요하지만 이를 Codex 내부 SQLite에 추가하면 vendored 구현과 제품 도메인이 결합되고 upstream upgrade도 어려워진다.

## 결정

독립 workspace package `@kodex/product-db`가 공식 `pg` pool, transaction helper, checksum 기반 SQL migration runner를 소유한다. 첫 migration은 다음 두 축을 함께 만든다.

- 제품/tenant: users, hash-only auth sessions, workspaces/members, projects, Codex thread ID mapping, turns/items/events, tool calls, approvals, audit logs
- RAG: knowledge sources, documents/chunks, retrieval runs/citations, pgvector vector 값과 행별 model/dimension metadata

모든 tenant 데이터 조회의 시작점은 `workspace_id`다. 복합 foreign key가 workspace뿐 아니라 `thread → turn → item/tool` parent chain까지 일치하도록 강제하고, nullable child ID가 있으면 필요한 parent ID도 있어야 한다는 check를 둔다. tenant/time/status 조회 index와 수집 event idempotency unique key도 함께 둔다. 사용자 탈퇴는 soft-delete를 전제로 하며, workspace나 hierarchy를 실제 삭제할 때 종속 제품 데이터는 명시적 `CASCADE`로 함께 제거한다. session에는 원문 bearer token 대신 최소 32-byte 단방향 hash만 저장한다.

`agent_events.source_instance`는 단순한 component 이름이 아니라 stable worker identity와 process epoch를 함께 포함하는 idempotency namespace다. 동일 process epoch의 retry는 같은 `(workspace_id, source_instance, source_event_id)`를 재사용하고, worker process가 재시작되어 event ID sequence가 다시 시작될 수 있으면 반드시 새 epoch가 포함된 `source_instance`를 사용한다. 아직 runtime wiring이 없으므로 worker와 epoch를 별도 컬럼으로 분리하지 않고 이 계약만 고정한다.

Migration은 advisory lock을 잡은 단일 transaction에서 실행하고 `schema_migrations`에 version, name, SHA-256 checksum을 기록한다. 이미 적용된 SQL은 수정하지 않고 새 migration으로만 변경한다.

## 소유권 경계

공식 Codex App Server와 `CODEX_HOME` 내부 SQLite가 Codex thread 원본, rollout, 설정과 실행 상태를 계속 소유한다. 제품 DB package는 다음을 하지 않는다.

- `CODEX_HOME` 경로나 SQLite 파일을 열기
- 공식 Codex 테이블을 조회, 수정 또는 migration하기
- 내부 SQLite를 PostgreSQL source of truth로 복제하기

향후 제품 history는 공식 App Server의 공개 protocol/API에서 받은 ID와 event를 idempotent하게 투영한 제품 record다. `agent_threads.codex_thread_id`는 연결 키일 뿐 Codex 내부 row에 대한 foreign key가 아니다. 두 저장소가 불일치하면 공식 App Server가 Codex 실행 상태의 원본이다.

Event, tool, approval의 JSON payload는 제품 API가 credential과 secret을 제거한 뒤 저장해야 한다. DB schema 자체는 임의 JSON 내부의 비밀을 판별할 수 없으므로, 이 redaction은 다음 단계 ingestion repository의 필수 책임이다.

## pgvector 결정

초기 migration은 `embedding vector`처럼 차원을 고정하지 않고 `embedding_model`, `embedding_dimensions`, `vector_dims(...)` check를 함께 저장한다. 이 단계에서는 모델이 정해지지 않았으므로 ANN index를 만들지 않는다. 다음 단계에서 선택한 모델/차원별 partial expression index 또는 차원이 고정된 별도 projection을 migration으로 추가한다.

## 결과와 다음 단계

`DATABASE_URL`이 없는 기존 build/typecheck/lint/test 및 로컬 앱 동작은 외부 DB 없이 유지된다. 실제 DB 검증만 `npm run test:product-db`로 opt-in한다. 운영 전에는 backup/restore, connection secret 공급, TLS CA, row-level 또는 API tenant enforcement, retention, PII redaction, embedding model/index 전략을 확정해야 한다.

다음 단계는 인증 API가 이 package를 사용해 session token을 발급·hash·회수하고, 모든 repository operation에서 workspace membership을 검증하는 것이다. 로그인 UI와 기존 로컬 JSON migration은 별도 결정으로 남긴다.
