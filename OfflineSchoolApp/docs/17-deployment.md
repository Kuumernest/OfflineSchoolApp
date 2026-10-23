# 17 — Deployment

*Updated for the 1 November 2026 launch: Oracle Cloud VM (backend, Docker
Compose, nginx, Let's Encrypt), MongoDB Atlas, Cloudflare Pages (web),
GitHub Actions (APK and desktop releases), nightly off-VM backups.*

> **Read [19-known-limitations.md](19-known-limitations.md) and the launch
> blockers at the end of this page before deploying.** The packaged desktop
> app does not work yet (see "Desktop").

---

## Architecture

```
 schools' browsers ──https──▶ Cloudflare Pages  (web console, static)
        │                                │ calls
        │                                ▼
 phones (APK) ──https──▶  Oracle VM :443 nginx ──▶ backend :5000 (Docker network only)
 desktop app ──https──▶        │  :80 ACME + redirect      │
                               certbot (renewal)            ├──▶ MongoDB Atlas (TLS)
                                                            └──▶ uploads volume (the only state on the VM)
 nightly timer on the VM ── mongodump ──▶ R2 / B2 bucket (off-VM)
```

## Prerequisites

| | |
|---|---|
| Node.js | **24** — what CI tests on (`.github/workflows`) and what the Docker image runs. Node 20 reached end of life in April 2026. No `engines` field is declared. |
| MongoDB | **Atlas**, server 6.0 or later (two partial indexes use `$in`). No database container in production. |
| Server | an Oracle Cloud VM, ARM64 (Ampere A1) or x86-64, Ubuntu 22.04/24.04, with Docker Engine and the Compose plugin |
| npm | bundled with Node |

There are **no workspaces**. Install each package separately:

```bash
cd OfflineSchoolApp/backend && npm ci
cd ../web                   && npm ci
cd ../desktop               && npm ci
cd ../mobile                && npm ci   # .npmrc supplies --legacy-peer-deps
```

---

## Environment variables

Every variable below was verified as **actually read** by the code. Names only —
no values appear in this documentation.

### Backend — required

| Variable | Required | Enforced by |
|---|---|---|
| `MONGODB_URI` | always | `config/env.js` — process exits if unset |
| `JWT_SECRET` | always | `config/env.js` — exits if unset, a known placeholder, or too short (32+ characters) |
| `ALLOWED_ORIGINS` | **in production** | `config/env.js` — exits if unset when `NODE_ENV=production`. Comma-separated. |

### Backend — optional

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `5000` | listen port |
| `NODE_ENV` | unset | `production` enables strict CORS, `trust proxy`, combined logging |
| `JWT_EXPIRES_IN` | `30d` | access-token lifetime |
| `JWT_REFRESH_SECRET` | unset | **when unset, the first `/auth/refresh` handler falls through to a second that refreshes against the access token** |
| `JWT_REFRESH_EXPIRES` | `90d` | refresh-token lifetime |
| `REQUIRE_MEDIA_SIGNATURE` | off | `1` enforces HMAC signatures on message attachments |
| `SENTRY_DSN` | unset | Sentry is fully inert without it |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | tracing is opt-in |
| `SENTRY_RELEASE` | unset | release tag |
| `SCHOOL_NAME` | unset | used in outbound email |
| `APP_LOGIN_URL` | unset | login link in emails |
| `BASE_URL` | unset | absolute URLs in generated documents |
| `BREVO_API_KEY` | unset | **email is unavailable without it**; everything else works |
| `BREVO_SENDER_EMAIL` | unset | the From address; must be authenticated in Brevo |
| `BREVO_SENDER_NAME` | unset | display name only — mail sends without it |
| `BREVO_REPLY_TO` | unset | where a reply goes |
| `BREVO_TEMPLATE_*` | unset | seven optional template ids; unset sends the app's own HTML |
| `GMAIL_USER` | unset | the Gmail failover account; both Gmail vars needed |
| `GMAIL_APP_PASSWORD` | unset | App Password for the failover |
| `EMAIL_FROM` | unset | legacy override for `BREVO_SENDER_EMAIL` |
| `DISABLE_LOGIN_RATE_LIMIT` | unset | lifts the login limiter — **set only by `scripts/`, never in production** |
| `ANALYSIS_WORKER_HEAP_MB` | `2048` | heap cap (MB) of one school-wide analysis worker; above it the run fails `WORKER_OUT_OF_MEMORY` and the server carries on (docs/38) |
| `ANALYSIS_CONCURRENCY` | `1` | analyses one server process runs at once; budget about `ANALYSIS_WORKER_HEAP_MB` of free memory for each |
| `ANALYSIS_TIMEOUT_MS` | `600000` | an analysis worker running longer is stopped (`TIMEOUT`) |
| `ANALYSIS_REPORT_MAX_BYTES` | `12582912` | largest compressed analysis report stored (`REPORT_TOO_LARGE` above it) |

The four `ANALYSIS_*` variables are read once at startup as whole numbers;
anything that is not at least 1 is the default.

### Read by the code but NOT in `.env.example` — DISCREPANCY

| Variable | Where |
|---|---|
| `BASE_URL` | document generation |
| `DISABLE_LOGIN_RATE_LIMIT` | `auth.routes.js` |
| `WHATSAPP_TOKEN` | notification code |
| `WHATSAPP_PHONE_NUMBER_ID` | notification code |

The two WhatsApp variables are the notable pair: code reads them, nothing
documents them, and there is no evidence of a working WhatsApp delivery path.
Treat WhatsApp messaging as **NOT IMPLEMENTED** until proven otherwise.

Conversely `.env.example` lists `EMAIL_FROM`, which **is** read (via the `env`
helper in `email.transport.js`) — that one is fine.

`SENDGRID_API_KEY` is read by nothing: that provider was removed from the
registry when this app moved to Brevo, and an environment still holding it is
treated as **unconfigured** rather than routed through a retired provider. The
startup log says so.

`GMAIL_USER` and `GMAIL_APP_PASSWORD` **are** read — they configure the Gmail
failover that catches a Brevo send that has actually failed. They are optional;
without them a failed send is reported rather than retried. See
[20-email.md](20-email.md).

### Server environment file

The backend's whole environment comes from one protected file on the server,
`deploy/backend.env` (template: `deploy/backend.env.example`; gitignored;
`chmod 600`), passed by `docker-compose.yml` as `env_file`. Compose itself
needs only `DOMAIN` (shell or `./.env`). The backend refuses to start without
`MONGODB_URI`, `JWT_SECRET` (32+ characters, not a placeholder) and, in
production, `ALLOWED_ORIGINS` and `JWT_REFRESH_SECRET` (`src/config/env.js`).

Before this, Compose passed only six variables to the container, so Brevo,
Sentry, Anthropic, `REQUIRE_MEDIA_SIGNATURE`, `APP_LOGIN_URL` and `BASE_URL`
never reached production even when set.

### Mobile

| Variable | Required |
|---|---|
| `EXPO_PUBLIC_API_URL` | **yes for any release build.** `api.js` warns: *"a release build has no server to talk to"* if unset. |

### Web

| Variable | Required |
|---|---|
| `VITE_API_URL` | **yes for Cloudflare Pages**: `https://<api-domain>/api`. Unset, the console calls `/api` on its own origin, which on Pages is not the API. |
| `VITE_SENTRY_DSN`, `VITE_SENTRY_RELEASE`, `VITE_SENTRY_TRACES_SAMPLE_RATE` | optional (a Sentry DSN is public) |

No client bundle may contain a secret. Checked: no Anthropic, Brevo, JWT or
private-key material in `web/src`, `web/dist`, `mobile/`, `desktop/src` or
`shared/`; only `.example` env files are tracked.

---

## Backend deployment

### Running

```bash
cd OfflineSchoolApp/backend
NODE_ENV=production node src/server.js
```

`package.json` `main` is `index.js`, and the Dockerfile's `CMD` is
`node src/server.js`. Both entry points exist; the Docker path is the one that is
exercised.

### Boot validation

The process **exits non-zero** with a printed list of problems if the environment
is incomplete. This is the intended behaviour — a backend that starts with a
placeholder `JWT_SECRET` is worse than one that refuses.

### Health

| Endpoint | Meaning | Used by |
|---|---|---|
| `GET /api/health` | **liveness** — the process is up. 200 even with the database gone. | humans, uptime monitors |
| `GET /api/health/ready` | **readiness** — 200 only when MongoDB answers a ping within 3 s, else 503. Says nothing about the database beyond up or down. | the Compose healthcheck |

### CORS

`ALLOWED_ORIGINS` is a comma-separated allowlist and is **required in
production**. Outside production, CORS reflects *any* origin — do not leave a
public staging host at `NODE_ENV != production`.

---

## Oracle Cloud VM (Docker Compose)

### The account and the instance

- **Always Free is not guaranteed capacity.** Ampere A1 capacity in a region
  can be unavailable at creation time, and Oracle reclaims Always Free compute
  instances it considers idle (low CPU, network and memory use over 7 days).
  An instance in a **Pay As You Go** account is not subject to idle
  reclamation, and Always Free shapes in such an account still cost nothing
  within the free limits. For a school's production server, upgrade the
  account to Pay As You Go (and set a budget alert) rather than relying on a
  free-tier-only account.
- Nothing irreplaceable lives on the VM: the database is Atlas, backups go to
  an off-VM bucket. The **uploads volume** is the one thing to back up from the
  VM (see "Backups"); losing the VM otherwise costs a redeploy.
- ARM64 works as it is: the images are multi-arch (`node:24-alpine`,
  `nginx:stable-alpine`, `certbot/certbot`) and the backend has no native
  addons (`bcryptjs` is pure JavaScript). Build on the VM itself.

### Network: VCN and host firewall (by hand, in the Oracle console)

Nothing here changes cloud firewall settings automatically.

1. **VCN security list or network security group** for the instance's subnet:
   ingress TCP **80** and **443** from `0.0.0.0/0` (and `::/0` for IPv6), SSH
   **22** from your own IP only. Nothing else — not 5000, not 27017.
2. **Host firewall.** Oracle's Ubuntu images ship iptables rules that drop
   everything except SSH, even when the VCN allows it:

   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

   (Check the position with `sudo iptables -L INPUT --line-numbers`: the
   ACCEPTs must come before the final REJECT.) Docker publishes 80/443 through
   its own chains; the backend's port is never published.
3. **Atlas → Network Access:** allow the VM's public IP only (a reserved
   public IP, so it does not change on restart).

