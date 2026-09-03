CREATE INDEX auth_sessions_retention_terminal_idx
  ON auth_sessions (COALESCE(revoked_at, expires_at), id);

CREATE INDEX workspace_invitations_retention_terminal_idx
  ON workspace_invitations (COALESCE(accepted_at, revoked_at, expires_at), id);

COMMENT ON INDEX auth_sessions_retention_terminal_idx IS
  'Bounded oldest-first cleanup of sessions after revocation, or expiry when never revoked.';

COMMENT ON INDEX workspace_invitations_retention_terminal_idx IS
  'Bounded oldest-first cleanup of accepted, revoked, or expired invitations.';
