#!/usr/bin/env bash
# Root-owned daily DB backup. Prunes only this script's private backup directory.
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
install -d -o root -g root -m 700 /opt/mpos/privacy-backups
exec 8>/opt/mpos/privacy-backup.lock
flock -w 60 8
file=/opt/mpos/privacy-backups/mpos-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump
tmp=$(mktemp /opt/mpos/privacy-backups/.dump.XXXXXXXX)
trap 'rm -f "$tmp"' EXIT
docker exec mpos-postgres pg_dump -U mpos_admin -d mpos -Fc > "$tmp"
test -s "$tmp"
docker exec -i mpos-postgres pg_restore --list < "$tmp" >/dev/null
mv "$tmp" "$file"
# A successful new backup exists before any expired managed copies are removed.
find /opt/mpos/privacy-backups -xdev -maxdepth 1 -type f -name 'mpos-*.dump' -mmin +43200 -delete
printf 'Private database backup completed: %s\n' "$file"
