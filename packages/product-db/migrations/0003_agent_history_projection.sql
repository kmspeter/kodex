DROP INDEX projects_external_key_uq;

CREATE UNIQUE INDEX projects_owner_external_key_uq
  ON projects (workspace_id, created_by_user_id, external_key)
  WHERE external_key IS NOT NULL AND created_by_user_id IS NOT NULL;

ALTER TABLE agent_threads
  DROP CONSTRAINT agent_threads_workspace_id_codex_thread_id_key;

CREATE UNIQUE INDEX agent_threads_owner_codex_id_uq
  ON agent_threads (workspace_id, created_by_user_id, codex_thread_id)
  WHERE created_by_user_id IS NOT NULL;

ALTER TABLE agent_threads
  ADD COLUMN source_updated_at timestamptz;

UPDATE agent_threads
SET source_updated_at = updated_at;

ALTER TABLE agent_turns
  ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN source_sort_key text,
  ADD COLUMN lifecycle_rank smallint NOT NULL DEFAULT 0
    CHECK (lifecycle_rank BETWEEN 0 AND 2);

UPDATE agent_turns turn_record
SET created_by_user_id = thread_record.created_by_user_id,
    source_sort_key = COALESCE(turn_record.codex_turn_id, turn_record.id::text),
    lifecycle_rank = CASE
      WHEN turn_record.status = 'in_progress' THEN 1
      ELSE 2
    END
FROM agent_threads thread_record
WHERE thread_record.id = turn_record.thread_id
  AND thread_record.workspace_id = turn_record.workspace_id;

ALTER TABLE agent_items
  ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN source_sort_key text,
  ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'started'
    CHECK (lifecycle_status IN ('started', 'completed')),
  ADD COLUMN lifecycle_rank smallint NOT NULL DEFAULT 0
    CHECK (lifecycle_rank BETWEEN 0 AND 2),
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD CONSTRAINT agent_items_lifecycle_time_ck
    CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at);

UPDATE agent_items item_record
SET created_by_user_id = turn_record.created_by_user_id,
    source_sort_key = COALESCE(item_record.codex_item_id, item_record.id::text)
FROM agent_turns turn_record
WHERE turn_record.id = item_record.turn_id
  AND turn_record.workspace_id = item_record.workspace_id;

ALTER TABLE agent_events
  ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;

UPDATE agent_events event_record
SET created_by_user_id = thread_record.created_by_user_id
FROM agent_threads thread_record
WHERE thread_record.id = event_record.thread_id
  AND thread_record.workspace_id = event_record.workspace_id;

ALTER TABLE tool_calls
  ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;

UPDATE tool_calls call_record
SET created_by_user_id = thread_record.created_by_user_id
FROM agent_threads thread_record
WHERE thread_record.id = call_record.thread_id
  AND thread_record.workspace_id = call_record.workspace_id;

ALTER TABLE approvals
  ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;

UPDATE approvals approval_record
SET created_by_user_id = thread_record.created_by_user_id
FROM agent_threads thread_record
WHERE thread_record.id = approval_record.thread_id
  AND thread_record.workspace_id = approval_record.workspace_id;

ALTER TABLE agent_threads
  ADD CONSTRAINT agent_threads_owner_scope_uq
    UNIQUE (id, workspace_id, created_by_user_id);

ALTER TABLE agent_turns
  ADD CONSTRAINT agent_turns_owner_uq
    UNIQUE (id, workspace_id, created_by_user_id),
  ADD CONSTRAINT agent_turns_owner_scope_uq
    UNIQUE (id, workspace_id, thread_id, created_by_user_id),
  ADD CONSTRAINT agent_turns_owner_scope_fk
    FOREIGN KEY (thread_id, workspace_id, created_by_user_id)
    REFERENCES agent_threads (id, workspace_id, created_by_user_id)
    ON DELETE CASCADE;

ALTER TABLE agent_items
  ADD CONSTRAINT agent_items_owner_scope_uq
    UNIQUE (id, workspace_id, turn_id, created_by_user_id),
  ADD CONSTRAINT agent_items_owner_scope_fk
    FOREIGN KEY (turn_id, workspace_id, created_by_user_id)
    REFERENCES agent_turns (id, workspace_id, created_by_user_id)
    ON DELETE CASCADE;

