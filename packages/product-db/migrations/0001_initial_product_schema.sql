CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'pending_deletion')),
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX users_email_active_uq
  ON users (lower(email))
  WHERE deleted_at IS NULL;

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) >= 32),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_active_idx
  ON auth_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX auth_sessions_expiry_idx
  ON auth_sessions (expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, owner_user_id)
);

CREATE UNIQUE INDEX workspaces_slug_active_uq
  ON workspaces (lower(slug))
  WHERE deleted_at IS NULL;

CREATE INDEX workspaces_owner_idx
  ON workspaces (owner_user_id, updated_at DESC);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_user_idx
  ON workspace_members (user_id, workspace_id);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  external_key text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

CREATE UNIQUE INDEX projects_external_key_uq
  ON projects (workspace_id, external_key)
  WHERE external_key IS NOT NULL;

CREATE INDEX projects_workspace_status_idx
  ON projects (workspace_id, status, updated_at DESC);

CREATE TABLE agent_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  codex_thread_id text NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, codex_thread_id),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES projects(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX agent_threads_project_updated_idx
  ON agent_threads (workspace_id, project_id, updated_at DESC);

CREATE INDEX agent_threads_workspace_status_idx
  ON agent_threads (workspace_id, status, updated_at DESC);

CREATE TABLE agent_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL,
  codex_turn_id text,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'failed', 'interrupted')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT agent_turns_thread_scope_uq UNIQUE (id, workspace_id, thread_id),
  UNIQUE (thread_id, ordinal),
  FOREIGN KEY (thread_id, workspace_id)
    REFERENCES agent_threads(id, workspace_id) ON DELETE CASCADE,
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE UNIQUE INDEX agent_turns_codex_id_uq
  ON agent_turns (workspace_id, thread_id, codex_turn_id)
  WHERE codex_turn_id IS NOT NULL;

CREATE INDEX agent_turns_thread_started_idx
  ON agent_turns (workspace_id, thread_id, started_at DESC);

CREATE TABLE agent_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL,
  codex_item_id text,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  item_type text NOT NULL,
  role text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT agent_items_turn_scope_uq UNIQUE (id, workspace_id, turn_id),
  UNIQUE (turn_id, sequence),
  FOREIGN KEY (turn_id, workspace_id)
    REFERENCES agent_turns(id, workspace_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX agent_items_codex_id_uq
  ON agent_items (workspace_id, turn_id, codex_item_id)
  WHERE codex_item_id IS NOT NULL;

CREATE INDEX agent_items_turn_type_idx
  ON agent_items (workspace_id, turn_id, item_type, sequence);

CREATE TABLE agent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL,
  turn_id uuid,
  item_id uuid,
  source_instance text NOT NULL,
  source_event_id text NOT NULL,
  event_type text NOT NULL,
  sequence bigint,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source_instance, source_event_id),
  FOREIGN KEY (thread_id, workspace_id)
    REFERENCES agent_threads(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT agent_events_turn_scope_fk
    FOREIGN KEY (turn_id, workspace_id, thread_id)
    REFERENCES agent_turns(id, workspace_id, thread_id) ON DELETE CASCADE,
  CONSTRAINT agent_events_item_scope_fk
    FOREIGN KEY (item_id, workspace_id, turn_id)
    REFERENCES agent_items(id, workspace_id, turn_id) ON DELETE CASCADE,
  CHECK (item_id IS NULL OR turn_id IS NOT NULL),
  CHECK (sequence IS NULL OR sequence >= 0)
);

CREATE INDEX agent_events_thread_time_idx
  ON agent_events (workspace_id, thread_id, occurred_at, id);

CREATE INDEX agent_events_type_time_idx
  ON agent_events (workspace_id, event_type, occurred_at DESC);

CREATE TABLE tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  item_id uuid,
  codex_call_id text NOT NULL,
  tool_name text NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'running', 'completed', 'failed', 'cancelled')),
  arguments jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT tool_calls_turn_scope_uq UNIQUE (id, workspace_id, thread_id, turn_id),
  UNIQUE (workspace_id, thread_id, codex_call_id),
  FOREIGN KEY (thread_id, workspace_id)
    REFERENCES agent_threads(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT tool_calls_turn_scope_fk
    FOREIGN KEY (turn_id, workspace_id, thread_id)
    REFERENCES agent_turns(id, workspace_id, thread_id) ON DELETE CASCADE,
  CONSTRAINT tool_calls_item_scope_fk
    FOREIGN KEY (item_id, workspace_id, turn_id)
    REFERENCES agent_items(id, workspace_id, turn_id) ON DELETE CASCADE,
  CHECK (item_id IS NULL OR turn_id IS NOT NULL),
  CHECK (completed_at IS NULL OR completed_at >= requested_at)
);

CREATE INDEX tool_calls_thread_status_idx
  ON tool_calls (workspace_id, thread_id, status, requested_at DESC);

CREATE INDEX tool_calls_tool_time_idx
  ON tool_calls (workspace_id, tool_name, requested_at DESC);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL,
  turn_id uuid,
  tool_call_id uuid,
  codex_request_id text NOT NULL,
  approval_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'expired')),
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload jsonb,
  resolved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, thread_id, codex_request_id),
  FOREIGN KEY (thread_id, workspace_id)
    REFERENCES agent_threads(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT approvals_turn_scope_fk
    FOREIGN KEY (turn_id, workspace_id, thread_id)
    REFERENCES agent_turns(id, workspace_id, thread_id) ON DELETE CASCADE,
  CONSTRAINT approvals_tool_call_scope_fk
    FOREIGN KEY (tool_call_id, workspace_id, thread_id, turn_id)
    REFERENCES tool_calls(id, workspace_id, thread_id, turn_id)
    ON DELETE SET NULL (tool_call_id),
  CHECK (tool_call_id IS NULL OR turn_id IS NOT NULL),
  CHECK (resolved_at IS NULL OR resolved_at >= requested_at)
);

