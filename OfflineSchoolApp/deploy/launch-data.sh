#!/usr/bin/env bash
# deploy/launch-data.sh — the launch data steps (docs/launch-fixes.md, "Launch
# order", steps 4–6), as one guided run against the production database.
#
#   1. asks for the Atlas connection string (hidden; never written anywhere)
#   2. backs the database up with mongodump to /tmp (installing MongoDB
#      Database Tools into /tmp first if mongodump is missing — no sudo)
#   3. dry run of delete-school for Green Valley Academy and Kena Academy
#   4. "Type DELETE to continue", then delete-school --apply for each
#      (each one asks for the school's exact name again)
#   5. seeds the clean test school and prints its sign-ins — on screen only
#   6. uploads:usage: the database's size against Atlas's 512 MB
#
# Stops at the first error. Run it in a normal terminal (it asks questions):
#
#   bash /path/to/OfflineSchoolApp/deploy/launch-data.sh
#
# The connection string lives only in this process's environment: it is read
# with `read -s` (not echoed, not in shell history), exported to the node
# scripts this run starts, and handed to mongodump through a pipe rather than
# its command line, where `ps` would show it. Nothing is written to disk but
# the backup archive itself.
set -Eeuo pipefail
umask 077

TOOLS_VERSION="100.13.0"
SCHOOLS=("Green Valley Academy" "Kena Academy")   # Green Valley first: a portal
                                                   # code they share moves to Kena
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$SCRIPT_DIR/../backend" && pwd)"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
ARCHIVE="/tmp/offlineschool-backup-$STAMP.archive.gz"

STEP="start"
bold()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
step()  { STEP="$1"; bold "── Step $1 ─────────────────────────────────────────────"; }
die()   { printf '\n\033[31mStopped: %s\033[0m\n' "$*" >&2; exit 1; }
trap 'printf "\n\033[31mStopped at step %s (a command failed, see above). Nothing after it ran.\033[0m\n" "$STEP" >&2' ERR
trap 'unset MONGODB_URI MONGO_URI' EXIT

command -v node >/dev/null || die "node is not installed"
command -v npm  >/dev/null || die "npm is not installed"
[[ -d "$BACKEND/node_modules" ]] || die "$BACKEND/node_modules is missing — run: cd $BACKEND && npm ci"
cd "$BACKEND"
export DOTENV_CONFIG_QUIET=true      # no dotenv banner between the steps

# ── 1. The connection string ──────────────────────────────────────────────────
step "1/6: Atlas connection string"
echo "Paste the production MONGODB_URI (Render → backend → Environment). It will not be shown."
read -r -s -p "MONGODB_URI: " MONGODB_URI
echo
[[ "$MONGODB_URI" =~ ^mongodb(\+srv)?:// ]] || die "that does not look like a MongoDB connection string (mongodb:// or mongodb+srv://)"
export MONGODB_URI
echo "OK (kept in memory for this run only)."

# ── 2. Backup ─────────────────────────────────────────────────────────────────
step "2/6: Backup (mongodump → /tmp)"
if ! command -v mongodump >/dev/null; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}-${VERSION_ID:-}" in
    ubuntu-24.04) DISTRO=ubuntu2404 ;;
    ubuntu-22.04) DISTRO=ubuntu2204 ;;
    ubuntu-20.04) DISTRO=ubuntu2004 ;;
    debian-12)    DISTRO=debian12 ;;
    debian-11)    DISTRO=debian11 ;;
    *) die "no MongoDB Database Tools build known for ${PRETTY_NAME:-this system}; install mongodump by hand" ;;
  esac
  case "$(uname -m)" in
    x86_64)  ARCH=x86_64 ;;
    aarch64) ARCH=arm64 ;;
    *) die "unsupported CPU $(uname -m)" ;;
  esac
  NAME="mongodb-database-tools-$DISTRO-$ARCH-$TOOLS_VERSION"
  if [[ ! -x "/tmp/$NAME/bin/mongodump" ]]; then
    echo "mongodump not found — downloading MongoDB Database Tools $TOOLS_VERSION into /tmp …"
    curl -fsSL "https://fastdl.mongodb.org/tools/db/$NAME.tgz" -o "/tmp/$NAME.tgz"
    tar -xzf "/tmp/$NAME.tgz" -C /tmp
    rm -f "/tmp/$NAME.tgz"
  fi
  PATH="/tmp/$NAME/bin:$PATH"
fi
echo "Using $(mongodump --version | head -1)"

# The URI goes to mongodump as a config file read from a pipe — not on its
# command line, and not on disk.
yaml_uri="${MONGODB_URI//\\/\\\\}"
yaml_uri="${yaml_uri//\"/\\\"}"
mongodump --config=<(printf 'uri: "%s"\n' "$yaml_uri") --gzip --archive="$ARCHIVE"
unset yaml_uri
[[ -s "$ARCHIVE" ]] || die "the backup archive is empty"
gzip -t "$ARCHIVE" || die "the backup archive is not a valid gzip file"
echo
echo "Backup written: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo "To keep a copy: Cloud Shell → More (⋮) → Download → enter the path above."
echo "/tmp is cleared when the Cloud Shell session ends — download it before closing."
read -r -p "Press Enter once you have the backup (or Ctrl-C to stop here) … " _

# ── 3. Dry runs ───────────────────────────────────────────────────────────────
step "3/6: Dry run — what deleting each school removes (nothing is written)"
for school in "${SCHOOLS[@]}"; do
  bold "• $school"
  npm run -s school:delete -- --school "$school"
done
echo
echo "Kena's figures above are from before Green Valley goes: a portal code they share moves to Kena first."

# ── 4. Delete ─────────────────────────────────────────────────────────────────
step "4/6: Delete both schools"
read -r -p "Type DELETE to continue: " answer
[[ "$answer" == "DELETE" ]] || die "you typed \"$answer\", not DELETE — nothing was deleted"
for school in "${SCHOOLS[@]}"; do
  bold "• $school — you will be asked for its exact name"
  npm run -s school:delete -- --school "$school" --apply
done

# ── 5. Test school ────────────────────────────────────────────────────────────
step "5/6: Seed the test school (Ecole Test Bilingue)"
echo "The sign-ins below are shown once and stored nowhere — note them now."
npm run -s seed:test-school

# ── 6. Size ───────────────────────────────────────────────────────────────────
step "6/6: Database size (Atlas free tier: 512 MB)"
npm run -s uploads:usage

STEP="done"
bold "All six steps done. Backup: $ARCHIVE"