ALTER TABLE agent_events
  ADD CONSTRAINT agent_events_thread_owner_scope_fk
    FOREIGN KEY (thread_id, workspace_id, created_by_user_id)
    REFERENCES agent_threads (id, workspace_id, created_by_user_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT agent_events_turn_owner_scope_fk
    FOREIGN KEY (turn_id, workspace_id, thread_id, created_by_user_id)
    REFERENCES agent_turns (id, workspace_id, thread_id, created_by_user_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT agent_events_item_owner_scope_fk
    FOREIGN KEY (item_id, workspace_id, turn_id, created_by_user_id)
    REFERENCES agent_items (id, workspace_id, turn_id, created_by_user_id)
    ON DELETE CASCADE;

ALTER TABLE tool_calls
  ADD CONSTRAINT tool_calls_owner_scope_uq
    UNIQUE (id, workspace_id, thread_id, turn_id, created_by_user_id),
  ADD CONSTRAINT tool_calls_thread_owner_scope_fk
    FOREIGN KEY (thread_id, workspace_id, created_by_user_id)
    REFERENCES agent_threads (id, workspace_id, created_by_user_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT tool_calls_turn_owner_scope_fk
    FOREIGN KEY (turn_id, workspace_id, thread_id, created_by_user_id)
    REFERENCES agent_turns (id, workspace_id, thread_id, created_by_user_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT tool_calls_item_owner_scope_fk
    FOREIGN KEY (item_id, workspace_id, turn_id, created_by_user_id)
    REFERENCES agent_items (id, workspace_id, turn_id, created_by_user_id)
    ON DELETE CASCADE;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_thread_owner_scope_fk
    FOREIGN KEY (thread_id, workspace_id, created_by_user_id)
    REFERENCES agent_threads (id, workspace_id, created_by_user_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT approvals_turn_owner_scope_fk
    FOREIGN KEY (turn_id, workspace_id, thread_id, created_by_user_id)
    REFERENCES agent_turns (id, workspace_id, thread_id, created_by_user_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT approvals_tool_owner_scope_fk
    FOREIGN KEY (tool_call_id, workspace_id, thread_id, turn_id, created_by_user_id)
    REFERENCES tool_calls (id, workspace_id, thread_id, turn_id, created_by_user_id)
    ON DELETE SET NULL (tool_call_id);

CREATE INDEX agent_threads_owner_cursor_idx
  ON agent_threads (workspace_id, created_by_user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX agent_turns_owner_sort_idx
  ON agent_turns (workspace_id, created_by_user_id, thread_id, source_sort_key, id);

CREATE INDEX agent_items_owner_sort_idx
  ON agent_items (workspace_id, created_by_user_id, turn_id, source_sort_key, id);

CREATE INDEX agent_events_owner_time_idx
  ON agent_events (workspace_id, created_by_user_id, thread_id, occurred_at, id);

CREATE INDEX tool_calls_owner_turn_idx
  ON tool_calls (workspace_id, created_by_user_id, thread_id, turn_id, requested_at, id);

CREATE INDEX approvals_owner_turn_idx
  ON approvals (workspace_id, created_by_user_id, thread_id, requested_at, id);

COMMENT ON INDEX projects_owner_external_key_uq IS
  'A local project identity is private to one authenticated user even inside a shared workspace.';

COMMENT ON COLUMN agent_turns.source_sort_key IS
  'Stable source-derived ordering key; API pagination never depends on process-local arrival order.';

COMMENT ON COLUMN agent_items.source_sort_key IS
  'Stable source timestamp and Codex item id ordering key, retained across replay and out-of-order delivery.';

COMMENT ON COLUMN agent_events.created_by_user_id IS
  'Authenticated product user that owned the tenant runtime which observed this public App Server event.';

COMMENT ON COLUMN agent_events.source_instance IS
  'Stable authenticated tenant runtime namespace. source_event_id supplies semantic event identity across process restart.';
