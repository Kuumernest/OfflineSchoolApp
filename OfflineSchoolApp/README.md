# My School On The Move — OfflineSchoolApp

An **offline-first school management system** for schools with unreliable internet.
Everything a school runs on — admissions, the pupil roster, fees, exams, results,
payroll, the gate — keeps working with no connection, and reconciles with the
cloud server when one appears.

---

## At a glance

| | |
|---|---|
| **Backend** | Node.js 20 · Express 5 · MongoDB 7 (Mongoose 9) · JWT auth |
| **Web console** | React 19 · Vite · TypeScript · TailwindCSS 4 · TanStack Query |
| **Desktop console** | Electron 44 wrapping the web build + a local document store, outbox and sync engine |
| **Mobile app** | Expo SDK 57 (React Native 0.86) · expo-router · Redux Toolkit · SQLite |
| **Shared logic** | `shared/` — grading scales, receipts, report-card tokens, request-path parity |
| **Deployment** | Docker Compose: MongoDB + backend + Nginx reverse proxy |

## What it does

- **Admissions** — public application form → pending queue → approval → enrolment
  number. Two collections (Student / StudentApplication) merge into one queue.
- **Fees** — fee structures, charges, payments (with printable receipts),
  instalment plans agreed offline, penalties, arrears, reminders by email.
- **Finance** — expense categories, expenses, voids, income statement; payroll
  runs prepared, signed, then paid.
- **Approvals** — a segregated-of-duties queue: expenses, refunds, waivers and
  payroll above a school-configurable threshold wait for somebody else to
  approve. Nobody approves their own request; a waiver is revalidated at
  approval time.
- **Academics** — classes, subjects (with coefficients), teacher assignments,
  periods, timetable, attendance (per-period), homework, quizzes.
- **Exams & results** — exams with subject submissions and locks, score entry,
  term and annual results, publication, report-card templates, printable
  transcripts and ID cards.
- **Gate** — QR sign-in/sign-out with a roster and same-day view.
- **Communication** — announcements, messaging with a who-may-talk-to-whom
  policy matrix, guardian portal, notification dispatcher (email).
- **Offline sync** — the desktop app runs the same UI against a local database;
  an outbox drains to the server over a cursor-based pull/push protocol with
  idempotency keys, so a retried write is never applied twice.

## Roles

Five roles, defined once in `backend/src/config/roles.js`:

`super_admin` · `school_admin` · `bursar` · `teacher` · `student`

Guardians are not Users — they authenticate to the portal through a
`GuardianAccess` row. A capability registry (`config/permissions.js`) sits on
top of the roles; schools may delegate most of it, the ceiling (results,
promotions, user management, message audit) is not delegable.

## Repository layout

```
OfflineSchoolApp/
├── backend/        Express API, Mongoose models, services, sync feed, print, exports
│   ├── src/            server.js, routes/, controllers/, services/, db/models/, config/
│   ├── middleware/     auth, permissions, idempotency, error handler, uploads
│   └── scripts/        check:* verification suites, seeds, repairs
├── web/            React + Vite admin/teacher console (also powers the desktop app)
├── desktop/        Electron shell: local store, outbox, sync engine, API shim
├── mobile/         Expo app for teachers, students and guardians
├── shared/         Logic shared verbatim between backend and desktop
├── docker-compose.yml  mongo + backend + nginx
├── Dockerfile          multi-stage: builds web, serves it behind the API
└── nginx.conf          static web, /api proxy, /uploads cache
```

## Quick start

```bash
# 1. Backend
cd backend
cp .env.example .env          # then edit: MONGODB_URI, JWT_SECRET (32+ chars), …
npm install
npm run dev                   # http://localhost:5000  (health: /api/health)

# 2. Web console
cd ../web
npm install
npm run dev

# 3. Mobile app
cd ../mobile
npm install                   # .npmrc already sets legacy-peer-deps for Expo 57
npm start                     # Expo Dev Tools

# 4. Desktop app (needs the web build)
cd ../web && npm run build
cd ../desktop && npm install && npm start
```

## Verification suites

There is no separate unit-test framework; each package ships deterministic
**check scripts** (backend ones run against an in-memory MongoDB):

```bash
cd backend  && npm run check:all    # roles, approvals, tenancy, sync feed,
                                    # desktop parity, idempotency, payroll, …
cd desktop  && npm run check        # routes, store, outbox, sync engine, …
cd mobile   && npm run check        # check.js + eslint + tsc --noEmit
cd web      && npm run lint && npm run i18n:check
```

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, offline-sync protocol, roles & approvals, request pipeline |
| [`docs/API.md`](docs/API.md) | Full REST API reference: mounts, endpoints, auth rules |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Every Mongoose collection and how they relate |
| [`docs/SETUP.md`](docs/SETUP.md) | Environment variables, running, testing, Docker deployment, email |

## License

Private — © My School On The Move.
