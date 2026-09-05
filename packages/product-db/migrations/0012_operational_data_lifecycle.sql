ALTER TABLE users
  ADD COLUMN deletion_requested_at timestamptz;

ALTER TABLE workspaces
  ADD COLUMN purge_requested_at timestamptz;

ALTER TABLE projects
  ADD CONSTRAINT projects_lifecycle_owner_scope_uq
    UNIQUE (id, workspace_id, created_by_user_id);

ALTER TABLE agent_threads
  ADD CONSTRAINT agent_threads_lifecycle_project_owner_scope_fk
    FOREIGN KEY (project_id, workspace_id, created_by_user_id)
    REFERENCES projects (id, workspace_id, created_by_user_id)
    ON DELETE CASCADE
    NOT VALID;

CREATE TABLE data_legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('user', 'workspace')),
  target_user_id uuid,
  target_workspace_id uuid,
  reason_code text NOT NULL
    CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CHECK (
    (target_type = 'user' AND target_user_id IS NOT NULL AND target_workspace_id IS NULL)
    OR
    (target_type = 'workspace' AND target_user_id IS NULL AND target_workspace_id IS NOT NULL)
  ),
  CHECK (released_at IS NULL OR released_at >= created_at)
);

CREATE UNIQUE INDEX data_legal_holds_active_user_uq
  ON data_legal_holds (target_user_id)
  WHERE target_type = 'user' AND released_at IS NULL;

CREATE UNIQUE INDEX data_legal_holds_active_workspace_uq
  ON data_legal_holds (target_workspace_id)
  WHERE target_type = 'workspace' AND released_at IS NULL;

CREATE TABLE data_lifecycle_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('user_export', 'account_delete', 'workspace_delete')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'running', 'waiting_local', 'blocked_legal_hold', 'completed', 'failed'
    )),
  requested_by_user_id uuid NOT NULL,
  target_user_id uuid,
  target_workspace_id uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text CHECK (lease_owner IS NULL OR octet_length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (kind IN ('user_export', 'account_delete') AND target_user_id IS NOT NULL AND target_workspace_id IS NULL)
    OR
    (kind = 'workspace_delete' AND target_user_id IS NULL AND target_workspace_id IS NOT NULL)
  ),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE UNIQUE INDEX data_lifecycle_jobs_open_user_uq
  ON data_lifecycle_jobs (kind, target_user_id)
  WHERE target_user_id IS NOT NULL AND status NOT IN ('completed', 'failed');

CREATE UNIQUE INDEX data_lifecycle_jobs_open_workspace_uq
  ON data_lifecycle_jobs (kind, target_workspace_id)
  WHERE target_workspace_id IS NOT NULL AND status NOT IN ('completed', 'failed');

CREATE INDEX data_lifecycle_jobs_claim_idx
  ON data_lifecycle_jobs (available_at, created_at, id)
  WHERE status IN ('pending', 'running');

CREATE TABLE data_lifecycle_job_workspaces (
  job_id uuid NOT NULL REFERENCES data_lifecycle_jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  PRIMARY KEY (job_id, workspace_id)
);

COMMENT ON TABLE data_lifecycle_job_workspaces IS
  'Payload-free account-deletion workspace scope retained after application rows are removed for late Local Server reconciliation.';

CREATE TABLE data_lifecycle_local_tenants (
  installation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, user_id, workspace_id)
);

CREATE INDEX data_lifecycle_local_tenants_workspace_idx
  ON data_lifecycle_local_tenants (workspace_id, installation_id, user_id);

CREATE INDEX data_lifecycle_local_tenants_user_idx
  ON data_lifecycle_local_tenants (user_id, installation_id, workspace_id);

CREATE TABLE data_lifecycle_local_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES data_lifecycle_jobs(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'blocked_legal_hold', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text CHECK (lease_owner IS NULL OR octet_length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (job_id, installation_id, user_id, workspace_id),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX data_lifecycle_local_targets_claim_idx
  ON data_lifecycle_local_targets (installation_id, available_at, created_at, id)
  WHERE status IN ('pending', 'running');

CREATE INDEX data_lifecycle_local_targets_job_status_idx
  ON data_lifecycle_local_targets (job_id, status, id);

CREATE TABLE data_export_artifacts (
  job_id uuid PRIMARY KEY REFERENCES data_lifecycle_jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  document jsonb NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 2 AND 16777216),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX data_export_artifacts_user_expiry_idx
  ON data_export_artifacts (user_id, expires_at, job_id);

COMMENT ON TABLE data_lifecycle_jobs IS
  'Payload-free durable export and deletion state. Target UUIDs are retained only as bounded reconciliation identifiers.';

COMMENT ON TABLE data_lifecycle_local_tenants IS
  'Path-free registry of exact tenant scopes observed on a Local Server installation. Absolute paths are forbidden.';

COMMENT ON TABLE data_lifecycle_local_targets IS
  'Durable per-installation filesystem cleanup acknowledgements claimed with bounded leases.';

COMMENT ON TABLE data_export_artifacts IS
  'Bounded user export JSON. Authentication/session/reset/invitation hashes, password material, provider credentials, and embedding vectors are forbidden.';

COMMENT ON TABLE data_legal_holds IS
  'Operator-controlled deletion holds. A hold blocks both application-row deletion and matching Local Server filesystem cleanup.';
