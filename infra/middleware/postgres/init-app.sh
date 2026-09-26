#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$POSTGRES_APP_PASSWORD" <<'SQL'
CREATE ROLE shangjing_app LOGIN PASSWORD :'app_password';
ALTER DATABASE shangjing OWNER TO shangjing_app;
ALTER SCHEMA public OWNER TO shangjing_app;
SQL