CREATE INDEX approvals_workspace_pending_idx
  ON approvals (workspace_id, requested_at)
  WHERE status = 'pending';

CREATE INDEX approvals_thread_time_idx
  ON approvals (workspace_id, thread_id, requested_at DESC);

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  ip_address inet,
  user_agent text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_workspace_time_idx
  ON audit_logs (workspace_id, created_at DESC, id DESC)
  WHERE workspace_id IS NOT NULL;

CREATE INDEX audit_logs_actor_time_idx
  ON audit_logs (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE TABLE knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid,
  source_type text NOT NULL,
  external_key text,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'syncing', 'ready', 'failed', 'disabled')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES projects(id, workspace_id) ON DELETE SET NULL (project_id)
);

CREATE UNIQUE INDEX knowledge_sources_external_key_uq
  ON knowledge_sources (workspace_id, source_type, external_key)
  WHERE external_key IS NOT NULL;

CREATE INDEX knowledge_sources_workspace_status_idx
  ON knowledge_sources (workspace_id, status, updated_at DESC);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  source_document_id text NOT NULL,
  title text,
  mime_type text,
  content_checksum bytea,
  content_text text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (source_id, source_document_id),
  FOREIGN KEY (source_id, workspace_id)
    REFERENCES knowledge_sources(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX documents_workspace_updated_idx
  ON documents (workspace_id, updated_at DESC);

CREATE INDEX documents_source_updated_idx
  ON documents (workspace_id, source_id, source_updated_at DESC);

CREATE TABLE document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  token_count integer CHECK (token_count IS NULL OR token_count >= 0),
  embedding vector,
  embedding_model text,
  embedding_dimensions integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (document_id, chunk_index),
  FOREIGN KEY (document_id, workspace_id)
    REFERENCES documents(id, workspace_id) ON DELETE CASCADE,
  CHECK (
    (embedding IS NULL AND embedding_model IS NULL AND embedding_dimensions IS NULL)
    OR (
      embedding IS NOT NULL
      AND embedding_model IS NOT NULL
      AND embedding_dimensions = vector_dims(embedding)
    )
  )
);

CREATE INDEX document_chunks_document_idx
  ON document_chunks (workspace_id, document_id, chunk_index);

CREATE INDEX document_chunks_embedding_model_idx
  ON document_chunks (workspace_id, embedding_model)
  WHERE embedding IS NOT NULL;

CREATE TABLE retrieval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid,
  turn_id uuid,
  query text NOT NULL,
  query_embedding vector,
  embedding_model text,
  embedding_dimensions integer,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (thread_id, workspace_id)
    REFERENCES agent_threads(id, workspace_id) ON DELETE SET NULL (thread_id),
  CONSTRAINT retrieval_runs_turn_scope_fk
    FOREIGN KEY (turn_id, workspace_id, thread_id)
    REFERENCES agent_turns(id, workspace_id, thread_id) ON DELETE SET NULL (turn_id),
  CHECK (turn_id IS NULL OR thread_id IS NOT NULL),
  CHECK (
    (query_embedding IS NULL AND embedding_model IS NULL AND embedding_dimensions IS NULL)
    OR (
      query_embedding IS NOT NULL
      AND embedding_model IS NOT NULL
      AND embedding_dimensions = vector_dims(query_embedding)
    )
  ),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX retrieval_runs_workspace_time_idx
  ON retrieval_runs (workspace_id, started_at DESC);

CREATE INDEX retrieval_runs_thread_time_idx
  ON retrieval_runs (workspace_id, thread_id, started_at DESC)
  WHERE thread_id IS NOT NULL;

CREATE TABLE retrieval_citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  retrieval_run_id uuid NOT NULL,
  chunk_id uuid NOT NULL,
  rank integer NOT NULL CHECK (rank >= 1),
  score double precision,
  quoted_text text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (retrieval_run_id, rank),
  UNIQUE (retrieval_run_id, chunk_id),
  FOREIGN KEY (retrieval_run_id, workspace_id)
    REFERENCES retrieval_runs(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_id, workspace_id)
    REFERENCES document_chunks(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX retrieval_citations_workspace_run_idx
  ON retrieval_citations (workspace_id, retrieval_run_id, rank);

COMMENT ON COLUMN auth_sessions.token_hash IS
  'One-way hash of an opaque session token; plaintext session tokens must never be stored.';

COMMENT ON COLUMN document_chunks.embedding IS
  'Dimensionless pgvector value. Dimension is recorded per row so schema does not bind RAG to one model.';

COMMENT ON COLUMN agent_events.payload IS
  'Redacted product event metadata only; credentials and unredacted secrets must be removed before ingestion.';

COMMENT ON COLUMN agent_events.source_instance IS
  'Idempotency namespace containing both stable worker identity and process epoch; a new process epoch must use a new value.';

COMMENT ON TABLE agent_threads IS
  'Product metadata and Codex thread mapping only; never a replacement for or reader of CODEX_HOME SQLite.';
