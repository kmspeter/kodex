CREATE INDEX workspace_members_workspace_joined_idx
  ON workspace_members (workspace_id, joined_at, user_id);

CREATE INDEX workspace_invitations_pending_created_idx
  ON workspace_invitations (workspace_id, created_at, id)
  INCLUDE (expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMENT ON INDEX workspace_members_workspace_joined_idx IS
  'Stable keyset order for bounded workspace member pages.';

COMMENT ON INDEX workspace_invitations_pending_created_idx IS
  'Stable keyset order for bounded active pending invitation pages.';
