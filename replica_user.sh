#!/bin/sh
# Runs once, on first init of the local/CI Postgres container: creates a
# read-only user for replica purposes. Its password comes from the environment
# (Key Vault `saleor-local-db-readonly-password`), never from this file.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
	-v ro_password="$SALEOR_READ_ONLY_PASSWORD" <<'SQL'
CREATE USER saleor_read_only WITH PASSWORD :'ro_password';
GRANT CONNECT ON DATABASE saleor TO saleor_read_only;
GRANT USAGE ON SCHEMA public TO saleor_read_only;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO saleor_read_only;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO saleor_read_only;
SQL
