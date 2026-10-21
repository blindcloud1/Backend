#!/usr/bin/env bash
#
# backup-mongo.sh - scheduled backup for BlindsCloud
# -----------------------------------------------------------------------------
# Dumps the MongoDB database(s) and the uploaded-files volume, then prunes old
# backups.
#
# Installed on cron by scripts/deploy_prod.sh:
#     30 3 * * * /opt/blindscloud/Backend/scripts/backup-mongo.sh >> /var/log/blindscloud-backup.log 2>&1
#
# CONFIG (all optional, override via env or crontab)
#   BACKUP_ROOT        where dumps are written        default /opt/blindscloud/backups
#   RETENTION_DAYS     how long to keep backups       default 14
#   MONGO_CONTAINER    mongo container name           default blindscloud-mongo
#   MONGO_USER         mongo username                 default admin
#   MONGO_PASSWORD     mongo password                 default: read from the container
#   MONGO_DATABASES    databases to dump              default "blindscloud admin"
#   FILES_CONTAINER    files container name           default blindscloud-files-service
#   UPLOADS_PATH       uploads dir inside container   default /data/uploads
#   BACKUP_UPLOADS     set to false to skip files     default true
#   RCLONE_REMOTE      e.g. "b2:mybucket/backups"     default (offsite copy disabled)
#
# Why the dump is written inside the container and copied out with `docker cp`
# rather than streamed through a shell redirect:
#   * shell redirection of binary data is fragile (MSYS/Cygwin mangles it, and
#     a partial write leaves a corrupt archive on disk)
#   * `docker cp` gives us an atomic-ish file and a verifiable size
#
# The mongo password is read from the RUNNING container rather than from .env,
# because MONGO_INITDB_ROOT_PASSWORD is only applied on first initialisation of
# an empty volume - the .env value can drift from the real one.
# -----------------------------------------------------------------------------
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/opt/blindscloud/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
MONGO_CONTAINER="${MONGO_CONTAINER:-blindscloud-mongo}"
MONGO_USER="${MONGO_USER:-admin}"
MONGO_DB="${MONGO_DB:-blindscloud}"
BACKUP_ADMIN_DB="${BACKUP_ADMIN_DB:-true}"
FILES_CONTAINER="${FILES_CONTAINER:-blindscloud-files-service}"
UPLOADS_PATH="${UPLOADS_PATH:-/data/uploads}"
BACKUP_UPLOADS="${BACKUP_UPLOADS:-true}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
VERIFY_RESTORE="${VERIFY_RESTORE:-true}"
RESTORE_CHECK_DB="blindscloud_restore_check"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# --------------------------------------------------------------------------
# Preflight
# --------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed"

if ! docker ps --format '{{.Names}}' | grep -qx "$MONGO_CONTAINER"; then
  die "mongo container '$MONGO_CONTAINER' is not running"
fi

if [ -z "${MONGO_PASSWORD:-}" ]; then
  MONGO_PASSWORD="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$MONGO_CONTAINER" \
    | grep -m1 '^MONGO_INITDB_ROOT_PASSWORD=' | cut -d= -f2- || true)"
fi
[ -n "$MONGO_PASSWORD" ] || die "could not determine the mongo password for user '$MONGO_USER'"

mkdir -p "$BACKUP_ROOT"

STAMP="$(date +%Y-%m-%d-%H%M%S)"
MONGO_FILE="$BACKUP_ROOT/blindscloud-mongo-$STAMP.gz"
FILES_FILE="$BACKUP_ROOT/blindscloud-uploads-$STAMP.tar.gz"
LATEST_LINK="$BACKUP_ROOT/latest-mongo.gz"
CONTAINER_DUMP="/tmp/blindscloud-backup.gz"
CONTAINER_ADMIN_DUMP="/tmp/blindscloud-backup-admin.gz"

