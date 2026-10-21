#!/usr/bin/env bash
#
# deploy_prod.sh - deploy the BlindsCloud backend on the VPS
# -----------------------------------------------------------------------------
# Pulls the latest images published to GHCR and restarts the production stack.
#
# FIXES vs the previous version
#   1. `docker compose down` used the DEFAULT compose file (docker-compose.yml),
#      so it tore down the DEVELOPMENT stack definition instead of production.
#      It now always uses docker-compose.prod.yml.
#   2. Waits for the gateway to actually answer /health before declaring success.
#   3. Installs / refreshes the nightly mongodump cron entry.
#   4. Runs a backup immediately after deploying, so a bad deploy is always
#      recoverable.
#   5. NEVER uses `down -v` - the named volumes (mongo-data, uploads-data) hold
#      all production data and must survive a deploy.
#
# USAGE
#   cd /opt/blindscloud/Backend
#   ./scripts/deploy_prod.sh
#
# The GitHub Actions workflow (.github/workflows/docker-publish.yml) builds and
# pushes the images on every push to main. This script only pulls and restarts.
# -----------------------------------------------------------------------------
set -euo pipefail

cd /opt/blindscloud/Backend

COMPOSE_FILE="docker-compose.prod.yml"
BACKUP_SCRIPT="/opt/blindscloud/Backend/scripts/backup-mongo.sh"
CRON_LOG="/var/log/blindscloud-backup.log"
CRON_SCHEDULE="30 3 * * *"

log() { printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# --------------------------------------------------------------------------
# Cron
# --------------------------------------------------------------------------
install_backup_cron() {
  if ! command -v crontab >/dev/null 2>&1; then
    echo "  WARNING: crontab is not installed - skipping cron setup."
    echo "  Install it with: apt-get install -y cron && systemctl enable cron"
    return 0
  fi

  local cron_line="$CRON_SCHEDULE $BACKUP_SCRIPT >> $CRON_LOG 2>&1"
  local current existing_lines

  current="$(crontab -l 2>/dev/null || true)"

  if printf '%s\n' "$current" | grep -Fq "backup-mongo.sh"; then
    # Replace any previous backup-mongo entry so the schedule/log path stay in sync.
    existing_lines="$(printf '%s\n' "$current" | grep -v 'backup-mongo.sh' || true)"
    printf '%s\n%s\n' "$existing_lines" "$cron_line" | sed '/^$/d' | crontab -
    echo "  Updated existing backup cron entry."
  else
    { printf '%s\n' "$current"; printf '%s\n' "$cron_line"; } | sed '/^$/d' | crontab -
    echo "  Installed new backup cron entry."
  fi

  # Make sure the script is executable and the log file is writable by cron.
  chmod +x "$BACKUP_SCRIPT" 2>/dev/null || true
  touch "$CRON_LOG" 2>/dev/null || true

  echo "  Cron now contains:"
  crontab -l 2>/dev/null | grep 'backup-mongo.sh' | sed 's/^/    /'
}

# --------------------------------------------------------------------------
# Deploy
# --------------------------------------------------------------------------
log "1/5  Stopping the current production stack"
# NOTE: no `-v`. The named volumes mongo-data and uploads-data hold all
# production data and must survive the deploy.
docker compose -f "$COMPOSE_FILE" down

log "2/5  Pulling the latest images"
docker compose -f "$COMPOSE_FILE" pull

log "3/5  Starting the new stack"
docker compose -f "$COMPOSE_FILE" up -d

log "4/5  Waiting for the api-gateway to become healthy"
GATEWAY_URL="http://localhost:3001/health"
READY=0
for i in $(seq 1 60); do
  if curl -fsS --max-time 3 "$GATEWAY_URL" >/dev/null 2>&1; then
    echo "  Gateway healthy after ${i}s"
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "  ERROR: the gateway did not become healthy within 60s."
  echo "  Recent logs:"
  docker compose -f "$COMPOSE_FILE" logs --tail 40 api-gateway | sed 's/^/    /'
  exit 1
fi

log "5/5  Ensuring the nightly backup is scheduled"
install_backup_cron

log "Running a backup now (so this deploy is always recoverable)"
if bash "$BACKUP_SCRIPT"; then
  echo "  Backup OK"
else
  echo "  WARNING: the backup failed - check $CRON_LOG"
fi

log "Deploy complete"
docker compose -f "$COMPOSE_FILE" ps
echo
echo "Quick health check:"
curl -fsS --max-time 5 http://localhost:3001/health && echo
