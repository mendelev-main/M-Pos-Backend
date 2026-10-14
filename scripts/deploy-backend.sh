#!/usr/bin/env bash
# Install as /opt/mpos/scripts/deploy-backend.sh (root-owned).
# GitHub passes the full immutable commit SHA; no arbitrary shell arguments.
set -euo pipefail
test "$(id -u)" -eq 0 || { echo 'Run through the configured sudo deployment entrypoint' >&2; exit 1; }
sha=${1:?Pass the full release SHA}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
exec 9>/opt/mpos/deploy.lock
flock -w 600 9
checkout=/opt/mpos/app
compose=/opt/mpos/docker-compose.yml
envfile=/opt/mpos/flyway.env
test -f "$compose" && test -r "$envfile"
git -C "$checkout" diff --quiet
git -C "$checkout" diff --cached --quiet
git -C "$checkout" fetch origin main
git -C "$checkout" merge-base --is-ancestor HEAD origin/main || { echo 'Local-only commits require review' >&2; exit 1; }
git -C "$checkout" merge-base --is-ancestor "$sha" origin/main
# Avoid deploying a queued, obsolete release against a newer migration set.
test "$(git -C "$checkout" rev-parse origin/main)" = "$sha" || { echo 'Release is no longer the main tip; retry the latest deployment' >&2; exit 1; }
staging=$(mktemp -d /opt/mpos/flyway-release.XXXXXXXX)
trap 'rm -rf "$staging"' EXIT
git -C "$checkout" archive "$sha" db/migrations db/flyway-image.txt scripts/prepare-flyway.sh scripts/flyway.sh | tar -x -C "$staging"
network=$(docker inspect --format '{{range $name,$settings := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' mpos-postgres)
test "$(printf '%s\n' "$network" | wc -l)" -eq 1 || { echo 'PostgreSQL has multiple networks; select one explicitly in the deployment script' >&2; exit 1; }
service=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' mpos-backend)
test -n "$service" && test "$service" != '<no value>'
docker compose -f "$compose" config --services | grep -Fx -- "$service" >/dev/null
# Retain the old backend process until Flyway succeeds and the new image builds.
MPOS_FLYWAY_ENV_FILE="$envfile" MPOS_DOCKER_NETWORK="$network" bash "$staging/scripts/flyway.sh" migrate
git -C "$checkout" reset --hard "$sha"
docker compose -f "$compose" build --build-arg "MPOS_BUILD_SHA=$sha" "$service"
docker compose -f "$compose" up -d --no-deps "$service"
test "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' mpos-backend)" = "$sha"
for attempt in {1..20}; do
  if curl --fail --silent --show-error http://127.0.0.1:3000/health && \
     curl --fail --silent --show-error -o /dev/null http://127.0.0.1:3000/api/delivery-tariffs; then exit 0; fi
  sleep 2
done
echo 'New backend health check failed; inspect the service before retrying' >&2
exit 1