### Deploy

```bash
git clone https://github.com/<owner>/OfflineSchoolApp.git /opt/offlineschool
cd /opt/offlineschool/OfflineSchoolApp
cp deploy/backend.env.example deploy/backend.env && chmod 600 deploy/backend.env
$EDITOR deploy/backend.env                 # every REPLACE_ME
echo "DOMAIN=api.example.cm" > .env        # the API's public name
docker compose up -d --build
docker compose ps                          # backend becomes "healthy" once Atlas answers
```

Update: `git pull && docker compose up -d --build`. Before a release that
adds models or indexes, run the index plan (below) against staging, then
production.

Three services:

| Service | Image | Ports | Volumes |
|---|---|---|---|
| `backend` | built from `Dockerfile` (target `production`), Node 24 Alpine, non-root | **none published** (5000 on the Docker network only) | `uploads_data:/app/src/uploads` |
| `nginx` | `nginx:stable-alpine` | `80:80`, `443:443` | `nginx-start.sh`, `nginx-http.conf`, `nginx.conf` (templates); `letsencrypt`, `certbot_webroot` read-only |
| `certbot` | `certbot/certbot` | none | `letsencrypt`, `certbot_webroot` |

- **No MongoDB container.** An existing server keeps its old `mongo_data`
  volume until removed by hand (`docker volume ls`); Compose does not delete it.
