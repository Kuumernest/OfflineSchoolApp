# 17 — Deployment

*Documented commit `be2d2ac`. Every command below was checked against the
relevant `package.json` or config file.*

> **Read [19-known-limitations.md](19-known-limitations.md) before deploying.**
> There is one confirmed defect in the bundled Compose stack, described under
> "Docker Compose" and repeated in 19.

---

## Prerequisites

| | |
|---|---|
| Node.js | **20+** (CI uses 20; no `engines` field is declared) |
| MongoDB | **7**, or MongoDB Atlas |
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
| `EMAIL_FROM` | unset | legacy override for `BREVO_SENDER_EMAIL` |
| `DISABLE_LOGIN_RATE_LIMIT` | unset | lifts the login limiter — **set only by `scripts/`, never in production** |

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

`GMAIL_USER` was in this list and is no longer read by anything: Gmail and
SendGrid were both removed from the provider registry when this app moved to
Brevo. An environment still holding `GMAIL_USER`, `GMAIL_APP_PASSWORD` or
`SENDGRID_API_KEY` is treated as **unconfigured** rather than routed through a
retired provider, and the startup log says so. See [20-email.md](20-email.md).

### Docker Compose — required with no default

`docker-compose.yml` uses `${VAR:?message}`, so the stack refuses to start
without:

`MONGO_USER` · `MONGO_PASSWORD` · `JWT_SECRET` · `JWT_REFRESH_SECRET` ·
`ALLOWED_ORIGINS`

### Mobile

| Variable | Required |
|---|---|
| `EXPO_PUBLIC_API_URL` | **yes for any release build.** `api.js` warns: *"a release build has no server to talk to"* if unset. |

### Web

No build-time environment variables. The SPA calls `/api` on its own origin; the
dev server proxies `/api` and `/uploads` to `http://localhost:5000`.

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

### HTTPS

**TLS is not terminated by this application and not by the bundled nginx
config** — it listens on port 80 only. Put a TLS terminator in front (a managed
load balancer, or an nginx/Caddy layer with certificates) before exposing this to
the internet. `X-Forwarded-Proto` is already forwarded by the bundled config, and
`trust proxy` is set in production, so the app is ready to sit behind one.

### CORS

`ALLOWED_ORIGINS` is a comma-separated allowlist and is **required in
production**. Outside production, CORS reflects *any* origin — do not leave a
public staging host at `NODE_ENV != production`.

---

## Docker Compose

```bash
cd OfflineSchoolApp
export MONGO_USER=… MONGO_PASSWORD=… JWT_SECRET=… JWT_REFRESH_SECRET=… ALLOWED_ORIGINS=…
docker compose up -d --build
```

Three services:

| Service | Image | Ports | Volumes |
|---|---|---|---|
| `mongo` | `mongo:7` | **none published** | `mongo_data:/data/db` |
| `backend` | built from `Dockerfile` | `5000:5000` | `uploads_data:/app/src/uploads` |
| `nginx` | `nginx:alpine` | `80:80` | `./nginx.conf` only |

### The Dockerfile

Two stages. Stage 1 builds the web app with Node 20 Alpine. Stage 2 installs
backend production dependencies, copies `src/` and `middleware/`, copies the web
build to `/app/public/web`, creates the upload directory tree, and runs as a
**non-root** user.

The upload path is deliberate and was a real bug:

> Under `src/`, not `/app/uploads`. `server.js` runs as `node src/server.js`, so
> its `__dirname` is `/app/src` and every uploads path resolves from there.
> Creating `/app/uploads` made a directory the application never opens, and
> mounting the volume there meant every uploaded file was written to the
> container's writable layer and lost on the next deploy.

### CONFIRMED DEFECT — the web console is not served by this stack

Three facts, each verified:

1. The Dockerfile copies the web build to `/app/public/web` **inside the backend
   image**.
2. `backend/src/server.js` has exactly **one** `express.static` call, and it
   serves `src/uploads`. Nothing serves `public/web`.
3. `nginx.conf`'s `location /` uses `root /app/public/web`, but the `nginx`
   service in `docker-compose.yml` mounts **only** `./nginx.conf`.

