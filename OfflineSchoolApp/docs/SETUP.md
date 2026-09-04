# Setup, Running & Deployment

## 1. Prerequisites

- **Node.js 20+** and npm (backend, web, desktop)
- **MongoDB 7** — local install, Atlas cluster, or the Docker Compose stack
- **Expo CLI** via `npx expo start` for the mobile app (no global install needed)
- Docker + Docker Compose for containerised deployment

## 2. Environment variables (backend)

Copy `backend/.env.example` → `backend/.env`. The names below are exactly what
the code reads — the example file once listed names nothing read, so trust this
table over memory.

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no | Defaults to 5000. |
| `NODE_ENV` | no | `production` switches on `trust proxy`, strict CORS, combined logs. |
| `MONGODB_URI` | **yes** | e.g. `mongodb://user:pass@localhost:27017/school_app`. |
| `JWT_SECRET` | **yes** | 32+ characters. `config/env.js` refuses a short or placeholder value **at boot**. |
| `JWT_REFRESH_SECRET` | **yes** | Enables the refresh-token flow (`POST /auth/refresh`). |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES` | no | Defaults 30d / 90d. |
| `ALLOWED_ORIGINS` | **yes in prod** | Comma-separated CORS allow-list. |
| `SCHOOL_NAME` | no | Fallback name in emails and printed documents. |
| `APP_LOGIN_URL` | no | Sign-in link included in welcome emails. |
| `REQUIRE_MEDIA_SIGNATURE` | no | `1` enforces signed URLs for message attachments; unset = observe mode (log only). |
| `EMAIL_FROM` | for email | Must be a **verified** sender address in the provider account. |

### Email — exactly one provider block

Precedence order (deliberate): **SendGrid → Brevo → Gmail → generic SMTP**.

| Provider | Variables |
|---|---|
| Brevo (recommended for bulk) | `BREVO_SMTP_USER` (the SMTP login, not the account email), `BREVO_SMTP_KEY` (SMTP key, not API key) |
| SendGrid | `SENDGRID_API_KEY` (username `apikey` is supplied by the code) |
| Gmail (testing only) | `GMAIL_USER`, `GMAIL_APP_PASSWORD` (needs 2-Step Verification ON) |
| Any SMTP | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` |

`npm run mail:verify` reports which block is in force and whether the
credential is accepted — without printing it and without sending anything.
Nothing is delivered until one block is filled in.

## 3. Running each package

### Backend

```bash
cd backend
npm install
npm run dev        # nodemon src/server.js  → http://localhost:5000
npm start          # production entry (src/server.js)
```

Startup prints the full route table, verifies upload directories, starts the
notification dispatcher (60 s) and configures graceful shutdown. Health check:
`GET /api/health`.

### Web console

```bash
cd web
npm install
npm run dev        # Vite dev server
npm run build      # tsc -b && vite build  → dist/
npm run lint && npm run i18n:check
```

### Desktop app

```bash
cd web && npm run build        # desktop loads web/dist as-is
cd ../desktop
npm install
npm start                      # scripts/launch.js
npm run smoke                  # launch with smoke flag
npm run package                # build web + electron-builder → installer
npm run coverage               # route-coverage report of the API shim
```

Local data lives in `%APPDATA%/school-desktop` (Electron `userData`), outside
the installation directory on purpose.

### Mobile app

```bash
cd mobile
npm install        # .npmrc already sets legacy-peer-deps (Expo 57 / React 19)
npm start          # expo start
npm run android    # or: ios | web
npm run check      # check.js + eslint + tsc --noEmit
```

Expo configuration: `app.json`. Copy `.env.example` → `.env` for the API URL.

## 4. Verification suites (the test system)

There is no Jest/Vitest config; each package ships deterministic **check
scripts**. Backend checks run against `mongodb-memory-server` — no MongoDB
connection needed.

```bash
cd backend
npm run check:roles      # permission matrix, route by route
npm run check:approvals  # approval rules (thresholds, self-approval, waivers…)
npm run check:policy     # who-may-message-whom matrix
npm run check:mail       # email transport resolution
npm run check:reportcard # report-card pipeline
npm run check:tenancy    # announcement + student tenancy
npm run check:feed       # sync feed
npm run check:idem       # idempotency middleware
npm run check:desktop    # desktop parity (1300+ assertions)
npm run check:smoke      # bursar-path smoke test
npm run check:all        # everything
```

Other packages:

```bash
cd desktop && npm run check       # routes, store, outbox, sync, request path,
                                  # student writes, results, settings
cd mobile  && npm run check       # check.js + eslint + tsc
cd web     && npm run lint && npm run i18n:check
```

Maintenance / repair scripts (run deliberately, one at a time):

- `repair:templates` — repair report templates (also `check:tplrepair`)
- `repair-exam-coefficients.js`, `repair-result-identity.js` — data repairs
- `backfill-admission-numbers.js`, `backfill-subject-coefficients.js`
- `seed-academic-structure.js`, `seed-form1-students.js` — seeding
- `fix-enrollment-index.js`, `fix-payroll-index.js` — index fixes
- `migrate-school-logos.js`, `clean-unpublished-results.js`

## 5. Docker deployment

`docker-compose.yml` brings up three services:

```
nginx:alpine (80) ──► backend (5000) ──► mongo:7 (internal only)
```

1. **Secrets are required with no defaults** — the compose file fails fast if
   `MONGO_USER`, `MONGO_PASSWORD`, `JWT_SECRET` (32+ chars),
   `JWT_REFRESH_SECRET` or `ALLOWED_ORIGINS` are not set in the environment.
   Put real values in the deployment environment, never in git.
2. **Mongo has no host port mapping** — only the backend reaches it, over the
   Docker network. Publishing 27017 invites the internet to try the password.
3. **The Dockerfile** is multi-stage: stage 1 builds the web app
   (`web/dist`), stage 2 installs backend production dependencies, copies
   `backend/src` + `backend/middleware`, serves the web build from
   `public/web`, creates the upload directories, and runs as a **non-root
   user**.
4. **Nginx** (`nginx.conf`): serves the web app (`try_files … /index.html`),
   proxies `/api/` to `backend:5000` with a 500 MB upload limit (matching
   multer), and serves `/uploads/` with a 30-day cache. It must proxy
   `/uploads` to the backend for the media-signature gate to be consulted.
5. Volumes: `mongo_data` (database), `uploads_data` (shared between backend
   and nginx, mounted read-only in nginx).

Bring it up:

```bash
export MONGO_USER=… MONGO_PASSWORD=… JWT_SECRET=… JWT_REFRESH_SECRET=… ALLOWED_ORIGINS=https://school.example.com
docker compose up -d --build
curl http://localhost/api/health
```

## 6. Production checklist

- [ ] `JWT_SECRET` / `JWT_REFRESH_SECRET` are 32+ random characters
- [ ] `ALLOWED_ORIGINS` lists only real front-end origins
- [ ] Mongo not exposed to the host/network beyond the compose network
- [ ] Email provider configured and `npm run mail:verify` passes
- [ ] `REQUIRE_MEDIA_SIGNATURE=1` once client caches have refreshed
- [ ] Backups of `mongo_data` and `uploads_data` scheduled
- [ ] `NODE_ENV=production` (enables `trust proxy` + strict CORS)
