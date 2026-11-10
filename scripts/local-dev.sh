#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD
local_dir="$root/.local"
pg_bin=${MPOS_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
node_version=22.23.4
node_dir="$local_dir/node-v$node_version-darwin-arm64"
export PATH="$node_dir/bin:$pg_bin:$PATH"
export npm_config_cache="$local_dir/npm-cache"
umask 077
mkdir -p "$local_dir"

db_start() {
  if ! pg_ctl -D "$local_dir/postgres" status >/dev/null 2>&1; then
    pg_ctl -D "$local_dir/postgres" -l "$local_dir/postgres.log" -w start
  fi
}

case "${1:-status}" in
  setup)
    test -x "$pg_bin/initdb" || { echo 'PostgreSQL 17 is required; set MPOS_PG_BIN.' >&2; exit 1; }
    if [ ! -x "$node_dir/bin/node" ]; then
      test "$(uname -s)-$(uname -m)" = Darwin-arm64 || { echo 'Bundled runtime setup supports Apple Silicon macOS.' >&2; exit 1; }
      archive="node-v$node_version-darwin-arm64.tar.gz"
      curl -fSL "https://nodejs.org/dist/v$node_version/$archive" -o "$local_dir/$archive"
      echo "c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428  $local_dir/$archive" | shasum -a 256 -c -
      tar -xzf "$local_dir/$archive" -C "$local_dir"
      rm "$local_dir/$archive"
    fi
    npm ci
    if [ ! -f .env.local ]; then
      cp .env.example .env.local
      app_password=$(openssl rand -hex 24)
      sed -i '' "s/replace-with-local-password/$app_password/" .env.local
    fi
    if [ ! -f "$local_dir/postgres/PG_VERSION" ]; then
      openssl rand -hex 24 > "$local_dir/admin.password"
      initdb -D "$local_dir/postgres" -U mpos_admin --pwfile="$local_dir/admin.password" --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --locale=C
      cat >> "$local_dir/postgres/postgresql.conf" <<'CONF'
listen_addresses = '127.0.0.1'
port = 55432
unix_socket_directories = ''
CONF
    fi
    db_start
    export PGPASSWORD
    PGPASSWORD=$(cat "$local_dir/admin.password")
    if ! psql -h 127.0.0.1 -p 55432 -U mpos_admin -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='mpos_app'" | rg -q 1; then
      app_password=$(sed -n 's/^PGPASSWORD=//p' .env.local)
      psql -h 127.0.0.1 -p 55432 -U mpos_admin -d postgres -v app_password="$app_password" <<'SQL'
CREATE ROLE mpos_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD :'app_password';
SQL
    fi
    if ! psql -h 127.0.0.1 -p 55432 -U mpos_admin -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='mpos'" | rg -q 1; then
      createdb -h 127.0.0.1 -p 55432 -U mpos_admin -O mpos_admin mpos
    fi
    unset PGPASSWORD
    node scripts/local-migrate.mjs
    mkdir -p "$local_dir/product-images"
    echo 'Ready. Run: bash scripts/local-dev.sh start'
    ;;
  migrate)
    db_start
    node scripts/local-migrate.mjs
    ;;
  seed)
    db_start
    node scripts/local-migrate.mjs
    node scripts/local-seed.mjs
    ;;
  start)
    test -f .env.local || { echo 'Run setup first.' >&2; exit 1; }
    db_start
    if [ -f "$local_dir/backend.pid" ] && kill -0 "$(cat "$local_dir/backend.pid")" 2>/dev/null; then
      echo 'Backend already running.'
    else
      nohup node --env-file=.env.local --watch ready-server.js > "$local_dir/backend.log" 2>&1 < /dev/null &
      echo $! > "$local_dir/backend.pid"
      echo "Backend starting: http://127.0.0.1:3000 (PID $!)"
    fi
    for attempt in {1..20}; do
      if curl --fail --silent http://127.0.0.1:3000/api/menu > /dev/null; then
        echo 'Backend and database ready: http://127.0.0.1:3000'
        exit 0
      fi
      sleep 0.5
    done
    echo 'Backend/database check failed. See .local/backend.log and .local/postgres.log.' >&2
    exit 1
    ;;
  stop)
    if [ -f "$local_dir/backend.pid" ]; then
      kill "$(cat "$local_dir/backend.pid")" 2>/dev/null || true
      rm "$local_dir/backend.pid"
    fi
    if pg_ctl -D "$local_dir/postgres" status >/dev/null 2>&1; then
      pg_ctl -D "$local_dir/postgres" -m fast -w stop
    fi
    ;;
  status)
    pg_ctl -D "$local_dir/postgres" status
    curl --fail --silent --show-error http://127.0.0.1:3000/health
    ;;
  test)
    npm test
    ;;
  *) echo 'Usage: bash scripts/local-dev.sh {setup|start|stop|status|migrate|seed|test}' >&2; exit 2 ;;
esac