# --------------------------------------------------------------------------
# 1. MongoDB dump
# --------------------------------------------------------------------------
# mongodump only dumps the database named in the --uri path when --archive is
# used (the --db flag is ignored in that mode). So we run one dump per database.
#   blindscloud -> all application data
#   admin       -> mongo's own system.users (the root user we connect with)
log "Dumping MongoDB database '$MONGO_DB' from '$MONGO_CONTAINER'"

# The connection URI is handed to the container over stdin so the password never
# appears in any process argument list.
MONGO_URI="mongodb://${MONGO_USER}:${MONGO_PASSWORD}@localhost:27017/${MONGO_DB}"

printf '%s' "$MONGO_URI" | docker exec -i "$MONGO_CONTAINER" sh -c '
  read -r MONGODB_URI
  mongodump --uri "$MONGODB_URI" --authenticationDatabase admin --archive='"$CONTAINER_DUMP"' --gzip
' || die "mongodump failed"

# --- verify the dump is actually restorable, while it is still in the container ---
# MongoDB's --archive format is NOT a POSIX tar, so `tar -tzf` cannot inspect it.
# The only meaningful check is a real restore, so we restore into a scratch
# database and count the collections. Set VERIFY_RESTORE=false to skip it.
if [ "$VERIFY_RESTORE" = "true" ]; then
  log "Verifying the backup by restoring it into a scratch database"
  printf '%s' "$MONGO_URI" | docker exec -i "$MONGO_CONTAINER" sh -c '
    read -r MONGODB_URI
    mongorestore --uri "$MONGODB_URI" --authenticationDatabase admin --gzip --archive='"$CONTAINER_DUMP"' \
      --nsInclude="'"$MONGO_DB"'.*" --nsFrom="'"$MONGO_DB"'.*" --nsTo="'"$RESTORE_CHECK_DB"'.*" --drop --quiet
  ' || die "the backup could not be restored - refusing to report success"

  RESTORED_COUNT="$(docker exec "$MONGO_CONTAINER" mongosh --quiet \
      --username "$MONGO_USER" --password "$MONGO_PASSWORD" --authenticationDatabase admin \
      --eval "db.getSiblingDB('"$RESTORE_CHECK_DB"').getCollectionNames().length" 2>/dev/null | tr -dc '0-9')"

  docker exec "$MONGO_CONTAINER" mongosh --quiet \
    --username "$MONGO_USER" --password "$MONGO_PASSWORD" --authenticationDatabase admin \
    --eval "db.getSiblingDB('"$RESTORE_CHECK_DB"').dropDatabase()" >/dev/null 2>&1 || true

  if [ -z "$RESTORED_COUNT" ] || [ "$RESTORED_COUNT" -eq 0 ]; then
    die "the restored scratch database was empty - the backup is not usable"
  fi
  log "Backup verified: restored $RESTORED_COUNT collection(s) successfully"
fi

docker cp "$MONGO_CONTAINER:$CONTAINER_DUMP" "$MONGO_FILE" >/dev/null \
  || die "could not copy the dump out of the container"
docker exec "$MONGO_CONTAINER" rm -f "$CONTAINER_DUMP" >/dev/null 2>&1 || true

[ -s "$MONGO_FILE" ] || die "mongodump produced an empty archive"

# gzip integrity check on the file that actually landed on disk
if ! gzip -t "$MONGO_FILE" 2>/dev/null; then
  rm -f "$MONGO_FILE"
  die "the dump archive is corrupt (gzip integrity check failed) - refusing to report success"
fi

log "MongoDB dump written: $MONGO_FILE ($(du -h "$MONGO_FILE" | cut -f1))"

ln -sf "$MONGO_FILE" "$LATEST_LINK"

