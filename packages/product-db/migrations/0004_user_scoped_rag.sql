-- Existing pre-RAG rows did not carry an owner. Assign them to the workspace owner
-- once during migration so every row can participate in the mandatory user scope.
ALTER TABLE knowledge_sources ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
UPDATE knowledge_sources AS source
SET created_by_user_id = workspace.owner_user_id
FROM workspaces AS workspace
WHERE workspace.id = source.workspace_id;
ALTER TABLE knowledge_sources ALTER COLUMN created_by_user_id SET NOT NULL;

ALTER TABLE documents ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE documents ADD COLUMN index_configuration_checksum bytea;
UPDATE documents AS document
SET created_by_user_id = source.created_by_user_id
FROM knowledge_sources AS source
WHERE source.id = document.source_id;
ALTER TABLE documents ALTER COLUMN created_by_user_id SET NOT NULL;

ALTER TABLE document_chunks ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
UPDATE document_chunks AS chunk
SET created_by_user_id = document.created_by_user_id
FROM documents AS document
WHERE document.id = chunk.document_id;
ALTER TABLE document_chunks ALTER COLUMN created_by_user_id SET NOT NULL;

ALTER TABLE retrieval_runs
  ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN error_code text;
UPDATE retrieval_runs AS run
SET created_by_user_id = workspace.owner_user_id
FROM workspaces AS workspace
WHERE workspace.id = run.workspace_id;
UPDATE retrieval_runs SET error_code = 'unknown' WHERE status = 'failed';
ALTER TABLE retrieval_runs ALTER COLUMN created_by_user_id SET NOT NULL;
ALTER TABLE retrieval_runs ADD CONSTRAINT retrieval_runs_error_code_ck CHECK (
  (status = 'failed' AND error_code IN (
    'configuration', 'provider_rejected', 'provider_rate_limited',
    'provider_unavailable', 'provider_timeout', 'provider_invalid_response',
    'database_error', 'unknown'
  ))
  OR (status <> 'failed' AND error_code IS NULL)
);

ALTER TABLE retrieval_citations ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
UPDATE retrieval_citations AS citation
SET created_by_user_id = run.created_by_user_id
FROM retrieval_runs AS run
WHERE run.id = citation.retrieval_run_id;
ALTER TABLE retrieval_citations ALTER COLUMN created_by_user_id SET NOT NULL;

DROP INDEX knowledge_sources_external_key_uq;
CREATE UNIQUE INDEX knowledge_sources_external_key_uq
  ON knowledge_sources (workspace_id, created_by_user_id, source_type, external_key)
  WHERE external_key IS NOT NULL;

ALTER TABLE knowledge_sources
  ADD CONSTRAINT knowledge_sources_user_scope_uq
  UNIQUE (id, workspace_id, created_by_user_id);
ALTER TABLE documents
  ADD CONSTRAINT documents_user_scope_uq
  UNIQUE (id, workspace_id, created_by_user_id);
ALTER TABLE document_chunks
  ADD CONSTRAINT document_chunks_user_scope_uq
  UNIQUE (id, workspace_id, created_by_user_id);
ALTER TABLE retrieval_runs
  ADD CONSTRAINT retrieval_runs_user_scope_uq
  UNIQUE (id, workspace_id, created_by_user_id);

ALTER TABLE documents DROP CONSTRAINT documents_source_id_workspace_id_fkey;
ALTER TABLE documents ADD CONSTRAINT documents_source_user_scope_fk
  FOREIGN KEY (source_id, workspace_id, created_by_user_id)
  REFERENCES knowledge_sources(id, workspace_id, created_by_user_id) ON DELETE CASCADE;

ALTER TABLE document_chunks DROP CONSTRAINT document_chunks_document_id_workspace_id_fkey;
ALTER TABLE document_chunks ADD CONSTRAINT document_chunks_document_user_scope_fk
  FOREIGN KEY (document_id, workspace_id, created_by_user_id)
  REFERENCES documents(id, workspace_id, created_by_user_id) ON DELETE CASCADE;

ALTER TABLE retrieval_citations DROP CONSTRAINT retrieval_citations_retrieval_run_id_workspace_id_fkey;
ALTER TABLE retrieval_citations ADD CONSTRAINT retrieval_citations_run_user_scope_fk
  FOREIGN KEY (retrieval_run_id, workspace_id, created_by_user_id)
  REFERENCES retrieval_runs(id, workspace_id, created_by_user_id) ON DELETE CASCADE;

ALTER TABLE retrieval_citations DROP CONSTRAINT retrieval_citations_chunk_id_workspace_id_fkey;
ALTER TABLE retrieval_citations ADD CONSTRAINT retrieval_citations_chunk_user_scope_fk
  FOREIGN KEY (chunk_id, workspace_id, created_by_user_id)
  REFERENCES document_chunks(id, workspace_id, created_by_user_id) ON DELETE CASCADE;

CREATE INDEX knowledge_sources_user_updated_idx
  ON knowledge_sources (workspace_id, created_by_user_id, updated_at DESC, id DESC);
CREATE INDEX documents_user_updated_idx
  ON documents (workspace_id, created_by_user_id, updated_at DESC, id DESC);
CREATE INDEX document_chunks_user_embedding_idx
  ON document_chunks (workspace_id, created_by_user_id, embedding_model, embedding_dimensions, id)
  WHERE embedding IS NOT NULL;
CREATE INDEX retrieval_runs_user_time_idx
  ON retrieval_runs (workspace_id, created_by_user_id, started_at DESC, id DESC);

COMMENT ON COLUMN knowledge_sources.created_by_user_id IS
  'Mandatory private knowledge owner. Workspace administrators do not inherit access.';
COMMENT ON COLUMN retrieval_runs.error_code IS
  'Bounded, secret-free failure classification; provider and database messages are never persisted.';
COMMENT ON COLUMN documents.index_configuration_checksum IS
  'SHA-256 of the chunker version/settings and embedding model/dimensions used for the active chunks.';
COMMENT ON INDEX document_chunks_user_embedding_idx IS
  'Prefilters private owner, model, and dimensions. Dimensionless vector columns cannot safely use one fixed-dimension HNSW/IVFFlat index.';
