#!/usr/bin/env bash
# Root-only scheduler installation. No change to customer/financial data.
set -euo pipefail
umask 077
test "$(id -u)" -eq 0 || { echo 'Run with sudo' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
command -v systemctl >/dev/null
command -v docker >/dev/null
install -d -o root -g root -m 700 /opt/mpos/privacy-backups
install -o root -g root -m 755 "$root/scripts/backup-privacy-vds.sh" /opt/mpos/scripts/backup-privacy-vds.sh
if [ -e /etc/cron.d/mpos-private-backup ]; then
 grep -Fxq '17 3 * * * root /opt/mpos/scripts/backup-privacy-vds.sh >/dev/null 2>&1' /etc/cron.d/mpos-private-backup || { echo 'Existing cron entry differs; inspect it before replacing' >&2; exit 1; }
 rm /etc/cron.d/mpos-private-backup
fi
cat > /etc/systemd/system/mpos-private-backup.service <<'UNIT'
[Unit]
Description=M POS private PostgreSQL backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=root
UMask=0077
ExecStart=/opt/mpos/scripts/backup-privacy-vds.sh
TimeoutStartSec=1800
UNIT
cat > /etc/systemd/system/mpos-private-backup.timer <<'UNIT'
[Unit]
Description=Daily M POS private PostgreSQL backup

[Timer]
OnCalendar=*-*-* 00:17:00 UTC
Persistent=true
RandomizedDelaySec=300
Unit=mpos-private-backup.service

[Install]
WantedBy=timers.target
UNIT
chmod 644 /etc/systemd/system/mpos-private-backup.service /etc/systemd/system/mpos-private-backup.timer
systemctl daemon-reload
systemctl enable --now mpos-private-backup.timer
systemctl start mpos-private-backup.service
systemctl is-enabled mpos-private-backup.timer
systemctl is-active mpos-private-backup.timer
test "$(systemctl show -p Result --value mpos-private-backup.service)" = success
systemctl list-timers --all --no-pager mpos-private-backup.timer
printf 'Systemd timer enabled and active. Immediate backup succeeded; managed copies retained for 30 days.\n'
