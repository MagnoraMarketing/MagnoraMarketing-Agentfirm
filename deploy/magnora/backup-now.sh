#!/usr/bin/env bash
# On-demand database backup (in addition to the automatic daily backup and
# Supabase's own backups). Writes into the paperclip-data volume.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
docker compose --env-file .env exec -T server node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts db:backup --dir /paperclip/backups
docker compose --env-file .env exec -T server ls -lh /paperclip/backups | tail -5
