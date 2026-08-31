UPDATE users
SET email = lower(btrim(email))
WHERE email <> lower(btrim(email));

ALTER TABLE users
  ADD CONSTRAINT users_email_normalized_ck
  CHECK (
    email = lower(btrim(email))
    AND char_length(email) BETWEEN 3 AND 320
  );

CREATE TABLE password_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL
    CHECK (password_hash ~ '^\$argon2id\$')
    CHECK (octet_length(password_hash) BETWEEN 64 AND 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE auth_sessions
  ADD CONSTRAINT auth_sessions_token_hash_sha256_ck
  CHECK (octet_length(token_hash) = 32) NOT VALID;

ALTER TABLE auth_sessions
  VALIDATE CONSTRAINT auth_sessions_token_hash_sha256_ck;

COMMENT ON COLUMN password_credentials.password_hash IS
  'Argon2id PHC string only; plaintext and reversible password material are forbidden.';

COMMENT ON COLUMN auth_sessions.token_hash IS
  'Exactly the 32-byte SHA-256 digest of an opaque session token; never the token itself.';
