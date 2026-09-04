CREATE TABLE password_reset_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE
    CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  delivery_failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (delivery_failed_at IS NULL OR delivery_failed_at >= created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CHECK (delivery_failed_at IS NULL OR revoked_at IS NOT NULL)
);

CREATE UNIQUE INDEX password_reset_requests_pending_user_uq
  ON password_reset_requests (user_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX password_reset_requests_retention_terminal_idx
  ON password_reset_requests (COALESCE(consumed_at, revoked_at, expires_at), id);

COMMENT ON TABLE password_reset_requests IS
  'One-time password recovery requests. Email and raw token material are forbidden; user_id is the only account reference.';

COMMENT ON COLUMN password_reset_requests.token_hash IS
  'Domain-separated SHA-256 of a 256-bit opaque reset token. Raw token and reset URL must never be stored, logged, or audited.';

ALTER TABLE product_abuse_rate_limits
  DROP CONSTRAINT product_abuse_rate_limits_action_check;

ALTER TABLE product_abuse_rate_limits
  ADD CONSTRAINT product_abuse_rate_limits_action_check
  CHECK (action IN (
    'register',
    'invitation_preview',
    'invitation_accept',
    'password_reset_request',
    'password_reset_complete'
  )) NOT VALID;

ALTER TABLE product_abuse_rate_limits
  VALIDATE CONSTRAINT product_abuse_rate_limits_action_check;

ALTER TABLE product_abuse_rate_limits
  DROP CONSTRAINT product_abuse_rate_limits_check;

ALTER TABLE product_abuse_rate_limits
  ADD CONSTRAINT product_abuse_rate_limits_check
  CHECK (
    (action = 'register' AND subject_kind IN ('address', 'email'))
    OR (action = 'invitation_preview' AND subject_kind IN ('address', 'token'))
    OR (action = 'invitation_accept' AND subject_kind IN ('account', 'address', 'token'))
    OR (action = 'password_reset_request' AND subject_kind IN ('address', 'email'))
    OR (action = 'password_reset_complete' AND subject_kind IN ('address', 'token'))
  ) NOT VALID;

ALTER TABLE product_abuse_rate_limits
  VALIDATE CONSTRAINT product_abuse_rate_limits_check;

COMMENT ON TABLE product_abuse_rate_limits IS
  'HMAC-only registration, invitation, and password-reset abuse buckets shared by Product API processes; raw email, direct address, token, user/session identifier, request content, and forwarded header values are forbidden.';
