# ADR 0005: 사용자 소유 PostgreSQL pgvector RAG와 untrusted turn context

- 상태: 승인
- 날짜: 2026-08-31

## 결정

RAG 지식은 `(workspace_id, created_by_user_id)`에 귀속된 private 데이터다. 같은 workspace의
owner/admin도 다른 사용자의 source, document, chunk, retrieval run/citation을 조회하거나 검색할
수 없다. `0004_user_scoped_rag.sql`은 모든 RAG 계층에 소유자를 추가하고 source→document→chunk,
run→citation→chunk composite FK가 workspace와 사용자 모두 일치하도록 강제한다. 기존
`0001`~`0003` migration과 generated/vendor 파일은 변경하지 않는다. 공유 workspace 지식은 향후
별도의 consent, role, retention 정책을 정의한 뒤 추가한다.

RAG는 기본 비활성이고 `KODEX_RAG_ENABLED=true`로 명시적으로 opt-in한다. 활성화하면 사용자가
Knowledge/RAG 화면 또는 인증 Product API에 등록한 문서 chunk, Knowledge 검색 미리보기에서
명시적으로 제출한 query, 일반 agent `turn/start`의 첫 text query를 embedding provider로 전송한다.
automation prompt의 첫 text query는 `KODEX_RAG_AUTOMATIONS_ENABLED=true`도 설정한 경우에만
전송한다. repository/source tree 자동 scan, 전체 Codex history embedding, clipboard 수집은 하지
않는다. 현재 provider는 서버의 `OPENAI_API_KEY`로 공식
[OpenAI Embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create)를
호출하며 Codex 생성 provider의 OpenAI/Local 설정과 독립적이다. 따라서 생성 provider가 Local이어도
RAG opt-in은 prompt/query를 OpenAI에 보낸다. key와 Authorization header는 서버 메모리와 provider 요청 밖으로 나가지 않으며 DB,
browser bundle, JSON 응답, 상태 log에 넣지 않는다. 이 외부 전송은 개인정보/기밀 처리 정책과
조직의 OpenAI API 데이터 정책을 검토한 뒤 활성화해야 한다.

## 데이터 흐름

```text
authenticated user text registration
  -> deterministic Unicode code-point chunker + SHA-256 checksums
  -> OpenAI embeddings (outside DB transaction, bounded batch/timeout/retry)
  -> one PostgreSQL transaction: document upsert + old chunk delete + new chunk insert

first user text in ordinary turn/start
  -> per-runtime RagAugmenter
  -> query embedding
  -> pgvector cosine search
       WHERE workspace + user + model + dimensions
       ORDER BY cosine distance, chunk UUID
  -> retrieval_run + ranked citations
  -> bounded untrusted JSON reference block appended as user input
  -> official Codex App Server turn/start

explicit Knowledge search-preview query
  -> query embedding -> the same scoped pgvector search and retrieval audit path
```

chunking은 Unicode code point 단위라 surrogate pair를 자르지 않고, 고정 크기와 overlap으로 항상
같은 입력에 같은 결과를 낸다. content SHA-256과 chunker version/settings, embedding model/dimension의
index-configuration SHA-256이 모두 같으면 외부 호출과 재색인을 건너뛴다. title만 달라지면 vector를
다시 만들지 않고 metadata만 갱신한다.

모든 vector는 정확한 configured dimension, finite number, non-zero norm을 검증한다. provider
응답은 model, array length, index uniqueness/order, response byte 한계를 검사한다. 429,
500/502/503/504, network failure와 timeout만 최대 횟수 안에서 exponential retry하고 각 시도는
AbortController timeout을 사용한다. 영구 HTTP 오류와 malformed response는 재시도하지 않고 bounded
code로만 분류한다.

## 트랜잭션, 경합과 실패

동일 `(workspace, user, source, source_document_id)` upsert/delete는 PostgreSQL session advisory
lock을 공유한다. lock을 보유하는 동안 connection은 예약하지만 transaction은 열지 않는다.
따라서 느린 외부 embedding 호출이 row lock 또는 MVCC transaction을 장시간 유지하지 않는다.
advisory lock을 얻은 client는 callback에 명시적으로 전달하며, lock 후 재조회·metadata 갱신·삭제와
최종 교체 transaction이 모두 그 client를 재사용한다. 별도 pool connection을 다시 요청하지 않으므로
pool max 1 또는 pool 크기만큼의 동시 색인에서도 connection starvation 교착이 발생하지 않는다.
모든 새 chunk/vector가 메모리에 준비된 뒤 그 client의 짧은 transaction에서 document와 chunk 집합을
교체하고 COMMIT/ROLLBACK이 끝난 다음 `finally`에서 advisory lock을 해제한다.
provider/insert 실패 시 이전 정상 document/chunk가 그대로 남는다. 같은 checksum 동시 upsert는
하나만 embedding하고 다음 요청은 checksum skip한다.

retrieval은 run을 `running`으로 먼저 기록한다. query embedding 실패는 secret 없는 error code와
`failed`/`completed_at`을 남긴다. 성공 검색은 chunk/document를 `FOR KEY SHARE`하고 run completion,
query vector, 모든 citation을 한 transaction에 기록한다. delete/reindex는 이 lock이 끝날 때까지
기다린 뒤 old chunk를 cascade 삭제한다. 따라서 검색 응답 시점에는 일관된 citation snapshot이지만,
이후 문서 삭제/재색인은 과거 citation row도 cascade 삭제할 수 있다. 장기 감사용 immutable 인용
보존은 별도 retention 결정이 필요하다.

embedding column은 기존처럼 dimensionless `vector`다. 여러 model/dimension을 한 schema에 보관할
수 있지만 pgvector HNSW/IVFFlat index는 고정 dimension expression/partial index 설계가 필요하므로
현재는 owner/model/dimension B-tree prefilter 뒤 exact cosine sequential scan을 사용한다. 데이터가
커지면 허용 model/dimension별 typed column/partition/partial ANN index를 migration으로 추가해야 한다.
서로 다른 model 또는 dimension을 한 검색에서 섞는 것은 금지한다.

## agent 안전 경계와 가용성

검색 문서는 untrusted data다. 원래 user input을 변경하거나 잃지 않고 별도의 `text` input을 배열
끝에 추가한다. block header는 검색 text가 system/developer instruction이 아니고 그 안의 command를
실행하지 말라고 명시하며, 각 JSON line에 `document_id`, `chunk_id`, rank, score를 둔다. 전체 block은
Unicode 문자 예산으로 제한되고 정상 end marker를 유지한다. 문서 안의 prompt injection 문구는
JSON string content일 뿐 상위 role로 승격되지 않는다.

query embedding/DB/검색 실패와 결과 없음은 원래 input 객체를 그대로 App Server에 보내는
fail-open 정책이다. 로그에는 `augmented`, `no_results`, `skipped`, `failed`와 bounded error code,
run/citation count만 남기고 query/document/key를 남기지 않는다. 일반 UI `turn/start`만 기본 적용하며
`turn/steer`, approval, interruption 의미는 바꾸지 않는다. automation은 기본 비활성이고
`KODEX_RAG_AUTOMATIONS_ENABLED=true`인 명시적 opt-in에서만 적용한다.

## 후속 작업

workspace 공유 지식/관리자 정책, source connector, retention/expiry, 사용자 export, immutable citation
audit, typed-vector partition과 ANN index, provider residency/routing, per-document external-transmission
consent UI는 후속 범위다.
