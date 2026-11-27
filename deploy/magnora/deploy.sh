#!/usr/bin/env bash
# Build and (re)start Magnora on the server. Idempotent.
#   deploy.sh            -> deploy origin/master (override with DEPLOY_BRANCH=main)
#   deploy.sh <git-sha>  -> deploy an exact commit (used by GitHub Actions)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_DIR="$APP_DIR/deploy/magnora"
BRANCH="${DEPLOY_BRANCH:-master}"
REF="${1:-origin/$BRANCH}"

cd "$APP_DIR"
if [ ! -f "$COMPOSE_DIR/.env" ]; then
  echo "Missing $COMPOSE_DIR/.env – copy .env.example and fill it in." >&2
  exit 1
fi

git fetch --prune origin
git checkout --force --detach "$REF"
COMMIT="$(git rev-parse HEAD)"
echo "Deploying $COMMIT"

cd "$COMPOSE_DIR"
export PAPERCLIP_BUILD_COMMIT="$COMMIT"
docker compose --env-file .env build server
docker compose --env-file .env up -d --remove-orphans

# Wait for the new container to report healthy and serve this commit.
DOMAIN="$(grep -E '^PAPERCLIP_DOMAIN=' .env | cut -d= -f2-)"
for attempt in $(seq 1 60); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q server)" 2>/dev/null || echo starting)"
  if [ "$status" = "healthy" ]; then
    served="$(curl -fsS "https://$DOMAIN/api/health" 2>/dev/null | grep -o '"commit":"[0-9a-f]*"' | cut -d'"' -f4 || true)"
    if [ -z "$served" ] || [ "$served" = "$COMMIT" ]; then
      echo "Healthy: https://$DOMAIN (commit ${served:-unknown})"
      docker image prune -f >/dev/null || true
      exit 0
    fi
  fi
  sleep 5
done

echo "Deployment did not become healthy in time. Recent logs:" >&2
docker compose logs --tail 200 server >&2
exit 1
