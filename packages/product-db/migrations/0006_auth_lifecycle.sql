CREATE TABLE auth_login_rate_limits (
  bucket_hash bytea PRIMARY KEY
    CHECK (octet_length(bucket_hash) = 32),
  window_started_at timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0
    CHECK (failed_attempts BETWEEN 0 AND 100),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (blocked_until IS NULL OR blocked_until >= window_started_at)
);

CREATE INDEX auth_login_rate_limits_blocked_idx
  ON auth_login_rate_limits (blocked_until)
  WHERE blocked_until IS NOT NULL;

CREATE INDEX auth_login_rate_limits_updated_idx
  ON auth_login_rate_limits (updated_at, bucket_hash);

COMMENT ON TABLE auth_login_rate_limits IS
  'HMAC-only login abuse buckets shared by Product API processes; raw email, password, session, IP, and User-Agent values are forbidden.';

COMMENT ON COLUMN auth_login_rate_limits.bucket_hash IS
  'Server-secret HMAC-SHA-256 of a domain-separated canonical email or direct socket address; never a raw identifier.';
