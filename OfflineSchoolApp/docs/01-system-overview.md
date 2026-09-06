# 01 — System Overview

*Documented commit `be2d2ac`. Status markers as defined in [README](README.md).*

## What this system is

**My School On The Move** is a school management system for schools in Cameroon.
It manages the complete life of a school year: admissions, classes and subjects,
timetables, the daily register, exams and marks, term and annual results, report
cards, school fees, expenses, payroll, messaging with families, and a parent
portal.

Its defining constraint is that **it must keep working when the network does
not**. Two of its four clients hold a full local database and continue to accept
work while offline, synchronizing when a connection returns. That single
requirement shapes most of the architecture in this documentation — the
mutation outbox, the ID map, the sync cursors, and the conflict audit trails all
exist because of it.

### Localisation and conventions — IMPLEMENTATION VERIFIED

| Convention | Value |
|---|---|
| Currency | XAF (Central African CFA franc) |
| Marking scale | out of 20 |
| Languages | English and French, both complete (`mobile/src/i18n/locales/{en,fr}.json`, `web/src/i18n`) |
| Academic year format | `"2026/2027"` (string) |
| Terms per year | up to 3, `AcademicStructure.terms[].number` max 3 |
| Sequences per term | up to 6, `sequenceSchema.number` max 6 |
| Default pass mark | 10 / 20 (`AcademicStructure.passMark`) |
| Default promotion threshold | 10 / 20 (`AcademicStructure.promotionThreshold`) |

The report card renders in the reader's language including the grade **remark**,
not just the column labels — each grade band in `shared/gradeScale.js` carries an
English and a French remark.

---

## The four applications

| Application | Runtime | Offline | Primary users |
|---|---|---|---|
| **Backend** | Node.js + Express 5 + Mongoose 9 | n/a (server) | — |
| **Web console** | React 19 + Vite, browser | **No** — online only | Admins, bursars in the office |
| **Desktop** | Electron wrapping the web build | **Yes** — full local document store | A school office with poor connectivity |
| **Mobile** | Expo SDK 57 / React Native 0.86 | **Yes** — SQLite mirror | Teachers, admins, students, guardians |

There is also a **shared** directory of pure JavaScript modules consumed by
relative `require`/`import` from several packages — the grading scale, receipt
formatting, report-card assembly, attendance helpers. It is not an npm package
and has no manifest.

---

## Who uses it

Five roles exist in the `User` schema, plus one principal that is deliberately
not a user at all.

| Role | What they do |
|---|---|
| `super_admin` | Operates the deployment. The only role that may act across schools. |
| `school_admin` | Runs one school: users, academics, configuration, approvals. |
| `bursar` | Runs one school's money. Reads the roster; touches no grade. |
| `teacher` | Registers, marks, homework, their own classes. |
| `student` | Their own record and their own learning. |

**Guardians are not users and hold no role.** A parent authenticates against the
portal with a short code issued on paper, matched to a `GuardianAccess` row. One
code covers all of that guardian's children. See
[06-authentication-authorization.md](06-authentication-authorization.md).

The separation of `bursar` from `school_admin` is deliberate and documented in
`backend/src/config/roles.js`: the person who takes the money must not also be
able to change the grade of the child whose parent paid it. `payroll.setSalary`
and `approvals.decide` are withheld from the bursar for the same reason.

---

## Functional areas — IMPLEMENTED

Grouped as the API groups them. Route counts are handler registrations at this
commit.

| Area | Routes | Notes |
|---|---|---|
| Administration (`/api/admin`) | 58 | Users, classes, subjects, students, settings, grading config |
| Teacher workspace (`/api/teacher`) | 31 | A teacher's own classes, marks, content uploads |
| Students (`/api/students`, `/api/student`) | 29 | Roster, detail, enrolment, applications |
| Exams (`/api/exams`) | 28 | Exams, subjects, scores, results, publishing, locking |
| Fees (`/api/fees`) | 19 | Structures, charges, payments, receipts, plans, waivers |
| Attendance (`/api/attendance`) | 18 | Student and staff registers, reports, change history |
| Finance (`/api/finance`) | 17 | Expenses, payroll, financial reports |
| Portal (`/api/portal`) | 16 | Parent portal: fees, results, messages, attendance |
| Announcements | 13 | School-wide and targeted notices |
| Results (`/api/results`) | 13 | Report cards, rankings, result history |
| Quiz (`/api/quiz`) | 14 | Question banks, quizzes, attempts, analytics |
| Documents / Templates | 12 + 12 | ID cards, certificates, report-card templates |
| Messages (`/api/messages`) | 11 | Staff ↔ staff and staff ↔ guardian threads |
| Promotion (`/api/promotion`) | 10 | End-of-year promotion runs and decisions |
| Generated reports | 7 | Rendered report-card artefacts |
| Auth (`/api/auth`) | 6 | Login, refresh, change password, me, logout |
| Homework, Timetable, Periods | 6 + 6 + 7 | |
| Approvals (`/api/approvals`) | 6 | Threshold-based approval of financial actions |
| Gate (`/api/gate`) | 5 | Arrival/departure scanning |
| Term results / Annual results | 5 + 5 | Computed term and annual aggregates |
| Sync (`/api/sync`) | 3 | `pull`, `push`, `changes` |
| Academic structure | 3 | Year, terms, sequences, weights, thresholds |
| Public / Verify | 3 + 2 | Unauthenticated: application submission, document verification |
| Exports (`/api/exports`) | 2 | Excel exports |
| Users, Permissions, Insights | 2 + 2 + 1 | |
| **Total** | **372** | |

---

## What the system does *not* do

Stated so the absence is not mistaken for an undiscovered feature.

- **No SMS gateway.** `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are read
  by the code but are absent from `.env.example` and undocumented — see
  [19-known-limitations.md](19-known-limitations.md). Fee reminders and
  notifications are delivered in-app and by email.
- **No online payment collection.** Payments are recorded by a bursar after cash
  or transfer is received. There is no payment-gateway integration.
- **No student-facing offline mode with its own outbox.** Students use the
  mobile app online; the offline machinery is exercised by staff paths.
- **The web console is online-only.** It has no service worker and no local
  store. Offline capability on a desktop machine comes from the Electron app.
