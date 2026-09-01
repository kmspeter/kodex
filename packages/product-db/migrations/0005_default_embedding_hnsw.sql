-- The migration runner executes this file in the same transaction as its checksum ledger.
-- Do not use IF NOT EXISTS: an unexpected pre-existing or invalid index must fail loudly
-- instead of recording a migration that silently falls back to a sequential scan.
CREATE INDEX document_chunks_openai_small_1536_hnsw_cosine_idx
  ON document_chunks
  USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL
    AND embedding_model = 'text-embedding-3-small'
    AND embedding_dimensions = 1536;

COMMENT ON INDEX document_chunks_openai_small_1536_hnsw_cosine_idx IS
  'Cosine HNSW for the built-in text-embedding-3-small/1536 path only. Other model/dimension combinations use exact generic search.';
