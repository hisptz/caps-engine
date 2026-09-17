#!/bin/bash
# Runs inside the dhis2-db container on first startup (via docker-entrypoint-initdb.d).
# Downloads the Sierra Leone demo database and restores it into the 'dhis' database.

set -euo pipefail

DEMO_DB_URL="https://databases.dhis2.org/climate/laos/2.41.7/demo.sql.gz"
DUMP_FILE="/tmp/dhis2-demo.sql.gz"

echo "[dhis2-init] Checking for existing data..."
TABLE_COUNT=$(psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo "0")

if [ "$TABLE_COUNT" -gt "5" ]; then
  echo "[dhis2-init] Database already populated ($TABLE_COUNT tables), skipping restore."
  exit 0
fi

echo "[dhis2-init] Downloading Climate demo database from databases.dhis2.org..."
if ! wget -O  "$DUMP_FILE" "$DEMO_DB_URL"; then
  echo "[dhis2-init] ERROR: Failed to download demo database from $DEMO_DB_URL"
  echo "[dhis2-init] You can manually restore a dump with:"
  echo "  docker cp your-dump.sql.gz <container>:/tmp/dhis2-demo.sql.gz"
  echo "  docker exec <container> sh -c 'gunzip -c /tmp/dhis2-demo.sql.gz | psql -U admin dhis'"
  exit 1
fi

echo "[dhis2-init] Restoring demo database (this may take a few minutes)..."
gunzip -c "$DUMP_FILE" | psql -U "$POSTGRES_USER" "$POSTGRES_DB"

rm -f "$DUMP_FILE"
echo "[dhis2-init] Demo database restored successfully."
