#!/usr/bin/env bash
# deploy/backup/uploads-backup.sh — the uploads volume (pupils' photographs,
# school logos, admission documents, teaching content), copied off the VM.
#
# The database backup (mongo-backup.sh) holds every record but not these
# files, and the uploads volume is the one piece of state on the VM. Losing
# the VM without this loses every photograph and document.
#
# Incremental, not a nightly tarball: the files are large and rarely change.
#   rclone sync  <volume>  → ${RCLONE_DEST}/uploads/current
#     a file changed or deleted since the last run is first moved to
#     ${RCLONE_DEST}/uploads/changed/<UTC stamp>/ (--backup-dir), so nothing
#     is lost the night it changes;
#   rclone check --one-way: every file on the volume is at the destination,
#     same size, or the run FAILS;
#   only then: changed/ folders older than RETENTION_DAYS are removed.
#
# Runs as root (systemd, offlineschool-uploads-backup.service): it reads a
# Docker volume, and access to Docker is root access. It only READS the volume.
# Exits nonzero on any failure; never prints a credential.
#
#   BACKUP_ENV_FILE=/etc/offlineschool/backup.env ./uploads-backup.sh
set -euo pipefail
umask 077

ENV_FILE="${BACKUP_ENV_FILE:-/etc/offlineschool/backup.env}"
[[ -r "$ENV_FILE" ]] || { echo "uploads-backup: cannot read $ENV_FILE" >&2; exit 64; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${RCLONE_DEST:?RCLONE_DEST is not set (e.g. r2:offlineschool-backups/atlas)}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || (( RETENTION_DAYS < 7 )); then
  echo "uploads-backup: RETENTION_DAYS must be a whole number of days, at least 7" >&2; exit 64
fi
for tool in rclone docker; do
  command -v "$tool" >/dev/null || { echo "uploads-backup: $tool is not installed" >&2; exit 69; }
done

ping_status() {
  [[ -n "${UPLOADS_HEALTHCHECK_URL:-}" ]] || return 0
  curl -fsS -m 10 --retry 3 "${UPLOADS_HEALTHCHECK_URL}${1:-}" >/dev/null 2>&1 || true
}
fail() { echo "uploads-backup: FAILED — $1" >&2; ping_status /fail; exit 1; }
trap 'fail "error at line $LINENO"' ERR

# The volume: named in the env file, or the one whose name ends uploads_data
# (Compose prefixes it with the project name).
VOLUME="${UPLOADS_VOLUME:-}"
if [[ -z "$VOLUME" ]]; then
  mapfile -t found < <(docker volume ls -q | grep -E '(^|_)uploads_data$' || true)
  (( ${#found[@]} == 1 )) || fail "found ${#found[@]} volumes named *uploads_data; set UPLOADS_VOLUME"
  VOLUME="${found[0]}"
fi
SRC="$(docker volume inspect -f '{{ .Mountpoint }}' "$VOLUME")" || fail "no volume $VOLUME"
[[ -d "$SRC" ]] || fail "the volume's directory is not readable here (run as root)"

DEST="${RCLONE_DEST%/}/uploads"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ping_status /start
echo "uploads-backup: $VOLUME → $(sed -E 's#^([^:]+:).*#\1…#' <<<"$DEST")/current"

rclone sync "$SRC" "$DEST/current" --backup-dir "$DEST/changed/$STAMP" \
  --retries 3 --low-level-retries 10 --stats-one-line --stats 0 \
  || fail "sync to the backup destination failed"

rclone check "$SRC" "$DEST/current" --one-way --size-only --quiet \
  || fail "the destination does not hold every file on the volume"
echo "uploads-backup: synced and verified"

# Retention, only now that the copy is verified: moved-aside versions older
# than RETENTION_DAYS go. `current` is never pruned.
# No changed/ yet (the first runs, before anything changed): nothing to prune.
if rclone lsf "$DEST" --dirs-only 2>/dev/null | grep -qx 'changed/'; then
  rclone delete "$DEST/changed" --min-age "${RETENTION_DAYS}d" --quiet \
    || fail "retention cleanup failed (the copy IS stored)"
  rclone rmdirs "$DEST/changed" --leave-root --quiet 2>/dev/null || true
fi

trap - ERR
ping_status
echo "uploads-backup: done"
