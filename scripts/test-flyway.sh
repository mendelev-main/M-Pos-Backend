#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
name=mpos-flyway-test-$$
network=$name
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || true; docker network rm "$network" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
docker network create "$network" >/dev/null
docker run -d --name "$name" --network "$network" --network-alias db \
  -e POSTGRES_DB=mpos -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3 >/dev/null
for attempt in {1..30}; do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -d mpos >/dev/null; then break; fi
  sleep 1
done
sql(){ docker exec -i "$name" psql -X -U postgres -d "${database:-mpos}" -v ON_ERROR_STOP=1 "$@"; }
sql -c 'CREATE ROLE mpos_app;'
cat > "$tmp/flyway.env" <<'ENV'
FLYWAY_URL=jdbc:postgresql://db:5432/mpos
FLYWAY_USER=postgres
ENV
export MPOS_FLYWAY_ENV_FILE="$tmp/flyway.env" MPOS_DOCKER_NETWORK="$network"
bash "$root/scripts/flyway.sh" migrate
bash "$root/scripts/flyway.sh" migrate
bash "$root/scripts/flyway.sh" validate
test "$(sql -Atc "SELECT count(*) FROM flyway_schema_history WHERE success AND type='SQL'")" = 8
test "$(sql -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='orders' AND column_name LIKE 'delivery_tariff_%'")" = 3

# A nonempty legacy database must refuse automatic baseline, then apply only 004
# after an explicit reviewed baseline at version 3.
sql -c 'CREATE DATABASE legacy;'
database=legacy
for file in "$root/db/migrations/00"{1,2,3}_*.sql; do sql < "$file" >/dev/null; done
sed -i 's@/mpos$@/legacy@' "$tmp/flyway.env"
if bash "$root/scripts/flyway.sh" migrate > "$tmp/unbaselined.log" 2>&1; then echo 'Unsafe automatic baseline' >&2; exit 1; fi
bash "$root/scripts/flyway.sh" baseline-v3-reviewed
bash "$root/scripts/flyway.sh" migrate
test "$(sql -Atc "SELECT count(*) FROM flyway_schema_history WHERE success AND type='SQL'")" = 5

# A changed applied migration fails validation; no automatic repair is allowed.
mkdir -p "$tmp/release/scripts" "$tmp/release/db/migrations"
cp "$root/scripts/flyway.sh" "$root/scripts/prepare-flyway.sh" "$tmp/release/scripts/"
cp "$root/db/flyway-image.txt" "$tmp/release/db/"
cp "$root/db/migrations/"*.sql "$tmp/release/db/migrations/"
sed -i 's/Delivery tariffs/Changed delivery tariffs/' "$tmp/release/db/migrations/004_delivery_tariffs.sql"
if bash "$tmp/release/scripts/flyway.sh" validate > "$tmp/checksum.log" 2>&1; then echo 'Checksum mismatch was accepted' >&2; exit 1; fi
cp "$root/db/migrations/004_delivery_tariffs.sql" "$tmp/release/db/migrations/"
printf 'BEGIN;\nCREATE TABLE rollback_probe(id integer);\nSELECT 1/0;\nCOMMIT;\n' > "$tmp/release/db/migrations/009_failure.sql"
if bash "$tmp/release/scripts/flyway.sh" migrate > "$tmp/failure.log" 2>&1; then echo 'Broken migration succeeded' >&2; exit 1; fi
test "$(sql -Atc "SELECT to_regclass('public.rollback_probe') IS NULL")" = t
test "$(sql -Atc "SELECT count(*) FROM flyway_schema_history WHERE version='009'")" = 0
echo 'Flyway/PostgreSQL checks passed: fresh DB, repeat, legacy baseline, checksum rejection, transactional rollback.'
