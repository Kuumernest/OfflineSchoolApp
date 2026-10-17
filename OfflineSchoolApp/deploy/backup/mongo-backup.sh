#!/usr/bin/env bash
# deploy/backup/mongo-backup.sh — nightly MongoDB Atlas backup, stored off the VM.
#
#   1. mongodump the Atlas database to a timestamped, gzip-compressed archive
#   2. check the archive (gzip integrity, non-empty)
#   3. upload it to the off-VM bucket with rclone (Cloudflare R2, Backblaze B2,
#      any S3-compatible store) and confirm the uploaded size matches
#   4. only then, delete remote archives older than RETENTION_DAYS — never the
#      one just uploaded, and never when anything above failed
#
# Exits nonzero on any failure (set -euo pipefail), so cron/systemd and the
# optional ping see it. Never prints the connection string: it is handed to
# mongodump through a mode-600 config file, not the command line (where `ps`
# and shell history would show it), and archive names carry only the date.
#
# Configuration: an environment file, by default /etc/offlineschool/backup.env
# (chmod 600, owned by the user that runs this). See backup.env.example and
# docs/17, "Backups".
#
#   BACKUP_ENV_FILE=/path/to/backup.env ./mongo-backup.sh
set -euo pipefail
umask 077

ENV_FILE="${BACKUP_ENV_FILE:-/etc/offlineschool/backup.env}"
if [[ ! -r "$ENV_FILE" ]]; then
  echo "backup: cannot read $ENV_FILE" >&2; exit 64
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${BACKUP_MONGODB_URI:?BACKUP_MONGODB_URI is not set in $ENV_FILE}"
: "${RCLONE_DEST:?RCLONE_DEST is not set (e.g. r2:offlineschool-backups/atlas)}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
WORK_DIR="${BACKUP_WORK_DIR:-/var/backups/offlineschool}"
KEEP_LOCAL="${KEEP_LOCAL:-0}"                 # 1 keeps the newest archive on the VM too
PREFIX="${BACKUP_PREFIX:-offlineschool}"

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || (( RETENTION_DAYS < 7 )); then
  echo "backup: RETENTION_DAYS must be a whole number of days, at least 7" >&2; exit 64
fi
for tool in mongodump rclone gzip; do
  command -v "$tool" >/dev/null || { echo "backup: $tool is not installed" >&2; exit 69; }
done

ping_status() {   # optional dead-man's switch (healthchecks.io or similar)
  [[ -n "${HEALTHCHECK_URL:-}" ]] || return 0
  curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL}${1:-}" >/dev/null 2>&1 || true
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${WORK_DIR}/${PREFIX}-${STAMP}.archive.gz"
CONFIG="$(mktemp)"
cleanup() {
  rm -f "$CONFIG"
  if [[ "$KEEP_LOCAL" != "1" ]]; then rm -f "$ARCHIVE"; fi
}
fail() { echo "backup: FAILED — $1" >&2; ping_status /fail; exit 1; }
trap cleanup EXIT
trap 'fail "interrupted or error at line $LINENO"' ERR

mkdir -p "$WORK_DIR"
ping_status /start
echo "backup: dumping to $(basename "$ARCHIVE")"

# The URI goes in a YAML config file only this user can read.
printf 'uri: "%s"\n' "$BACKUP_MONGODB_URI" > "$CONFIG"
mongodump --config="$CONFIG" --archive="$ARCHIVE" --gzip --quiet \
  || fail "mongodump exited nonzero"

[[ -s "$ARCHIVE" ]] || fail "the archive is empty"
gzip -t "$ARCHIVE" || fail "the archive is not a valid gzip stream"
LOCAL_BYTES="$(stat -c %s "$ARCHIVE")"
echo "backup: archive ok, ${LOCAL_BYTES} bytes"

REMOTE="${RCLONE_DEST%/}/$(basename "$ARCHIVE")"
rclone copyto "$ARCHIVE" "$REMOTE" --retries 3 --low-level-retries 10 \
  || fail "upload to the backup destination failed"
REMOTE_BYTES="$(rclone size --json "$REMOTE" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
[[ "$REMOTE_BYTES" == "$LOCAL_BYTES" ]] \
  || fail "uploaded size ${REMOTE_BYTES:-unknown} does not match local ${LOCAL_BYTES}"
echo "backup: uploaded and verified at the destination"

# Retention, only now that a newer archive is safely stored. --min-age never
# matches the archive just uploaded.
rclone delete "${RCLONE_DEST%/}" --min-age "${RETENTION_DAYS}d" --include "${PREFIX}-*.archive.gz" \
  || fail "retention cleanup failed (the new backup IS stored)"

trap - ERR
ping_status
echo "backup: done"