- **Restarts:** `restart: unless-stopped`; `init: true` (tini as PID 1);
  `stop_grace_period: 20s` — `server.js` closes HTTP, then MongoDB, and forces
  an exit after 10 s.
- **Healthcheck:** `/api/health/ready` every 30 s, 90 s start period. Compose
  marks the container `unhealthy` on an Atlas outage and does **not** restart
  it, so there is no restart loop; nginx depends on the backend having
  *started*, not being healthy, so it can always answer the ACME challenge.

### Backend scripts on the VM

The production image carries `src/`, not `backend/scripts/`, and the VM has no
Node.js of its own. A one-off script runs in a throwaway container of the same
image, with the checkout's `backend/scripts` mounted over `/app/scripts`
(read-only), from `/opt/offlineschool/OfflineSchoolApp`. `docker compose run`
gives that container the backend's own environment (`deploy/backend.env`), so
the server's `MONGODB_URI` is already there and never typed. `--rm` removes the
container afterwards; `--no-deps` starts nothing else. Build the image first
(`docker compose up -d --build` does).

**First super admin** (a new database has no users; see "First super admin"):

```bash
docker compose run --rm --no-deps -v "$PWD/backend/scripts:/app/scripts:ro" backend \
  node scripts/create-super-admin.js --email=<operator email> --name="<full name>"
```

