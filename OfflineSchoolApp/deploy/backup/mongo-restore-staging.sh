#!/usr/bin/env bash
# deploy/backup/mongo-restore-staging.sh — restore drill into an ISOLATED
# staging database, then check what came back.
#
#   mongo-restore-staging.sh <archive.archive.gz> --into=<RESTORE_TARGET_DB>
#
# The archive may be a local path or an rclone remote path
# (r2:offlineschool-backups/atlas/offlineschool-…archive.gz), fetched first.
#
# Never restores over production:
#   - the target is RESTORE_TARGET_URI + RESTORE_TARGET_DB, never the backup's
#     BACKUP_MONGODB_URI;
#   - the backup's database (RESTORE_SOURCE_DB) is renamed on the way in
#     (--nsFrom/--nsTo), and RESTORE_TARGET_DB may not equal it;
#   - --into= must repeat RESTORE_TARGET_DB, so a wrong env file does not
#     silently pick the target;
#   - the target database must be empty (no --drop, nothing overwritten).
#
# Connection strings go to the tools through mode-600 files and environment
# variables, never the command line, and are never printed.
set -euo pipefail
umask 077

ENV_FILE="${BACKUP_ENV_FILE:-/etc/offlineschool/backup.env}"
[[ -r "$ENV_FILE" ]] || { echo "restore: cannot read $ENV_FILE" >&2; exit 64; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

ARCHIVE_ARG="${1:-}"
INTO_ARG="${2:-}"
: "${RESTORE_TARGET_URI:?RESTORE_TARGET_URI is not set}"
: "${RESTORE_SOURCE_DB:?RESTORE_SOURCE_DB is not set}"
: "${RESTORE_TARGET_DB:?RESTORE_TARGET_DB is not set}"
[[ -n "$ARCHIVE_ARG" ]] || { echo "usage: $0 <archive> --into=<RESTORE_TARGET_DB>" >&2; exit 64; }
[[ "$INTO_ARG" == "--into=${RESTORE_TARGET_DB}" ]] \
  || { echo "restore: pass --into=${RESTORE_TARGET_DB} to confirm the target database" >&2; exit 64; }
[[ "$RESTORE_TARGET_DB" != "$RESTORE_SOURCE_DB" ]] \
  || { echo "restore: RESTORE_TARGET_DB must differ from the backed-up database name" >&2; exit 64; }

host_of() { sed -E 's#^mongodb(\+srv)?://([^@/]*@)?([^/?]+).*#\3#' <<<"$1"; }
if [[ -n "${BACKUP_MONGODB_URI:-}" && "$(host_of "$RESTORE_TARGET_URI")" == "$(host_of "$BACKUP_MONGODB_URI")" ]]; then
  echo "restore: note — the target is on the same cluster as the backup source;" \
       "restoring into the separate database ${RESTORE_TARGET_DB} only."
fi
for tool in mongorestore mongosh; do
  command -v "$tool" >/dev/null || { echo "restore: $tool is not installed" >&2; exit 69; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ARCHIVE="$ARCHIVE_ARG"
if [[ ! -f "$ARCHIVE" ]]; then
  command -v rclone >/dev/null || { echo "restore: $ARCHIVE is not a local file and rclone is missing" >&2; exit 69; }
  rclone copyto "$ARCHIVE_ARG" "$WORK/backup.archive.gz"
  ARCHIVE="$WORK/backup.archive.gz"
fi
gzip -t "$ARCHIVE" || { echo "restore: the archive is not a valid gzip stream" >&2; exit 1; }

# The target must be empty: a drill never overwrites anything.
export RESTORE_TARGET_URI RESTORE_TARGET_DB RESTORE_SOURCE_DB
existing="$(mongosh --nodb --quiet --eval '
  const c = connect(process.env.RESTORE_TARGET_URI).getSiblingDB(process.env.RESTORE_TARGET_DB);
  print(c.getCollectionNames().length);')"
[[ "$existing" == "0" ]] || { echo "restore: ${RESTORE_TARGET_DB} already has ${existing} collection(s); use an empty database" >&2; exit 1; }

printf 'uri: "%s"\n' "$RESTORE_TARGET_URI" > "$WORK/target.yaml"
echo "restore: ${RESTORE_SOURCE_DB}.* → ${RESTORE_TARGET_DB}.*"
mongorestore --config="$WORK/target.yaml" --archive="$ARCHIVE" --gzip \
  --nsInclude="${RESTORE_SOURCE_DB}.*" \
  --nsFrom="${RESTORE_SOURCE_DB}.*" --nsTo="${RESTORE_TARGET_DB}.*" \
  --quiet

# What came back: every collection's count, and for the collections a school
# cannot run without, at least one document with an _id (and a schoolId where
# the model has one). Counts only — no names, no marks.
# JavaScript, not shell: ${…} is for mongosh, not expanded here.
# shellcheck disable=SC2016
mongosh --nodb --quiet --eval '
  const db = connect(process.env.RESTORE_TARGET_URI).getSiblingDB(process.env.RESTORE_TARGET_DB);
  const names = db.getCollectionNames().sort();
  let total = 0;
  for (const n of names) { const c = db.getCollection(n).estimatedDocumentCount(); total += c; print(`  ${n.padEnd(36)} ${c}`); }
  print(`  ${names.length} collections, ${total} documents`);
  const core = { schools: false, users: false, students: true, classes: true, resultsummaries: true, feepayments: true };
  let bad = 0;
  for (const [n, scoped] of Object.entries(core)) {
    const one = db.getCollection(n).findOne({}, { _id: 1, schoolId: 1 });
    const ok = one && one._id !== undefined && (!scoped || one.schoolId !== undefined);
    print(`  check ${n}: ${one ? (ok ? "ok" : "MISSING FIELDS") : "EMPTY"}`);
    if (!ok && n !== "feepayments" && n !== "resultsummaries") bad++;
  }
  if (bad) { print("restore: verification FAILED"); quit(1); }
  print("restore: verification passed");'
