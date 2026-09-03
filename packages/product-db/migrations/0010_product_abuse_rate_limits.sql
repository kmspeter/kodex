CREATE TABLE product_abuse_rate_limits (
  action text NOT NULL
    CHECK (action IN ('register', 'invitation_preview', 'invitation_accept')),
  subject_kind text NOT NULL
    CHECK (subject_kind IN ('address', 'email', 'account', 'token')),
  subject_hash bytea NOT NULL
    CHECK (octet_length(subject_hash) = 32),
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 100),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action, subject_kind, subject_hash),
  CHECK (
    (action = 'register' AND subject_kind IN ('address', 'email'))
    OR (action = 'invitation_preview' AND subject_kind IN ('address', 'token'))
    OR (action = 'invitation_accept' AND subject_kind IN ('account', 'address', 'token'))
  ),
  CHECK (blocked_until IS NULL OR blocked_until >= window_started_at)
);

CREATE INDEX product_abuse_rate_limits_updated_idx
  ON product_abuse_rate_limits (updated_at, action, subject_kind, subject_hash);

COMMENT ON TABLE product_abuse_rate_limits IS
  'HMAC-only register and invitation abuse buckets shared by Product API processes; raw email, direct address, invitation token, user/session identifier, request content, and forwarded header values are forbidden.';

COMMENT ON COLUMN product_abuse_rate_limits.subject_hash IS
  'AUTH_COOKIE_SECRET HMAC-SHA-256 with action-and-kind domain separation; never an invitation-table hash or raw subject.';
