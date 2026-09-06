# 09 — Web Application

*Documented commit `be2d2ac`. Source: `OfflineSchoolApp/web/`.*

The web console is the office-facing client: React 19 + Vite, TypeScript,
Tailwind. It is **online only** — no service worker, no local database, no
outbox. Offline capability on a desktop machine comes from the Electron app,
which serves this same build.

---

## Technology — IMPLEMENTATION VERIFIED

| Dependency | Version | Role |
|---|---|---|
| `react` / `react-dom` | ^19.2.8 | UI |
| `react-router-dom` | ^7.18.2 | Routing |
| `@tanstack/react-query` | ^5.101.4 | Server state, caching |
| `zustand` | ^5.0.14 | Client state |
| `axios` | ^1.19.0 | HTTP |
| `react-hook-form` + `@hookform/resolvers` + `zod` | ^7.85 / ^5.9 / ^3.25 | Forms and validation |
| `i18next` + `react-i18next` + `i18next-browser-languagedetector` | ^26 / ^17 / ^8.2 | en / fr |
| `recharts` | ^3.10.1 | Charts |
| `lucide-react` | ^1.30.0 | Icons |
| `date-fns` | ^4.4.0 | Dates |
| `clsx` + `tailwind-merge` | ^2.1 / ^3.6 | Class composition |
| `@sentry/react` | ^10.73.0 | Error reporting, inert without a DSN |

Build tooling: Vite, TypeScript (`tsconfig.json` + `.app.json` + `.node.json`),
Tailwind + PostCSS, ESLint.

Note `zod` is **^3.25** here while the backend is on **^4.4**. The two are not
shared, so this is not a conflict — but a schema copied between them will not
necessarily behave the same way.

---

## Structure

```text
web/src/
├── main.tsx           # entry
├── App.tsx            # 54 route declarations
├── pages/             # 24 feature directories + LoginPage, NotFoundPage
├── components/
├── services/          # axios clients, apiEndpoints.ts
├── store/             # zustand
├── hooks/
├── lib/
├── print/             # report-card and document rendering
├── i18n/
├── config/  constants/  types/  utils/  assets/
```

### Routing

`react-router-dom` v7, **54 route declarations** in `App.tsx`, with lazy imports
per page.

| Area | Routes |
|---|---|
| Students | `/students`, `/students/new`, `/students/:id`, `/students/admissions`, `/students/applications` |
| Academics | `/classes`, `/subjects`, `/subjects/add`, `/subjects/edit/:id`, `/periods`, `/attendance`, `/attendance/reports` |
| Teachers | `/teachers`, `/teachers/:id/edit`, `/teachers/assignments`, `/teachers/assignments/:id` |
| Exams | `/exams`, `/exams/new`, `/exams/:id`, `/exams/results`, `/exams/term-results`, `/exams/annual-results`, `/exams/reports` |
| Reports | `/reports`, `/reports/cards`, `/reports/templates`, `/reports/builder`, `/reports/preview` |
| Money | `/fees`, `/fees/structures`, `/fees/students/:studentId`, `/finance/expenses`, `/finance/payroll`, `/finance/salaries`, `/finance/reports`, `/approvals` |
| Communication | `/messages`, `/messages/audit`, `/announcements` |
| Portal admin | `/portal`, `/portal-codes` |
| Other | `/dashboard`, `/promotion`, `/promotion/progression`, `/documents`, `/exports`, `/settings`, `/login`, `/change-password`, `*` |

**Lazy chunking has a consequence worth knowing:** each page is its own chunk, so
a syntax error in one page is invisible until a user opens that route. A stray
backslash in `ClassesPage.tsx` took the classes page down while every other route
kept working. This is why CI runs `npm run build` (`tsc -b && vite build`) — it
parses every module.

---

## API access

### Production

The SPA calls `/api/...` on its own origin. nginx proxies `/api/` and `/uploads/`
to the backend. See [17-deployment.md](17-deployment.md).

### Development — IMPLEMENTATION VERIFIED

`vite.config.ts` proxies two prefixes to `http://localhost:5000`:

| Prefix | Why |
|---|---|
| `/api` | the API |
| `/uploads` | **required.** School logos are files served from the API server's *root*, not under `/api`. Without this proxy the dashboard banner and settings preview request `/uploads/...` from Vite, get its `index.html` back, and the image fails to decode. |

The dev server also excludes `node_modules`, `dist` and `.git` from the file
watcher — on a synced filesystem each watched path sits behind the sync filter,
and pre-bundling never finished.

### Browser routing requirement

The app uses history-mode routing. Any host serving the build **must** fall back
to `index.html` for unknown paths, or a refresh on `/students/abc` returns 404.
The bundled `nginx.conf` does this with `try_files $uri $uri/ /index.html`.

---

## Verification — TEST VERIFIED

| Command | What it does | CI |
|---|---|---|
| `npm run build` | `tsc -b && vite build` — type-checks and parses every module | **blocking** |
| `npm run i18n:check` | both locale files parse, cover the same keys, and every `t()` reference resolves | **blocking** |
| `npm run check:normalisers` | every field a normalised type declares is actually assigned by its normaliser | **blocking** |
| `npm run lint` | ESLint | **not wired in** — see below |

`check:normalisers` exists because `tsc` cannot see this class of bug: an
optional field left unassigned still satisfies the type. `normaliseClass` dropped
the class teacher that way, and the Edit Class dialog then showed every form
master as unassigned and cleared the real one on save.

All three blocking checks pass at this commit.

---

## Known lint backlog — MEASURED, NOT RESOLVED

`npm run lint` at this commit reports:

```text
65 problems (34 errors, 31 warnings)
```

| Rule | Count |
|---|---|
| `react-hooks/exhaustive-deps` | 31 (warnings) |
| `react-hooks/set-state-in-effect` | 20 (errors) |
| `@typescript-eslint/no-unused-vars` | 9 (errors) |
| `react-refresh/only-export-components` | 2 |
| `react-hooks/preserve-manual-memoization` | 2 |
| `react-hooks/incompatible-library` | 1 |
| `react-hooks/immutability` | 1 |

**These are not fixed.** The CI workflow deliberately omits the lint step and
says so in a comment; it should become blocking once the backlog is cleared. Note
the CI comment cites *"35 pre-existing errors"* — the current measured figure is
**34 errors and 31 warnings**, so the comment is marginally stale.

`set-state-in-effect` is the group that matters: 20 components call `setState`
from inside an effect, which risks extra render passes and, in React 19's
stricter mode, can surface as visible flicker or a render loop. None has been
observed to loop in practice, but none has been proven safe either.
**REQUIRES REAL-WORLD VALIDATION.**

---

## Not implemented in the web client

Stated so their absence is not mistaken for something undiscovered:

| | Status |
|---|---|
| Service worker / PWA offline | **NOT IMPLEMENTED** |
| Local database or outbox | **NOT IMPLEMENTED** — this is what the Electron app is for |
| `/sync/push` in `services/apiEndpoints.ts` | **UNUSED** — declared, invoked by nothing |
| Throttled-connection behaviour | **REQUIRES REAL-WORLD VALIDATION** — never measured under network throttling |