Exit 0 prints the temporary password once; exit 3 = a super admin already
exists (or the email is taken), and nothing was written.

**Index plan on the production database** (the server's own, from
`deploy/backend.env`: the planner reads only `PROVISION_MONGODB_URI`, so the
command hands it the server's `MONGODB_URI` explicitly):

```bash
docker compose run --rm --no-deps -v "$PWD/backend/scripts:/app/scripts:ro" backend \
  sh -c 'PROVISION_MONGODB_URI="$MONGODB_URI" exec node scripts/provision-indexes.js'            # plan, read-only
docker compose run --rm --no-deps -v "$PWD/backend/scripts:/app/scripts:ro" backend \
  sh -c 'PROVISION_MONGODB_URI="$MONGODB_URI" exec node scripts/provision-indexes.js --apply'    # off-peak
```

**Index plan on another database** (staging), typed at a prompt that does not
echo, so it stays out of the shell history and the screen:

```bash
read -rs PROVISION_MONGODB_URI && export PROVISION_MONGODB_URI    # paste, Enter
docker compose run --rm --no-deps -e PROVISION_MONGODB_URI -v "$PWD/backend/scripts:/app/scripts:ro" backend \
  node scripts/provision-indexes.js
unset PROVISION_MONGODB_URI
```

Atlas must allow the VM's IP on that cluster too. With the variable unset, the
planner refuses (exit 64) rather than fall back to the server's database.

Tested 2026-10-23 against the production image and a throwaway MongoDB 7
container: the admin command created one account and refused a second run; the
plan reported 469 missing, `--apply` created 469, the plan then reported
nothing missing; the staging form reached its own database; the backend then
reported ready and the printed password signed in, with platform routes
answering `PASSWORD_CHANGE_REQUIRED` until it was changed.

### TLS

nginx serves the API on 443 only (TLS 1.2 and 1.3, HTTP/2, HSTS). Port 80
answers the Let's Encrypt challenge (`/.well-known/acme-challenge/`) and
redirects everything else to `https://`. `nginx-start.sh` serves port 80 at
once and adds 443 as soon as the certificate exists (checking every minute,
after `nginx -t`), so a fresh server starts without one.

**Prerequisites:** an `A` (and `AAAA`, if the VM has IPv6) record for
`DOMAIN` pointing at the VM's public IP, **not proxied** through Cloudflare
(grey cloud) for issuance; ports 80 and 443 open as above.

**First certificate, once**, with the stack running:

```bash
docker compose run --rm --entrypoint certbot certbot \
  certonly --webroot -w /var/www/certbot -d "$DOMAIN" -m <operator email> --agree-tos --no-eff-email
```

Within a minute nginx logs `[tls] certificate found for $DOMAIN: HTTPS on`.

**Renewal:** `certbot` tries `certbot renew` twice a day; nginx reloads every
6 hours. Test it without touching the real certificate:

```bash
docker compose run --rm --entrypoint certbot certbot renew --dry-run --webroot -w /var/www/certbot
docker compose run --rm --entrypoint certbot certbot certificates     # expiry dates
```

**Reverse-proxy checks** from outside:

```bash
curl -I  http://$DOMAIN/api/health           # 301 to https
curl -sS https://$DOMAIN/api/health/ready    # {"status":"ready",…}
curl -sS -o /dev/null -w "%{http_code}\n" https://$DOMAIN/          # 404: the console is on Pages
curl -sS -o /dev/null -w "%{http_code}\n" https://$DOMAIN/api/debug/env   # 404
curl -sSI https://$DOMAIN/api/health | grep -ci strict-transport     # 1: one HSTS header
```

### nginx

API-only. `/api/` and `/uploads/` are proxied to the backend; `/` and
everything else answer **404** — the web console is on Cloudflare Pages, and a
copy here would be a second, older console one stale build away.

- `client_max_body_size 500m` on `/api/` — the largest multer limit
  (teacher content).
- `proxy_read_timeout`/`proxy_send_timeout` **600 s** on `/api/`, matching the
  backend's 10-minute request timeout; nginx's 60 s default cut long uploads
  and exports off with a 504.
- `/api/debug/` and `/api/admin/debug/` answer 404 at the door (the former is
  registered only outside production; the latter is called by no client).
- One copy of each security header: nginx sets HSTS, `nosniff` and
  `Referrer-Policy`, and hides the backend's (helmet) copies on proxied
  responses. `server_tokens off`.
- `Host` and `X-Forwarded-Proto` are forwarded: signed document URLs and
  `trust proxy` depend on them.
- `/uploads/` is **proxied, not served from disk**, so the backend's signature
  gate is always consulted. `Range`/`If-Range` forwarded; no caching headers.

### Logs, time, indexes

- **Logs:** every service writes Docker's `json-file` logs capped at 10 MB ×
  5 files.
- **Time:** the backend and nginx run with `TZ=Africa/Douala`.
- **Indexes:** see "Index provisioning" below.

### The Dockerfile

`node:24-alpine` (multi-arch). The `production` stage installs backend
production dependencies, copies `src/`, `middleware/`, `engine/`,
`scripts/calibration/` and `shared/`, creates the upload tree owned by the
non-root app user, and runs `node src/server.js`. It no longer builds the web
app: nothing in the backend served `public/web`, and the web build was the
slowest step of an ARM64 build. The `web` stage remains for a single-host
setup (`docker build --target web`) but the production stack does not use it.

The upload path is deliberate and was a real bug:

> Under `src/`, not `/app/uploads`. `server.js` runs as `node src/server.js`, so
> its `__dirname` is `/app/src` and every uploads path resolves from there.
> Creating `/app/uploads` made a directory the application never opens, and
> mounting the volume there meant every uploaded file was written to the
> container's writable layer and lost on the next deploy.

---

## Web: Cloudflare Pages

| Setting | Value |
|---|---|
| Root directory | `OfflineSchoolApp/web` (the build imports `../shared/requestPath.js`, so the whole repository must be checked out — Pages does this) |
| Build command | `npm ci && npm run build` |
| Output directory | `dist` |
| Environment | `NODE_VERSION=24`, `VITE_API_URL=https://<api-domain>/api` (production); a **staging** API URL for preview deployments |

The console uses `BrowserRouter`. With no `404.html` in the build, Pages serves
`index.html` for unknown paths, which is the SPA fallback it needs; do not add a
`404.html`. Add the Pages domain (and any custom domain) to `ALLOWED_ORIGINS`
exactly; preview deployments get unique subdomains and are deliberately **not**
allowed against production.

Known: `web/src/pages/students/AdmissionsPage.tsx` builds legacy relative
`/uploads` links from `window.location.origin`, which on Pages is not the API
(absolute signed URLs, the normal case, are unaffected).

---

## Releases: GitHub Actions (`.github/workflows/release.yml`)

Push a tag `vX.Y.Z` equal to `mobile/app.json` `version`. The workflow checks
its configuration first and fails by name if anything is missing, then builds
and attaches everything to a published GitHub **pre-release** (never marked
"Latest") with `SHA256SUMS`, for testers. It deploys nothing and enables no
auto-update. For a production release, promote the pre-release by hand after
testing.

The tester builds point at the dev backend (`https://offlineschool-app.onrender.com/api`
in both URL variables). It sleeps when idle and takes 30–60 s to wake, so the
first request waits: the desktop's server check allows 60 s, web and desktop
sign-in 120 s (`TIMEOUTS.signIn`); mobile sign-in has no timeout.

| Repository setting | Kind | Purpose |
|---|---|---|
| `EXPO_TOKEN` | secret | EAS Build (an Expo robot-user token) |
| `PRODUCTION_API_URL` | variable | `https://<api-domain>/api`, baked into the APK |
| `DESKTOP_RELEASE_ENABLED` | variable | `"true"` to build desktop installers (off until the desktop blockers are fixed) |
| `DESKTOP_API_URL` | variable | the API URL for the desktop build |

Actions are pinned to the commit SHAs of reviewed tags; the workflow token is
read-only except for the final job (`contents: write`, to create the release).

### Android

- **Build:** EAS Build, profile `production-apk` (`mobile/eas.json`): the
  production profile with `buildType: apk`, for direct installation. The store
  profile `production` still builds an AAB; `preview` is an APK against
  staging; `development` is a LAN debug build (cleartext HTTP, never shipped).
  EAS was chosen over a local Gradle build because the project has no
  `android/` folder and no signing configuration: a local build would need
  `expo prebuild` plus signing patched into generated Gradle files on every
  release.
- **One-time setup:** `cd mobile && npx eas-cli@24.8.0 init` (links the
  project; commits `extra.eas.projectId` to `app.json`), then
  `npx eas-cli@24.8.0 credentials` → Android → production → let EAS generate the
  keystore.
- **The signing key is permanent.** Every later update must be signed with the
  same key, or schools must uninstall (losing local data) to update. Download
  it once (`eas credentials` → Android → *Download credentials*), store the
  `.jks` and its passwords in two separate secure places (a password manager
  and an encrypted offline copy). Never commit it (`*.jks`/`*.keystore` are
  gitignored).
- `versionCode` is managed remotely by EAS (`appVersionSource: remote`,
  `autoIncrement`); `version` in `app.json` is the user-visible version and
  must match the tag.

### Desktop

- Targets (`desktop/electron-builder.yml`): Windows NSIS + portable (x64),
  Linux AppImage + deb (x64), macOS dmg (x64, arm64). The release workflow
  currently builds **Windows only** (`windows-latest`); add runners back to
  ship the others. No native modules.
- **Unsigned.** No Windows code-signing certificate or Apple Developer ID is
  configured. Windows SmartScreen shows "Windows protected your PC — unknown
  publisher" (More info → Run anyway) until a certificate builds reputation;
  macOS Gatekeeper refuses the app until allowed in System Settings → Privacy &
  Security. No auto-update is configured or enabled.
- **Connectivity fixed** ("Desktop: reaching the server" below) and **hard
  deletes reach the desktop** (docs/10). Test an installer against staging,
  then set `DESKTOP_RELEASE_ENABLED`.
- Rollback caution (unchanged): a machine that has run a newer build refuses an
  older one against the same local database (`store.js` schema version).

### Desktop: reaching the server (fixed 2026-10-17)

The packaged app opened to a blank window: under `loadFile` (file://) the
absolute asset paths pointed at the drive root, `BrowserRouter` saw a disk path,
requests the mirror could not answer went to `file:///api/…` (or, with an
absolute `VITE_API_URL`, bypassed the offline layer), they carried
`Origin: null`, and sync had no server address.

Now (`desktop/src/main/appProtocol.js`): the window is served from a privileged
`app://school/` scheme — `web/dist` with an `index.html` fallback, so assets and
routes work as on the web — and `app://school/api/…` and `/uploads/…` are
relayed by the main process to the school's server (Chromium's network stack:
the machine's proxy and certificates). The web build is unchanged, with its
relative `/api` base, so the offline layer still matches every path. No browser
origin reaches the server, so `ALLOWED_ORIGINS` needs nothing for the desktop;
authentication is the request's own bearer token.

**Server address:** set on a first-run screen (checked against `/api/health`
before it is saved; changeable from the login page), or shipped in the
installer as `package.json config.defaultServerUrl` (the release workflow writes
it from `DESKTOP_API_URL`). Sync uses the same address.

**Tests:** `npm run check:protocol` (Node: static serving, routing, traversal,
relay of headers, JSON, multipart, binary, gzip, errors, no server, offline) and
`npm run check:launch` (the real Electron app under xvfb: renders on
app://school/, `fetch` and `XMLHttpRequest` and a POST reach the server with no
Origin, deep links route, the first-run screen, offline = network error).
Needs the web build, the Electron binary and `xvfb-run`.

Before desktop installers ship: test one against **staging**, never production.

### Mobile

The mobile app reads `EXPO_PUBLIC_API_URL` at build time; release builds throw
at start-up without it. Media URLs are derived by stripping `/api`, correctly.

---

## Backups (`deploy/backup/`)

Atlas **M0 (free) clusters have no Atlas Cloud Backup and no point-in-time
restore**; check your tier's backup features in Atlas before relying on them.
The nightly `mongodump` below is the backup of record either way, and it lives
off the VM.

| File | Purpose |
|---|---|
| `mongo-backup.sh` | `mongodump` (gzip archive, UTC-timestamped name) → integrity check → `rclone` upload → size verified at the destination → only then delete archives older than `RETENTION_DAYS` (≥ 7). Nonzero exit on any failure. |
| `mongo-restore-staging.sh` | restore drill into an **empty, separate** staging database (`--nsFrom/--nsTo` rename, `--into=` confirmation, refuses the source database name, never `--drop`), then per-collection counts and checks of core collections |
| `backup.env.example` | configuration → `/etc/offlineschool/backup.env` (600) |
| `offlineschool-backup.service` / `.timer` | systemd, nightly 02:30 with a 15-minute random delay, `Persistent=true` |

Credentials: a **read-only** Atlas user for backups (not the app's user),
handed to `mongodump` via a mode-600 config file — never on the command line,
in logs or in archive names. The bucket key (R2 or B2, via `rclone config`)
should be scoped to that bucket. Install:

```bash
sudo apt-get install -y rclone        # and MongoDB Database Tools + mongosh (arm64/x86 .deb from mongodb.com)
sudo useradd --system --create-home offlineschool-backup
sudo install -d -o offlineschool-backup -m 700 /var/backups/offlineschool /etc/offlineschool
sudo install -m 600 -o offlineschool-backup deploy/backup/backup.env.example /etc/offlineschool/backup.env
sudo -u offlineschool-backup rclone config            # the r2: or b2: remote
sudo cp deploy/backup/offlineschool-backup.{service,timer} deploy/backup/offlineschool-uploads-backup.{service,timer} /etc/systemd/system/
sudo chmod 644 /etc/systemd/system/offlineschool-*backup.*
sudo systemctl daemon-reload
sudo systemctl enable --now offlineschool-backup.timer offlineschool-uploads-backup.timer
sudo systemctl start offlineschool-backup.service && journalctl -u offlineschool-backup -n 50
```

**Alerts:** set `HEALTHCHECK_URL` (healthchecks.io or similar): pinged at
start, success and `/fail`, and alerts when a night passes with no success.
`systemctl list-timers offlineschool-backup.timer` shows the next run.

**Uploads volume** (`uploads-backup.sh`, root, nightly 03:15): the photographs
and documents — the one piece of state on the VM. Incremental: `rclone sync`
to `…/uploads/current`, with every file changed or deleted since the last run
moved first to `…/uploads/changed/<UTC stamp>/`; then a one-way `rclone check`
(every file on the volume at the destination, same size) or the run fails; only
then `changed/` folders older than `RETENTION_DAYS` are removed. Restore with
`uploads-restore.sh --into=<empty dir> [--from=changed/<stamp>]` — into a
directory, never over the live volume; it prints a file count and size to
compare. A real recovery: stop the backend, copy the restored directory into
the volume, start it. Tested 2026-10-18 against a Docker volume and a local
rclone destination: first run, a change and a delete moved aside, retention,
restore (byte-identical), refusals.

**Restore drill** (monthly, and before launch): set `RESTORE_TARGET_URI` and
`RESTORE_TARGET_DB` to a staging cluster or a new database, then
`mongo-restore-staging.sh r2:…/offlineschool-<stamp>.archive.gz --into=restore_drill`.
It prints every collection's count and checks `schools`, `users`, `students`,
`classes` (and `resultsummaries`, `feepayments` where present). Compare the
counts with production; never point it at production.

---

## Index provisioning

Production connects with `autoIndex: false`, and mongoose's `Model.init()`
then builds **no** indexes. Only four are built at boot (`students.gateToken`,
the idempotency keys, the analysis-run lock, the sync tombstones). The 49 other
unique indexes — receipt numbers, marks, attendance, results, enrolment,
payroll, timetable — exist only once provisioned.

**Why autoIndex stays off.** On, every boot would ask Atlas to build all ~460
indexes in the background, and a unique build that meets existing duplicates
fails **silently** — which is how the gap arose. Deliberate provisioning (below)
plus a loud check is the replacement. Development and tests keep autoIndex on.

**The boot check** (`indexCheck.service`) compares each declared index with
the live ones on key **and** on what it enforces (unique, sparse, partial
filter, TTL): a plain index where a unique one is declared is `INCOMPATIBLE`,
not "verified". Missing or incompatible unique/TTL indexes are logged as errors
with what to run. **Readiness:** in production `GET /api/health/ready` answers
503 `INDEXES_INCOMPLETE` (with `criticalIndexProblems`) until they are in
place, re-checked every 5 minutes while failing — so `docker compose ps` and
any monitor show the deployment is not finished. nginx does not route on
health; this alerts, it does not take the API offline.

`backend/scripts/provision-indexes.js` (`npm run indexes:plan`):

- **default = plan, read-only:** per declared index, `present`, `missing` or
  `conflict` (same key, other options; or the declared name on another key);
  for every missing unique index, counts the duplicates it would refuse
  (respecting partial filters, sparse rules and array fields); warns where a
  sparse unique index has a `null` default (MongoDB indexes null, so the second
  null is refused).
- **`--apply`:** creates only missing indexes with no duplicates and no
  conflict, one at a time; never drops, never `syncIndexes`. Exit 1 if
  anything was skipped or failed.
- Reads `PROVISION_MONGODB_URI` (never `MONGODB_URI`), prints only host and
  database name.

```bash
cd OfflineSchoolApp/backend
PROVISION_MONGODB_URI='<staging uri>' node scripts/provision-indexes.js            # read the plan
PROVISION_MONGODB_URI='<staging uri>' node scripts/provision-indexes.js --apply    # off-peak
# then production, the same two steps
```

That form needs Node.js and `npm ci` in `backend/`. On the VM, use the container
commands in "Backend scripts on the VM" instead.

Resolve reported duplicates as a per-school data decision (money and results
rows need a person). Resolve conflicts by hand; the existing
`fix-enrollment-index.js` / `fix-payroll-index.js` (`--dry-run` first) replace
two known legacy indexes.

**Six definitions corrected (2026-10-17).** `School.email`, `School.code`,
`Conversation {schoolId, directKey}`, `GeneratedReport {examId, studentId}`,
`Student.userId` and `Student.enrollmentNo` were unique + sparse, and sparse
skips only a MISSING field: a stored `null` is indexed, so once built they
refused a second school without a code, a second non-direct conversation per
school, a second exam-less report per pupil, a second pupil without an account
(confirmed on MongoDB, and found in the demo data). They are now partial
`{ $type: "string" }` indexes under new names (`schools_email_unique_present`,
`schools_code_unique_present`, `conversation_direct_pair_unique`,
`generated_report_exam_student_unique`, `students_userId_unique_present`,
`students_enrollmentNo_unique_present`).

**Legacy indexes.** The plan also lists, as `legacy`, every live unique/TTL
index that no model declares: an index an older schema built still enforces
its old rule on every write. A **new** production database has none (it only
ever gets what provisioning creates). An older database does: the demo/staging
`school_db` had 12 (2026-10-17). Review each — some replace a rule the models
now state differently (`schools_code_unique` → the partial index; the old
`unique_student_attendance` without `periodId` refused a pupil's second lesson
of one subject in a day), some may be a rule worth declaring again (unique
class names per school) — then drop superseded ones by hand
(`db.<coll>.dropIndex("<name>")`, staging first). The tool never drops
anything.

---

## Launch checklist — 1 November 2026

**Blockers**

```text
[ ] Atlas: dedicated app user (readWrite on one database), read-only backup user, Network Access = VM IP only
[ ] Index plan run against staging, then production; duplicates resolved; missing unique indexes created; /api/health/ready no longer INDEXES_INCOMPLETE
[ ] Production on a NEW database (not school_db); staging rehearsal on school_db: legacy indexes reviewed and superseded ones dropped by hand, then --apply, then the plan shows nothing missing/incompatible/legacy
[ ] Domain DNS A/AAAA → VM; VCN + iptables open 80/443 only; first certificate issued; renewal dry-run passes
[ ] deploy/backend.env complete (chmod 600); backend "healthy" in docker compose ps
[ ] Cloudflare Pages: VITE_API_URL set; Pages domain(s) in ALLOWED_ORIGINS; login works end to end
[ ] Backups: both timers enabled (database, uploads); one successful run of each seen in the bucket; one restore drill of each passed; alerts configured
[ ] Android: eas init + keystore generated and backed up offline; EXPO_TOKEN + PRODUCTION_API_URL set; a test tag produces an installable APK
[ ] Desktop: an installer tested against staging (school_db) — until then DESKTOP_RELEASE_ENABLED stays unset
[ ] npm run check:all passes on the deployment commit
```

**Before or soon after**

```text
[ ] Oracle account on Pay As You Go (idle reclamation) with a budget alert
[ ] REQUIRE_MEDIA_SIGNATURE=1 seven days after launch
[ ] Sentry DSN set (backend, and VITE_SENTRY_DSN for the console)
[ ] Re-process results published before the lock check existed (docs/19)
```
