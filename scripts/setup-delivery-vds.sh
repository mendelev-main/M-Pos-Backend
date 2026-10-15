#!/usr/bin/env bash
# One-time, interactive sudo setup. Does not deploy/restart the application.
# Run from an immutable, reviewed release archive, outside /opt/mpos/app.
set -euo pipefail
umask 077
test "$(id -u)" -eq 0 || { echo 'Run this one-time setup with sudo' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
test "$root" != /opt/mpos/app || { echo 'Use a separate reviewed release archive' >&2; exit 1; }
for command in docker python3 flock diff; do command -v "$command" >/dev/null; done
exec 9>/opt/mpos/deploy.lock
flock -w 60 9
sql(){ docker exec -i mpos-postgres psql -X -U mpos_admin -d mpos -v ON_ERROR_STOP=1 "$@"; }
test "$(sql -Atc "SELECT to_regclass('public.flyway_schema_history') IS NULL")" = t || { echo 'Flyway history already exists; inspect it instead of rebaselining' >&2; exit 1; }
source_id=${1:-}
if [ -z "$source_id" ]; then
  test "$(sql -Atc 'SELECT count(*) FROM public.devices WHERE is_active')" = 1 || {
    echo 'Choose the tablet ID, then pass that UUID to this script. No keys are printed.' >&2
    sql -c 'SELECT id,name,last_sync_at FROM public.devices WHERE is_active ORDER BY last_sync_at DESC NULLS LAST'
    exit 1
  }
  source_id=$(sql -Atc 'SELECT id FROM public.devices WHERE is_active')
fi
[[ "$source_id" =~ ^[0-9a-fA-F-]{36}$ ]] || exit 2
test "$(sql -Atc "SELECT count(*) FROM public.devices WHERE id='$source_id'::uuid AND is_active")" = 1
# Store the backup privately; never copy application/customer data into Git or CI.
backup=$(mktemp -d /opt/mpos/delivery-backup.XXXXXXXX)
chmod 700 "$backup"
docker exec mpos-postgres pg_dump -U mpos_admin -d mpos -Fc > "$backup/mpos.dump"
test -s "$backup/mpos.dump"
cp -p /opt/mpos/scripts/deploy-backend.sh "$backup/deploy-backend.sh"
cp -p /opt/mpos/backend-db.env "$backup/backend-db.env"
if [ -e /opt/mpos/flyway.env ]; then cp -p /opt/mpos/flyway.env "$backup/flyway.env"; fi
# Verify restore and schema in a disposable cluster with no network or host port.
audit=mpos-delivery-audit-$$
cleanup(){ docker rm -fv "$audit" >/dev/null 2>&1 || true; }
trap cleanup EXIT
image=$(docker inspect --format '{{.Image}}' mpos-postgres)
docker run -d --name "$audit" --network none -e POSTGRES_USER=mpos_admin -e POSTGRES_DB=mpos -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null
ready=false
for attempt in {1..60}; do
  if docker exec "$audit" pg_isready -U mpos_admin -d mpos >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
$ready || { echo 'Audit PostgreSQL did not start' >&2; exit 1; }
audit_sql(){ docker exec -i "$audit" psql -X -U mpos_admin -d mpos -v ON_ERROR_STOP=1 "$@"; }
audit_sql -c 'CREATE ROLE mpos_app' >/dev/null
for file in "$root/db/migrations/00"{1,2,3}_*.sql; do audit_sql < "$file" >/dev/null; done
normalize(){ sed '/^--/d; /^\\restrict /d; /^\\unrestrict /d; /^[[:space:]]*$/d'; }
docker exec "$audit" pg_dump -U mpos_admin -d mpos --schema-only --schema=public --no-owner --no-privileges --no-comments | normalize > "$backup/expected-schema.sql"
docker exec mpos-postgres pg_dump -U mpos_admin -d mpos --schema-only --schema=public --no-owner --no-privileges --no-comments | normalize > "$backup/live-schema.sql"
if ! diff -u "$backup/expected-schema.sql" "$backup/live-schema.sql" > "$backup/schema.diff"; then
  echo "Live schema differs from migrations 001–003. No baseline/migration applied. Inspect $backup/schema.diff privately." >&2
  exit 1
fi
# Check ownership and the two singleton defaults that schema-only dumps omit.
test "$(sql -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner<>'mpos_admin'")" = 0
test "$(sql -Atc "SELECT count(*) FROM public.owner_auth_state WHERE id")" = 1
test "$(sql -Atc "SELECT count(*) FROM public.customer_notification_settings WHERE id AND enabled_at IS NOT NULL")" = 1
audit_sql -c 'CREATE DATABASE restore_check' >/dev/null
docker exec -i "$audit" pg_restore -U mpos_admin -d restore_check --exit-on-error --no-owner --no-privileges < "$backup/mpos.dump" > "$backup/restore.log" 2>&1
# Read the existing credential internally, without printing it or changing DB roles.
python3 - <<'PY'
import os,subprocess
from pathlib import Path

def env(name):
    return subprocess.check_output(['docker','exec','mpos-postgres','printenv',name],text=True).rstrip('\n')
user,password,database=env('POSTGRES_USER'),env('POSTGRES_PASSWORD'),env('POSTGRES_DB')
if user!='mpos_admin' or database!='mpos' or not password or '\n' in password or '\r' in password:
    raise SystemExit('Unexpected database environment; configure Flyway credentials explicitly')
p=Path('/opt/mpos/flyway.env')
# File is private even on first creation; never log its content.
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:
    f.write('FLYWAY_URL=jdbc:postgresql://mpos-postgres:5432/mpos\nFLYWAY_USER=mpos_admin\nFLYWAY_PASSWORD='+password+'\n')
os.chmod(p,0o600)
PY
network=$(docker inspect --format '{{range $name,$settings := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' mpos-postgres)
test "$(printf '%s\n' "$network" | wc -l)" -eq 1
export MPOS_FLYWAY_ENV_FILE=/opt/mpos/flyway.env MPOS_DOCKER_NETWORK="$network"
bash "$root/scripts/flyway.sh" baseline-v3-reviewed
bash "$root/scripts/flyway.sh" migrate
bash "$root/scripts/flyway.sh" validate
# Use the registered tablet key without showing it to the terminal or chat.
python3 - "$source_id" <<'PY'
import os,subprocess,sys
from pathlib import Path
source=sys.argv[1]
key=subprocess.check_output(['docker','exec','mpos-postgres','psql','-X','-U','mpos_admin','-d','mpos','-Atc',"SELECT device_key FROM public.devices WHERE is_active AND id='"+source+"'::uuid"],text=True).rstrip('\n')
if not key or any(c in key for c in '\n\r'):
    raise SystemExit('Tablet key must be nonempty and single-line')
p=Path('/opt/mpos/backend-db.env')
lines=[line for line in p.read_text().splitlines() if not line.startswith('DELIVERY_TARIFF_DEVICE_KEY=')]
tmp=p.with_name('backend-db.env.delivery-new')
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:
    f.write('\n'.join(lines)+'\nDELIVERY_TARIFF_DEVICE_KEY='+key+'\n')
os.replace(tmp,p)
PY
install -o root -g root -m 755 "$root/scripts/deploy-backend.sh" /opt/mpos/scripts/deploy-backend.sh
# The existing restricted entrypoint uses root Git; trust only this deployment path.
git config --global --add safe.directory /opt/mpos/app
printf 'Setup complete. Private verified backup: %s\nApplication was not restarted. Merge the reviewed release and run its normal deployment.\n' "$backup"
