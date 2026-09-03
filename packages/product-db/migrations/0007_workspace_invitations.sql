CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_email text NOT NULL,
  requested_role text NOT NULL
    CHECK (requested_role IN ('admin', 'member', 'viewer')),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  token_hash bytea NOT NULL UNIQUE
    CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (target_email = lower(target_email) AND target_email = btrim(target_email)),
  CHECK (expires_at > created_at),
  CHECK (accepted_at IS NULL OR accepted_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX workspace_invitations_pending_idx
  ON workspace_invitations (workspace_id, expires_at, created_at, id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX workspace_invitations_target_pending_idx
  ON workspace_invitations (workspace_id, target_email, expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX workspace_invitations_unresolved_email_uq
  ON workspace_invitations (workspace_id, target_email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE workspace_invitations IS
  'Workspace copy-link invitations. target_email is necessary product PII; token material is hash-only.';

COMMENT ON COLUMN workspace_invitations.target_email IS
  'Canonical target email required to bind acceptance. Expose only to authorized pending-invitation managers.';

COMMENT ON COLUMN workspace_invitations.token_hash IS
  'Domain-separated SHA-256 of a 256-bit opaque token. Raw invitation tokens must never be stored, logged, or audited.';
