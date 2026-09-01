# ADR 0008: 기본 embedding 조합 전용 pgvector HNSW와 exact fallback

- 상태: 승인
- 날짜: 2026-09-01

## 배경

`document_chunks.embedding`은 typmod 없는 `vector`라 한 테이블에 여러 embedding model과 차원을
저장한다. 이 유연성 때문에 일반 `embedding <=> query` 표현에는 고정 차원 ANN opclass index를
안전하게 연결할 수 없었고, 기존 검색은 `(workspace_id, created_by_user_id, embedding_model,
embedding_dimensions)` B-tree prefilter 뒤 exact cosine scan을 수행했다.

## 결정

기존 `0001`~`0004`는 수정하지 않는다. `0005_default_embedding_hnsw.sql`은 다음 index를 migration
transaction과 checksum/advisory-lock ledger 안에서 생성한다.

```sql
CREATE INDEX document_chunks_openai_small_1536_hnsw_cosine_idx
  ON document_chunks
  USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL
    AND embedding_model = 'text-embedding-3-small'
    AND embedding_dimensions = 1536;
```

`IF NOT EXISTS`를 사용하지 않는다. 같은 이름의 예상 밖 object, cast/index build 실패 또는 extension
불일치는 migration 전체를 rollback하고 오류를 반환해야 한다. ledger 없이 성공한 것처럼 보이거나
조용히 sequential scan으로 운영되어서는 안 된다. 정상 재실행은 checksum이 같은 version 5 ledger를
확인하고 아무 SQL도 다시 적용하지 않는다. migration은 `CREATE INDEX CONCURRENTLY`가 아니므로 큰
운영 테이블에서는 build 동안 write lock과 배포 시간을 별도로 계획해야 한다.

검색 repository에는 두 개의 고정 SQL 문이 있다. runtime model이 정확히
`text-embedding-3-small`이고 dimension이 정확히 1,536일 때만 query도 `vector(1536)`으로 cast한
index-compatible cosine distance/order 문을 선택한다. SQL identifier, typmod, model 또는 dimension을
환경 설정에서 문자열 보간하지 않는다. 다른 model 또는 dimension은 typmod 없는 기존 generic
`vector` distance 문을 선택하며 exact 결과를 유지한다. 두 경로 모두 workspace와 user, model,
dimension, score threshold, topK를 적용하고 distance 뒤 chunk UUID로 tie-break한다. 선택된 chunk와
document를 `FOR KEY SHARE`한 뒤 같은 transaction에서 run completion과 ranked citation을 기록한다.
query vector는 SQL 생성 전에 finite, non-zero, 정확한 configured dimension인지 검증한다.

## Approximate 결과와 필터 정책

HNSW는 approximate nearest-neighbor 구조이므로 기본 경로의 결과 집합은 exact fallback과 항상 같다고
보장하지 않는다. 특히 workspace/user와 threshold 같은 일반 filter는 ANN 후보를 읽은 뒤 적용되므로
선택도가 높으면 요청한 topK보다 적게 반환할 수 있다. 기본 경로의 transaction은 pgvector 0.8.6
`hnsw.iterative_scan = strict_order`를 켜서 filter를 통과하는 후보를 찾을 때 scan을 확장하고,
`hnsw.max_scan_tuples = 20000`으로 상한을 둔다. 내부 후보는 `min(topK × 8, 800)`으로 overfetch한 뒤
distance와 UUID 순으로 최종 topK를 고른다. 이 정책은 recall을 개선하고 작업량을 제한하지만 exact
보장은 아니다.

제품 코드는 `enable_seqscan`이나 `enable_indexscan`을 변경하지 않는다. 작은 corpus 또는 낮은
선택도에서는 PostgreSQL planner가 sequential scan을 고르는 것이 더 효율적일 수 있다. EXPLAIN
회귀 테스트만 `enable_seqscan = off`를 transaction-local로 설정해 index가 사용 가능한 구조인지
증명하며 운영 계획을 강제하지 않는다.

## 운영 경계와 비용

지원·검증 경계는 PostgreSQL 17과 pgvector 0.8.6이다. `vector(1536)`은 pgvector `vector` HNSW 차원
한계 안에 있다. extension/PostgreSQL upgrade, opclass 변경 또는 query rewrite 시 실제 migration과
`EXPLAIN (FORMAT JSON)` 회귀를 다시 실행한다. HNSW graph build는 corpus 크기에 비례해 CPU, I/O,
시간과 `maintenance_work_mem`을 사용하고 완성된 graph도 shared cache/메모리 압력을 만든다. insert와
문서 재색인은 graph 유지 비용을 낸다. 대량 삭제나 index 품질/팽창 문제가 관찰되면 운영 window에서
`REINDEX INDEX document_chunks_openai_small_1536_hnsw_cosine_idx` 후 `ANALYZE document_chunks`를
계획한다. `m`, `ef_construction`, scan tuple 상한은 측정 없이 변경하지 않는다.

모든 RAG 검색이 ANN인 것은 아니다. 다른 model/dimension은 계속 exact generic 검색이며, 향후 새
조합을 가속하려면 별도의 고정 SQL과 partial typed expression index, migration 및 실제 DB 회귀가
필요하다. shared knowledge, connector, retention, immutable citation과 UI 변경은 이 결정 범위가 아니다.