So the path `nginx` roots at does not exist in the nginx container, and no other
service serves the SPA. **`GET /` on the Compose stack returns nginx's 404.** The
API and `/uploads/` work correctly; the console does not load.

Either fix works:

- mount the build into nginx — copy `web/dist` to a volume or bind-mount it at
  `/app/public/web` in the `nginx` service; or
- serve it from Express — add `express.static(path.join(__dirname, "..", "public/web"))`
  plus an `index.html` fallback, and point `location /` at the backend.

**This is not fixed at this commit.** See
[19-known-limitations.md](19-known-limitations.md).

### nginx behaviour that is correct and deliberate

- `try_files $uri $uri/ /index.html` — required for history-mode routing.
- `client_max_body_size 500m` on `/api/` — matches the largest multer ceiling.
- `/uploads/` is **proxied, not served from disk**. The comment records why:
  `alias /uploads/` handed pupils' photographs, guardian correspondence and
  scanned admission documents to anyone who could name the path, with no token
  and no log. Proxying is the only way the backend's signature gate is consulted.
- `Range` and `If-Range` are forwarded so video and audio can seek.
- No `expires`/`immutable` on `/uploads/` — a cached response is one the gate
  never sees.

---

## Web deployment

```bash
cd OfflineSchoolApp/web
npm ci
npm run build        # tsc -b && vite build  →  dist/
```

Serve `dist/` from any static host **with an SPA fallback to `index.html`**, and
proxy `/api/` and `/uploads/` to the backend.

Build configuration: `outDir: dist`, `sourcemap: false`, and `manualChunks`
splitting React out of the app bundle.

---

## Desktop deployment

```bash
cd OfflineSchoolApp/desktop
npm ci
npm run package        # builds ../web first, then electron-builder
npm run package:dir    # unpacked, for testing
```

`package` runs `npm --prefix ../web run build` before `electron-builder`, so **a
desktop release requires a working web build**. Output goes to `desktop/dist/`;
packaging is configured in `electron-builder.yml`.

### Upgrade and migration behaviour

- On start, `store.js` applies any migrations the local database has not seen,
  each **inside a transaction with its version bump**.
- If the database's version is **greater** than the binary's `SCHEMA_VERSION`, the
  store **refuses to open it** — *"Update the application rather than downgrading
  it."*
- **Consequence for rollbacks:** once a machine has run a newer build, rolling
  that machine back to an older build will not start against the same database.
  Plan desktop rollouts accordingly.

Development launch: `npm start` (`node scripts/launch.js`).

---

## Mobile deployment

```bash
cd OfflineSchoolApp/mobile
npm ci                              # .npmrc supplies --legacy-peer-deps
EXPO_PUBLIC_API_URL=https://api.example.com npx expo start   # development
```

| Script | Command |
|---|---|
| `npm start` | `expo start` |
| `npm run android` | `expo start --android` |
| `npm run ios` | `expo start --ios` |
| `npm run web` | `expo start --web` |

### Production builds

**`EXPO_PUBLIC_API_URL` must be set at build time.** It is inlined into the
bundle; a release built without it has no server to talk to, and `api.js` says so
explicitly.

`package.json` declares **no EAS build scripts** and there is no `eas.json` in the
repository. Production builds go through `eas build` or a local `expo prebuild` +
native toolchain, configured outside this repo. **NOT CONFIGURED HERE.**

Development against a local backend needs a LAN address, not `localhost` — a
device is not the host machine.

---

## Deployment checklist

```text
[ ] Rotate every credential in .env — see 14-security.md
[ ] JWT_SECRET is 32+ characters and not a placeholder
[ ] ALLOWED_ORIGINS lists the real console origin(s)
[ ] NODE_ENV=production
[ ] TLS terminator in front of the stack
[ ] REQUIRE_MEDIA_SIGNATURE=1 (after one 7-day signature lifetime)
[ ] EXPO_PUBLIC_API_URL set for the mobile build
[ ] Fix the web-console serving defect above, or serve the SPA elsewhere
[ ] Remove or gate GET /api/admin/debug/counts
[ ] Confirm MONGO_USER / MONGO_PASSWORD are set (compose refuses otherwise)
[ ] Verify the uploads volume mounts at /app/src/uploads
[ ] Re-process results published before the lock check existed
[ ] npm run check:all passes on the deployment commit
```
