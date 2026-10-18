#!/usr/bin/env bash
# One-time sudo step after release deployment; prints counts, never customer data.
set -euo pipefail
umask 077
test "$(id -u)" -eq 0 || { echo 'Run with sudo' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
exec 9>/opt/mpos/deploy.lock
flock -w 60 9
sql(){ docker exec -i mpos-postgres psql -X -U mpos_admin -d mpos -v ON_ERROR_STOP=1 "$@"; }
test "$(sql -Atc "SELECT count(*) FROM public.flyway_schema_history WHERE success AND version='005'")" = 1
sql -c 'SELECT public.privacy_retention_report() AS before_setup;'
install -o root -g root -m 755 "$root/scripts/backup-privacy-vds.sh" /opt/mpos/scripts/backup-privacy-vds.sh
bash /opt/mpos/scripts/backup-privacy-vds.sh
backup=$(find /opt/mpos/privacy-backups -maxdepth 1 -type f -name 'mpos-*.dump' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d ' ' -f 2-)
test -s "$backup"
# Full restore check in a disposable cluster, isolated from all networks.
audit=mpos-privacy-audit-$$
cleanup(){ docker rm -fv "$audit" >/dev/null 2>&1 || true; }
trap cleanup EXIT
image=$(docker inspect --format '{{.Image}}' mpos-postgres)
docker run -d --name "$audit" --network none -e POSTGRES_USER=mpos_admin -e POSTGRES_DB=restore_check -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null
ready=false
for attempt in {1..60}; do
 if docker exec "$audit" pg_isready -U mpos_admin -d restore_check >/dev/null 2>&1; then ready=true; break; fi
 sleep 1
done
$ready || { echo 'Restore check did not start; contact deletion remains unchanged' >&2; exit 1; }
docker exec -i "$audit" pg_restore -U mpos_admin -d restore_check --exit-on-error --no-owner --no-privileges < "$backup" >/dev/null
# No sale, ledger, item, payment or stock row is removed by contact cleanup.
bash "$root/scripts/setup-privacy-backup-timer.sh"
sql -c "UPDATE public.privacy_retention_state SET apply_order_contacts=true WHERE id=true;"
sql -c 'SELECT public.run_privacy_retention(true) AS maintenance;'
printf 'Setup complete. Full restore verified. Daily managed backups retained for 30 days.\nContact deletion enabled. Older backup folders, downloaded tablet backups and Telegram histories require separate operator review.\n'
