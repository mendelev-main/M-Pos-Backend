#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
command=${1:-migrate}
case "$command" in migrate|validate|info) ;; baseline-v3-reviewed) command=baseline ;; *) echo 'Allowed: migrate, validate, info, baseline-v3-reviewed' >&2; exit 2 ;; esac
: "${MPOS_FLYWAY_ENV_FILE:?Set the private Flyway environment file path}"
: "${MPOS_DOCKER_NETWORK:?Set the internal PostgreSQL Docker network}"
test -r "$MPOS_FLYWAY_ENV_FILE"
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
bash "$root/scripts/prepare-flyway.sh" "$root/db/migrations" "$staging/sql"
chmod 755 "$staging/sql"
chmod 644 "$staging/sql/"*.sql
image=$(cat "$root/db/flyway-image.txt")
docker run --rm --network "$MPOS_DOCKER_NETWORK" \
  --env-file "$MPOS_FLYWAY_ENV_FILE" \
  --mount "type=bind,src=$staging/sql,dst=/flyway/sql,readonly" \
  "$image" -locations=filesystem:/flyway/sql -cleanDisabled=true \
  -baselineOnMigrate=false -baselineVersion=3 -validateOnMigrate=true \
  -outOfOrder=false -executeInTransaction=true -connectRetries=10 -lockRetryCount=30 \
  -initSql="SET lock_timeout='5s'; SET statement_timeout='60s'" "$command"