# --------------------------------------------------------------------------
# 1b. Mongo's own admin database (system.users - the root user we connect with)
# --------------------------------------------------------------------------
if [ "$MONGO_DB" != "admin" ] && [ "$BACKUP_ADMIN_DB" = "true" ]; then
  ADMIN_FILE="$BACKUP_ROOT/blindscloud-mongo-admin-$STAMP.gz"
  log "Dumping the 'admin' database (mongo system users)"
  ADMIN_URI="mongodb://${MONGO_USER}:${MONGO_PASSWORD}@localhost:27017/admin"
  if printf '%s' "$ADMIN_URI" | docker exec -i "$MONGO_CONTAINER" sh -c '
        read -r MONGODB_URI
        mongodump --uri "$MONGODB_URI" --authenticationDatabase admin --archive='"$CONTAINER_ADMIN_DUMP"' --gzip
      ' && docker cp "$MONGO_CONTAINER:$CONTAINER_ADMIN_DUMP" "$ADMIN_FILE" >/dev/null 2>&1 && [ -s "$ADMIN_FILE" ]; then
    docker exec "$MONGO_CONTAINER" rm -f "$CONTAINER_ADMIN_DUMP" >/dev/null 2>&1 || true
    log "Admin database dump written: $ADMIN_FILE ($(du -h "$ADMIN_FILE" | cut -f1))"
  else
    log "WARNING: the admin database dump failed - the main dump is still valid"
    rm -f "$ADMIN_FILE"
  fi
fi

ln -sf "$MONGO_FILE" "$LATEST_LINK"

# --------------------------------------------------------------------------
# 2. Uploaded files
# --------------------------------------------------------------------------
if [ "$BACKUP_UPLOADS" = "true" ]; then
  if docker ps --format '{{.Names}}' | grep -qx "$FILES_CONTAINER"; then
    log "Archiving uploads from '$FILES_CONTAINER:$UPLOADS_PATH'"
    if docker exec "$FILES_CONTAINER" tar czf /tmp/blindscloud-uploads.tar.gz -C "$UPLOADS_PATH" . 2>/dev/null \
       && docker cp "$FILES_CONTAINER:/tmp/blindscloud-uploads.tar.gz" "$FILES_FILE" >/dev/null 2>&1 \
       && [ -s "$FILES_FILE" ]; then
      docker exec "$FILES_CONTAINER" rm -f /tmp/blindscloud-uploads.tar.gz >/dev/null 2>&1 || true
      log "Uploads archive written: $FILES_FILE ($(du -h "$FILES_FILE" | cut -f1))"
    else
      log "WARNING: uploads archive failed or was empty - continuing (mongo dump is still valid)"
      rm -f "$FILES_FILE"
    fi
  else
    log "WARNING: files container '$FILES_CONTAINER' is not running - skipping uploads"
  fi
fi

# --------------------------------------------------------------------------
# 3. Offsite copy (optional)
# --------------------------------------------------------------------------
if [ -n "$RCLONE_REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    log "Copying to offsite remote '$RCLONE_REMOTE'"
    if rclone copy "$BACKUP_ROOT" "$RCLONE_REMOTE" --exclude 'latest-*'; then
      log "Offsite copy OK"
    else
      log "WARNING: offsite copy failed"
    fi
  else
    log "WARNING: RCLONE_REMOTE is set but rclone is not installed - skipping offsite copy"
  fi
else
  log "RCLONE_REMOTE not set - backups stay on this disk only (a backup on the same disk is not a backup)"
fi

# --------------------------------------------------------------------------
# 4. Prune old backups
# --------------------------------------------------------------------------
log "Pruning backups older than $RETENTION_DAYS day(s)"
PRUNED=0
while IFS= read -r -d '' old; do
  rm -f "$old"
  PRUNED=$((PRUNED + 1))
done < <(find "$BACKUP_ROOT" -maxdepth 1 -type f \( -name 'blindscloud-mongo-*.gz' -o -name 'blindscloud-uploads-*.tar.gz' \) -mtime "+$RETENTION_DAYS" -print0)
log "Pruned $PRUNED old backup file(s)"

TOTAL="$(du -sh "$BACKUP_ROOT" 2>/dev/null | cut -f1)"
log "Backup complete. Total backup size: ${TOTAL:-unknown} (directory $BACKUP_ROOT)"
