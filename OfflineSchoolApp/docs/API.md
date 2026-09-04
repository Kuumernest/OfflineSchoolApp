# API Reference

Base URL: `http://<host>:5000/api` (behind Nginx: `http://<host>/api`).
All bodies are JSON unless noted. All authenticated requests use
`Authorization: Bearer <JWT>` (30-day access token, 90-day refresh).

Formats: health at `GET /api/health`; debug endpoints (`/api/debug/routes`,
`/api/debug/uploads`, `/api/debug/env`) exist in **non-production only**.

This is a generated-from-source summary — the router files under
`backend/src/routes/` remain the source of truth (330+ endpoints in total).

---

## Authentication — `auth.routes.js` (public)

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | Email **or** enrollment number + password. Rate-limited per IP. Temporary passwords get 15-minute tokens until reset. |
| POST | `/auth/refresh` | Two handlers: cookie/body refresh-token flow when `JWT_REFRESH_SECRET` is set, else re-authenticated refresh. |
| POST | `/auth/change-password` | Authenticated. |
| GET | `/auth/me` | Current user + permissions. |
| POST | `/auth/logout` | |

Role → home route (shared `getRoleRoute`): `super_admin`/`school_admin` →
`/admin/dashboard`, `teacher` → `/teacher/dashboard`, `student` → `/student`,
`mustResetPassword` → `/auth/set-password`.

## Public — `public.routes.js` (no auth, rate-limited)

| Method | Path | Notes |
|---|---|---|
| GET | `/public/schools` | Directory of schools for the application form. |
| GET | `/public/schools/:id` | School detail + its classes. |
| POST | `/public/students/apply` | Admission application. |

## Verification — `verify.routes.js` (public)

| Method | Path | Notes |
|---|---|---|
| GET | `/verify` , `/verify/:code` | Verify a printed document / ID card / report card by its code. |

## Guardian portal — `portal.routes.js` (portal token, not a User)

A portal token identifies a `GuardianAccess` row — that is why this router is
mounted **above** the `/api` auth/idempotency layer.

| Method | Path | |
|---|---|---|
| POST | `/portal/login` | Portal credential login. |
| GET | `/portal/me` | Linked students, guardian identity. |
| GET | `/portal/fees` , `/portal/fees/reminders` | Ledger and reminders. |
| GET | `/portal/notifications` | |
| GET | `/portal/receipt/:paymentId` | Printable receipt. |
| GET | `/portal/results` , `/portal/results/:summaryId/report-card` | Published results only. |
| GET | `/portal/messages/*` | Conversations, recipients, threads, read receipts. |
| GET | `/portal/attendance` | Attendance statistics. |
| GET | `/portal/announcements` | |

## Students — `students.routes.js`

