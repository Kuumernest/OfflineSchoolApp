# My School On The Move — System Documentation

Complete documentation for **My School On The Move** (repository directory
`OfflineSchoolApp/`), an offline-first school management system built for
Cameroonian schools.

**Documented commit:** `be2d2ac` on `master`
**Documented at:** 2026-09-06
**Workspace root:** `c:\Projects\My School On The Move`

Everything here was derived by inspecting the repository at that commit and by
running its own verification suites. Where a claim could not be traced to code
or demonstrated by a suite, it is marked as such rather than asserted.

---

## Contents

| # | Document | Audience |
|---|---|---|
| 01 | [System overview](01-system-overview.md) | Everyone |
| 02 | [Architecture](02-architecture.md) | Developers, deployers |
| 03 | [Backend](03-backend.md) | Developers |
| 04 | [API reference](04-api-reference.md) | Developers, integrators |
| 05 | [Database](05-database.md) | Developers, DBAs |
| 06 | [Authentication, authorization & tenancy](06-authentication-authorization.md) | Developers, security |
| 07 | [Mobile application](07-mobile.md) | Developers |
| 08 | [Desktop application](08-desktop.md) | Developers |
| 09 | [Web application](09-web.md) | Developers |
| 10 | [Synchronization](10-synchronization.md) | Developers |
| 11 | [Conflict resolution](11-conflict-resolution.md) | Developers |
| 12 | [Academic workflows](12-academic-workflows.md) | Admins, developers |
| 13 | [Financial workflows](13-financial-workflows.md) | Bursars, developers |
| 14 | [Security](14-security.md) | Security review |
| 15 | [Performance](15-performance.md) | Deployers |
| 16 | [Testing](16-testing.md) | Developers, QA |
| 17 | [Deployment](17-deployment.md) | Deployers |
| 18 | [Operations & troubleshooting](18-operations-troubleshooting.md) | Operators |
| 19 | [Known limitations & production risks](19-known-limitations.md) | Everyone |
| 20 | [Email (Brevo transactional email)](20-email.md) | Operators, deployers |

The older sibling files `ARCHITECTURE.md`, `API.md`, `DATA_MODEL.md` and
`SETUP.md` predate this package (written 2026-09-04). They are shorter and
broadly accurate; this package supersedes them. They are not maintained by this
audit and may drift.

---

## How to read the status markers

Claims about behaviour carry one of four markers:

| Marker | Meaning |
|---|---|
| **IMPLEMENTATION VERIFIED** | Traced to specific source in this repository. |
| **TEST VERIFIED** | Demonstrated by a check suite that was *run* during this audit. |
| **CONFIGURATION DEPENDENT** | Depends on an environment variable or external service; behaviour differs by deployment. |
| **REQUIRES REAL-WORLD VALIDATION** | The code exists and reads correctly, but has not been proven against real hardware, real networks, or real data volumes. |

Features are additionally classified where it matters:

`IMPLEMENTED` · `PARTIALLY IMPLEMENTED` · `UNUSED / DEAD CODE` ·
`DEPRECATED` · `PLANNED` · `NOT IMPLEMENTED`

Nothing in this package describes intended behaviour as existing behaviour. Where
the code and its own comments disagree, both are reported — see
[19-known-limitations.md](19-known-limitations.md).

---

## Counts at the documented commit

Measured, not estimated:

| Thing | Count |
|---|---|
| Route files | 32 |
| Route handlers registered | 372 |
| Mongoose models | 56 (across 50 files) |
| Permission keys | 65 |
| Roles | 5 |
| Desktop sync feed collections | 36 |
| Mobile `/sync/pull` collections | 6 |
| Mobile SQLite tables | ~40 |
| Backend check suites in `check:all` | 39 scripts, 2 655 assertions |
| Mobile check assertions | 84 |
| Desktop check suites | 9 scripts, 216 assertions |
| Shared modules | 11 |
