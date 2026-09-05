#!/usr/bin/env bash
set -eu

: "${PRODUCT_DB_APP_USER:?set PRODUCT_DB_APP_USER}"
: "${PRODUCT_DB_APP_PASSWORD:?set PRODUCT_DB_APP_PASSWORD}"
: "${PRODUCT_DB_MIGRATION_USER:?set PRODUCT_DB_MIGRATION_USER}"
: "${PRODUCT_DB_MIGRATION_PASSWORD:?set PRODUCT_DB_MIGRATION_PASSWORD}"

case "$PRODUCT_DB_APP_USER:$PRODUCT_DB_MIGRATION_USER" in
  *[!a-z0-9_:]*) echo "PostgreSQL role names must be simple lowercase identifiers." >&2; exit 1 ;;
esac
if [ "$PRODUCT_DB_APP_USER" = "$PRODUCT_DB_MIGRATION_USER" ]; then
  echo "Application and migration roles must be distinct." >&2
  exit 1
fi

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
  --set=app_role="$PRODUCT_DB_APP_USER" --set=app_password="$PRODUCT_DB_APP_PASSWORD" \
  --set=migration_role="$PRODUCT_DB_MIGRATION_USER" --set=migration_password="$PRODUCT_DB_MIGRATION_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_role', :'app_password') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'migration_role', :'migration_password') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'migration_role') \gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'migration_role') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), :'app_role', :'migration_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'migration_role', :'app_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'migration_role', :'app_role') \gexec
SQL