Mounted at both `/api/students` (optional auth — roster reads are deliberately
open to the desktop's anonymous local path) and `/api/student` (auth).

| Method | Path | Permission / notes |
|---|---|---|
| POST | `/students/apply` | Public application (mobile admission flow). |
| GET | `/students/application-status/:id` | Public status check. |
| GET | `/students` | Register / roster: filter by class, student; used by the desktop parity suite. |
| POST | `/students` | Create student (staff). |
| GET | `/students/pending` , `/stats/summary` | Admissions queue, counters. |
| PUT/POST | `/students/:id/approve` · `/reject` | Approve/reject admission. |
| PATCH | `/students/:id/suspend` · `/restore` · `/move` | Lifecycle. |
| POST | `/students/:id/reset-password` | |
| POST | `/students/:id/enrollment-number` | Counter-based number generation. |
| DELETE | `/students/:id` | Soft delete (`deletedAt`). |
| GET | `/students/teacher/students` , `/teacher/my-students` | Teacher-scoped roster. |

## Admin — `admin.routes.js` (mounted last for `/api/admin`)

Dashboard, staff, classes, subjects, students, teacher assignments, settings.

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/stats` , `/admin/{students,teachers,classes,subjects,exams,attendance}/stats` | `dashboard.view` |
| GET/POST/PUT/DELETE | `/admin/teachers` (+`/:id`, `/:id/reset-password`) | `teachers.view` / `teachers.manage` |
| GET/POST/PUT/DELETE | `/admin/classes` (+`/:id`, `/:classId/subjects`) | |
| GET/POST/PUT/DELETE | `/admin/subjects` (+`/:id`) | |
| GET | `/admin/students` , `/students/approved` | |
| GET/POST/DELETE | `/admin/teacher-assignments` (+ `/bulk`) | |
| GET/PUT | `/admin/settings/grading` | Grading config. |
| GET/POST/DELETE | `/admin/settings/admins` (+ reset-password) | Admin management. |
| GET/PUT | `/admin/settings/profile` (+ `/password`) | School profile. |
| GET | `/admin/settings/analytics` | |
| GET/PUT | `/admin/school-info` | School name, logo, contact. |
| GET/PUT | `/admin/settings/id-card` | ID-card configuration. |

Mounted **before** admin (specific prefixes win):

- `permissions.routes.js` → `/api/admin/permissions`: `GET /` (registry),
  `PUT /:role` (per-role overrides; bursar/teacher only).
- `periods.routes.js` → `/api/admin/periods`: CRUD + `/toggle`, `/reorder`.
- `timetable.routes.js` → `/api/admin/timetable`: `GET /`, `POST /`,
  `PUT /:id`, `DELETE /:id`, `GET /teacher/:teacherId`, `GET /my-schedule`.

## Teacher — `teacher.routes.js` (all teacher-scoped)

`/me`, `/profile` (GET/PUT + `/password`), `/my-assignments`, `/assignments`,
`/stats/summary`, `/my-workload`, `/my-subjects` (+`/by-class`), `/my-classes`,
`/my-students`, `/my-timetable`, `/attendance/mark`, `/attendance/status`,
`/my-exams`, `/exams/:examId/marks` (GET/POST), `/my-homework`,
`POST /homework`, `/homework/:id/submissions`, `/my-quizzes`, `POST /quizzes`,
`/my-content` (+`DELETE /content/:id`, `PATCH /content/:id/status`),
`/subjects-classes`, `/results`, `/school/info`.

Also: `teacher-assignment.routes.js` → `/api/teacher-assignments`
(list, unassigned, per-teacher, bulk create, delete).

## Attendance — `attendance.routes.js`

Students: `GET /students/me|roster|today`, `GET /students`, `POST /students`,
`POST /students/bulk`.
Teachers: `GET /teachers/me|roster|today`, `GET /teachers`,
`POST /teachers`, `POST /teachers/bulk` (admin).
Reports: `/report/overview`, `/report/weekly`, `/report/class/:classId`,
`/report/period/:periodId`, `/report/student/:studentId`.

## Exams — `exam.routes.js`

`GET /` (list), `/dashboard`, `/stats`, `/reports{,/results,/submissions}`,
`/submissions{,/results,/submissions}`, `GET/PUT/DELETE /:id`, `POST /`,
`PATCH /:id/status`, `GET/POST /:examId/subjects`, `GET /:examId/scores`,
`POST /:examId/scores/bulk`, `POST /:examId/process` (compute results),
`GET /:examId/results`, `GET /:examId/submissions`,
`PATCH /:examId/lock` / `/:examId/unlock` (mark-entry locks).
Per-subject coefficient handling via `subjectCoefficient.service.js`.

## Results & report cards

| Router | Endpoints |
|---|---|
| `results.routes.js` | `GET /:examId` (+`/stats`, `/rankings`, `/student/:studentId`, `/history`), `POST /score`, `DELETE /score/:scoreId`, `PUT /summary/:summaryId/publish` |
| `termResults.routes.js` | `GET /`, `GET /student/:studentId`, `POST /compute`, `POST /publish`, `GET /:studentId/report-card` |
| `annualResults.routes.js` | same shape as term results, for the annual card |
| `template.routes.js` | report-card templates: list, default, tokens, seed, CRUD, preview, duplicate, set-default, `GET /:id/generated` |
| `generated.report.routes.js` | `POST /` (generate), list, `GET/PUT/DELETE /:id`, `GET /student/:studentId`, `GET /exam/:examId` |

## Fees — `fees.routes.js` (finance-role authorised inside)

`GET/POST /structures`, `PATCH /structures/:id/activate|deactivate`,
`POST /structures/:id/apply` (apply to families),
`GET /students/:studentId` (family ledger), `POST /payments`,
`POST /payments/:id/reverse`, `GET/POST /plans` (instalment plans, agreed
offline too), `POST /plans/:id/cancel`, `GET/POST /reminders`,
`GET/POST /penalties`, `POST /refunds` (writes nothing until approved),
`POST /charges/:chargeId/waive` (waiver → approval),
`GET /outstanding` (arrears list, 500-row cap with totals),
`GET /receipt/:paymentId`.

## Finance & payroll — `finance.routes.js` (admin-only inside)

`GET/POST /expense-categories`, `GET/POST /expenses`,
`POST /expenses/:id/void`, `GET /reports/summary` (income statement — four
load-bearing filters), `GET /staff`, `GET/POST /salary-structures`,
`GET /payroll` (+`/:runId`), `POST /payroll/generate`,
`POST /payroll/:runId/request-approval|confirm|reverse`.

## Approvals — `approvals.routes.js`

`GET /` (queue — differs per caller), `GET /summary`,
`POST /:id/approve` / `/:id/reject` / `/:id/cancel`, `PUT /thresholds`.
Rules in [`ARCHITECTURE.md §5`](ARCHITECTURE.md#5-roles-permissions-and-approvals).

## Academics — `academicStructure.routes.js`

`GET /:schoolId/:year`, `PUT /:schoolId/:year` (terms & structure),
`GET /:schoolId` (list years).

## Homework & quizzes

| Router | Endpoints |
|---|---|
| `homework.routes.js` | `GET/POST /`, `PUT/DELETE /:id`, `POST /:id/submissions`, `PATCH /:id/submissions/:submissionId/grade` |
| `quiz.routes.js` | `GET /sync`, `GET/POST /categories`, `GET/POST /questions` (+`PUT/DELETE /:id`), `GET/POST /quizzes` (+`PUT/DELETE /:id`), `POST /attempts`, `GET /attempts/:id`, `GET /analytics/quizzes/:quizId` |

## Announcements — `announcement.routes.js`

`GET /stats/summary`, `GET /student`, `POST /read-all`,
`POST /students/:id/read|acknowledge`, `GET /` (list, tenancy-checked),
`POST /`, `GET/PUT/DELETE /:id`, `POST /:id/read|acknowledge|pin`.

## Messaging — `messages.routes.js` (Users; portal has its own under `/portal`)

`GET /conversations`, `GET /recipients`, `POST /conversations/direct`,
`GET /conversations/:id` (+`/messages`), `POST /conversations/:id/messages`,
`POST /conversations/:id/attachments` (signed upload),
`POST /conversations/:id/read`, `GET /audit/conversations` (`messages.audit` —
never delegable), `DELETE /:messageId`, `POST /:messageId/reactions`.

## Gate — `gate.routes.js`

`POST /scan` (QR sign-in/out), `GET /roster`, `GET /today`.

## Insights — `insights.routes.js`

`GET /insights/early-warning` — the cross-module watch list (office-only).

## Documents & exports

| Router | Endpoints |
|---|---|
| `documents.routes.js` | `GET /class-list/:classId`, `GET /id-cards/:classId`, `GET /transcript/:studentId`, `PUT/DELETE /student-photo/:studentId`, `GET /verifications` (+`/:id/revoke|restore`), `GET/POST/PUT/DELETE /guardian-access` (portal credentials) |
| `export.routes.js` | `GET /` (catalogue), `GET /:kind` (Excel download, per-kind role check) |

## Promotion — `promotion.routes.js` (admin)

`GET/PUT /progression`, `GET /runs` (+`/:runId`), `POST /runs`,
`PATCH /runs/:runId/decisions/:studentId`, `DELETE /runs/:runId` (discard),
`POST /runs/:runId/commit`, `POST /runs/:runId/reverse`,
`GET /students/:studentId/history`.

## Sync — `sync.routes.js` (desktop/mobile)

| Method | Path | Notes |
|---|---|---|
| GET | `/sync/changes` , `/sync/pull` | Cursor-based change feed per collection. |
| POST | `/sync/push` | Client outbox writes; overwrites recorded in `SyncOverwrite`. |

## Users — `user.routes.js`

`GET /users/me`, `GET /users/:id`.

## Uploads

`GET /uploads/{*path}` — range-aware streaming with the media-signature gate
(see [`ARCHITECTURE.md §3`](ARCHITECTURE.md#3-backend-request-pipeline)).

## Error format

Errors return `{ success: false, message }` with proper status codes via the
shared `utils/response.js` helpers; the final error handler catches anything an
`asyncHandler`-wrapped route throws.
