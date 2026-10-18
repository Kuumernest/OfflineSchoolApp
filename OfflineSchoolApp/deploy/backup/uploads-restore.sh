#!/usr/bin/env bash
# deploy/backup/uploads-restore.sh — bring the uploads back from the backup.
#
#   uploads-restore.sh --into=<empty directory> [--from=current|changed/<stamp>]
#
# Restores INTO A DIRECTORY, never over the live volume: a drill compares it
# with the volume; a real recovery copies it into a new volume with the
# backend stopped (docs/17, "Backups"). The directory must be empty, so
# nothing there is overwritten. Prints a file count and total size to compare.
set -euo pipefail
umask 022

ENV_FILE="${BACKUP_ENV_FILE:-/etc/offlineschool/backup.env}"
[[ -r "$ENV_FILE" ]] || { echo "uploads-restore: cannot read $ENV_FILE" >&2; exit 64; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${RCLONE_DEST:?RCLONE_DEST is not set}"
command -v rclone >/dev/null || { echo "uploads-restore: rclone is not installed" >&2; exit 69; }

INTO=""; FROM="current"
for arg in "$@"; do
  case "$arg" in
    --into=*) INTO="${arg#--into=}" ;;
    --from=*) FROM="${arg#--from=}" ;;
    *) echo "usage: $0 --into=<empty directory> [--from=current|changed/<stamp>]" >&2; exit 64 ;;
  esac
done
[[ -n "$INTO" ]] || { echo "uploads-restore: --into=<empty directory> is required" >&2; exit 64; }
[[ "$FROM" == "current" || "$FROM" =~ ^changed/[0-9]{8}T[0-9]{6}Z$ ]] \
  || { echo "uploads-restore: --from must be current or changed/<stamp>" >&2; exit 64; }
mkdir -p "$INTO"
[[ -z "$(ls -A "$INTO")" ]] || { echo "uploads-restore: $INTO is not empty; nothing is overwritten" >&2; exit 1; }

rclone copy "${RCLONE_DEST%/}/uploads/$FROM" "$INTO" --retries 3 --quiet
count="$(find "$INTO" -type f | wc -l | tr -d ' ')"
bytes="$(du -sb "$INTO" | cut -f1)"
echo "uploads-restore: $count file(s), $bytes bytes in $INTO"
