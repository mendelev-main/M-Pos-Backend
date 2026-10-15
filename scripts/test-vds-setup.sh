#!/usr/bin/env bash
# Disposable VDS fixture; refuses to touch an existing /opt/mpos or database container.
set -euo pipefail
test "$(id -u)" -eq 0
test ! -e /opt/mpos && test ! -L /opt/mpos
if docker inspect mpos-postgres >/dev/null 2>&1; then echo 'Existing database container; refusing fixture setup' >&2; exit 1; fi
root=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d)
network=mpos-setup-test-$$
cleanup(){
  docker rm -fv mpos-postgres >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  if [ "$(readlink /opt/mpos)" = "$fixture" ]; then rm /opt/mpos; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
ln -s "$fixture" /opt/mpos
mkdir -p "$fixture/scripts"
printf '#!/bin/bash\nexit 0\n' > "$fixture/scripts/deploy-backend.sh"
printf 'DATABASE_URL=postgresql://fixture-only\n' > "$fixture/backend-db.env"
docker network create "$network" >/dev/null
docker run -d --name mpos-postgres --network "$network" \
  -e POSTGRES_USER=mpos_admin -e POSTGRES_DB=mpos -e POSTGRES_PASSWORD=fixture-only-password \
  postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3 >/dev/null
sql(){ docker exec -i mpos-postgres psql -X -U mpos_admin -d mpos -v ON_ERROR_STOP=1 "$@"; }
for attempt in {1..60}; do
  if docker exec mpos-postgres pg_isready -U mpos_admin -d mpos >/dev/null 2>&1; then break; fi
  sleep 1
done
sql -c 'CREATE ROLE mpos_app' >/dev/null
for file in "$root/db/migrations/00"{1,2,3}_*.sql; do sql < "$file" >/dev/null; done
sql -c "INSERT INTO devices(device_key,name) VALUES('fixture-tablet-key','Fixture tablet'); ALTER TABLE orders ADD COLUMN unexpected_column text" >/dev/null
if bash "$root/scripts/setup-delivery-vds.sh" > "$fixture/mismatch.log" 2>&1; then echo 'Unexpected schema was baselined' >&2; exit 1; fi
test "$(sql -Atc "SELECT to_regclass('public.flyway_schema_history') IS NULL")" = t
sql -c 'ALTER TABLE orders DROP COLUMN unexpected_column' >/dev/null
if ! bash "$root/scripts/setup-delivery-vds.sh" > "$fixture/setup.log" 2>&1; then cat "$fixture/setup.log"; exit 1; fi
test "$(sql -Atc "SELECT count(*) FROM flyway_schema_history WHERE type='BASELINE' AND version='3'")" = 1
test "$(sql -Atc "SELECT count(*) FROM flyway_schema_history WHERE type='SQL' AND version='004' AND success")" = 1
grep -qx 'DELIVERY_TARIFF_DEVICE_KEY=fixture-tablet-key' "$fixture/backend-db.env"
test "$(stat -c %a "$fixture/backend-db.env")" = 600
test "$(stat -c %a "$fixture/flyway.env")" = 600
cmp "$root/scripts/deploy-backend.sh" "$fixture/scripts/deploy-backend.sh"
bash "$fixture/scripts/deploy-backend.sh" --preflight > "$fixture/preflight.log"
if bash "$root/scripts/setup-delivery-vds.sh" > "$fixture/repeat.log" 2>&1; then echo 'Existing history was rebaselined' >&2; exit 1; fi
echo 'VDS setup checks passed: schema mismatch refusal, verified restore, explicit baseline/migration, private tablet binding, repeat refusal.'
