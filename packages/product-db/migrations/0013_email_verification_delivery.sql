-- Every account created before this migration has already been allowed to sign in.
-- Preserve that contract while new verification-enabled registrations explicitly
-- leave this column NULL until their one-time token is consumed.
UPDATE users
SET email_verified_at = created_at
WHERE email_verified_at IS NULL;

CREATE TABLE email_verification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivery_job_id uuid,
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

CREATE UNIQUE INDEX email_verification_requests_pending_user_uq
  ON email_verification_requests (user_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX email_verification_requests_retention_terminal_idx
  ON email_verification_requests (COALESCE(consumed_at, revoked_at, expires_at), id);

CREATE TABLE email_delivery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('email_verification', 'workspace_invitation')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  invitation_id uuid REFERENCES workspace_invitations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'retry', 'delivered', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text CHECK (lease_owner IS NULL OR octet_length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code IN ('provider_failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (kind = 'email_verification' AND user_id IS NOT NULL AND invitation_id IS NULL)
    OR
    (kind = 'workspace_invitation' AND user_id IS NULL AND invitation_id IS NOT NULL)
  ),
  CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status IN ('delivered', 'failed', 'cancelled')) = (completed_at IS NOT NULL)
  )
);

ALTER TABLE email_verification_requests
  ADD CONSTRAINT email_verification_requests_delivery_job_fk
  FOREIGN KEY (delivery_job_id) REFERENCES email_delivery_jobs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX email_delivery_jobs_open_verification_uq
  ON email_delivery_jobs (user_id)
  WHERE kind = 'email_verification' AND status IN ('pending', 'running', 'retry');

CREATE UNIQUE INDEX email_delivery_jobs_open_invitation_uq
  ON email_delivery_jobs (invitation_id)
  WHERE kind = 'workspace_invitation' AND status IN ('pending', 'running', 'retry');

CREATE INDEX email_delivery_jobs_claim_idx
  ON email_delivery_jobs (available_at, created_at, id)
  WHERE status IN ('pending', 'running', 'retry');

CREATE INDEX email_delivery_jobs_retention_terminal_idx
  ON email_delivery_jobs (completed_at, id)
  WHERE status IN ('delivered', 'failed', 'cancelled');

COMMENT ON COLUMN users.email_verified_at IS
  'NULL only for a new account whose email ownership has not been verified; migration 0013 backfills every existing account.';

COMMENT ON TABLE email_verification_requests IS
  'Hash-only, single-use email ownership proofs. Raw tokens and verification URLs are forbidden.';

COMMENT ON COLUMN email_verification_requests.token_hash IS
  'Domain-separated SHA-256 of a canonical 256-bit token. Raw token material must never be stored, logged, or audited.';

COMMENT ON TABLE email_delivery_jobs IS
  'Durable, payload-free webhook delivery state. Email addresses, URLs, tokens, request bodies, and provider responses are forbidden.';

ALTER TABLE product_abuse_rate_limits
  DROP CONSTRAINT product_abuse_rate_limits_action_check;

ALTER TABLE product_abuse_rate_limits
  ADD CONSTRAINT product_abuse_rate_limits_action_check
  CHECK (action IN (
    'register',
    'invitation_preview',
    'invitation_accept',
    'password_reset_request',
    'password_reset_complete',
    'email_verification_resend',
    'email_verification_complete'
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
    OR (action = 'email_verification_resend' AND subject_kind IN ('account', 'address'))
    OR (action = 'email_verification_complete' AND subject_kind IN ('address', 'token'))
  ) NOT VALID;

ALTER TABLE product_abuse_rate_limits
  VALIDATE CONSTRAINT product_abuse_rate_limits_check;

COMMENT ON TABLE product_abuse_rate_limits IS
  'HMAC-only registration, invitation, password-reset, and email-verification abuse buckets shared by Product API processes; raw identifiers and tokens are forbidden.';
