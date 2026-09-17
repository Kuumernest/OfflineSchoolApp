# 20 — Application-Wide Authorization, Tenancy and Data-Scoping Audit

*Branch `ca-assessment`, based on commit
`be214763f9e640d3d6fc11b72aea59f2293ed560`.*
*Trigger: a suspected messaging scoping problem ("users can see conversations
they should not have access to"), generalised to an application-wide audit per
the brief.*

The inventory (§4–§7) was produced **before** any code change: the report was
the deliverable, and reading the code against it is what separated the real
findings from the ones the existing check suites already covered. The fixes were
applied afterwards and are recorded with their verification in §10 — read §10
for what is fixed as of this revision, and §5/§6 for the finding text itself.

---

## 1. Method

Every router in `backend/src/routes` was inventoried (route + middleware chain),
every inline handler in `src/server.js` was read, and the services the portal
and messaging routers call were read end-to-end. Spot verification was then
performed on every endpoint that accepts an object id (`:id`, `:studentId`,
`:examId`, `:paymentId`, …), every statistics/aggregation route, the export
router, the sync feed boundary and the upload gate. Existing check suites
(`check-authz-matrix.js`, `check-cross-school.js`, `check-school-scope.js`,
`check-role-matrix.js`, `check-sync-feed.js`) were treated as evidence of
intent, not as proof — the code was read against them.

Citations are relative to `OfflineSchoolApp/backend/`.

## 2. The canonical model — verified sound

Three independent layers, all verified working:

1. **Who are you** — `middleware/auth.js`. JWT HS256, user lookup per request,
   `isActive` gate (immediate deactivation), `passwordChangedAt` staleness gate,
   school-deactivated gate, and the *door rule*: a school-scoped caller who
   names another school in query or body is refused (403 `SCHOOL_ACCESS_DENIED`),
   a super_admin's named school must exist (404 otherwise).
2. **May you do this** — `middleware/permissions.js` +
   `src/config/permissions.js`. Capability defaults as role sets, per-school
   overrides, locked (non-delegable) keys for marks/users/platform.
3. **Which school** — `src/utils/tenant.js` (`resolveSchoolId`,
   `namedAnotherSchool`, `guardSchoolParam`). Token first, request parameter
   honoured only for super_admin.

Guard aliases are consistent: `requirePermission`/`requireAnyPermission` on
nearly every router; the two raw `authorize()` uses that remain are the quiz
sitting surface and the admin router's STAFF floor.

The prior audit's informational note stands: **tenancy is application-level
only**. One database, one connection; nothing at the storage layer catches a
missing `schoolId` clause.

## 3. The messaging verdict

**No read-path breach exists.** Verified end to end, staff and portal:

- `policy.service.js` is a pure matrix; every route asks it and decides nothing
  itself. `canReadConversation` = same-school + participant, or admin audit
  (`messages.audit`, non-delegable, plus a per-school `adminAudit` switch).
  Posting = participant + not archived + not read-only. Bursar deliberately
  sends like a teacher and reads like nobody.
- `listFor` uses `$elemMatch` on the participant (the dotted-form bug is
  already fixed); `loadReadable` 404s instead of 403s; audit search filters by
  `schoolId` and returns metadata only; message delete and reactions are
  school-filtered; attachment uploads are discarded when the verdict denies;
  `resolveTargetPrincipal` is school-scoped; class groups are provisioned from
  the live roster (own class only, teachers via `TeacherAssignment`).
- Portal side: `studentId` only ever comes from `req.portal.studentIds`; every
  per-child query carries `schoolId` + `studentId`; thread reads require
  `isParticipant` on a school-scoped lookup.

The only messaging defect is **functional, not a leak**: a guardian cannot
message their *own* child — `findCandidateRecipients`/`canMessage` compare a
`User._id` against `GuardianAccess.studentIds`, which holds `Student._id`
(fails closed; prior audit Info-F).

## 4. Verified correct (no action)

| Area | Evidence |
|---|---|
| Authentication, refresh, change-password, staleness | `middleware/auth.js`; docs/06 |
| Door rule (query/body `schoolId`) | `middleware/auth.js:141-175` |
| Students routes (except F1–F4, F6, F7, F9, F11) | prior session, on file with this report |
| Portal (`portal.routes.js` + `portal.service.js`) | prior session; all 20 endpoints OK |
| Teachers list/detail/CRUD, classes, subjects by id | `admin.routes.js` `getTenantQuery` on every by-id path |
| Assignments delete | `getTenantQuery` (`admin.routes.js:3069`) |
| Promotion runs by id | `schoolId` in every `PromotionRun` lookup |
| Templates by id | `schoolId` in every lookup |
| Documents (class-list, id-cards, transcript, guardian-access) | `schoolId` in every lookup |
| Exams reads, `GET /:examId/scores` | `schoolId` in query |
| Fees (structures, payments, receipt, outstanding), finance, payroll | `resolveSchoolId` used throughout; receipts filtered by `studentId` on the portal side |
| Approvals (queue, decide, cancel, thresholds) | `schoolId` required and applied |
| Gate (scan, roster, today, token reissue) | `schoolId` required; roster is tokens-by-design for gate devices |
| Exports | per-kind capability check + `schoolId` filter (`buildExport({ held })`) |
| Insights, announcements stats | `schoolId` required |
| Quiz authoring + attempts | `SUBJECT_NOT_ASSIGNED` via `TeacherAssignment`; attempt by id ownership/school-scoped, 404-uniform |
| Homework | `assertManager` + `teacherTeaches` + ownership checks |
| Periods | `findPeriodForCaller` on all five write paths |
| Terms/annual results, academic structure | `utils/tenant.js` (documented fix) |
| Sync feed | per-collection permission + scope (`wholeSchool`, `teacherClasses`, …); boot-time classification |
| Sync push | `requirePermission("sync.push")`; declared unreachable by all four clients (docs/19 E1) |
| Uploads | separator-aware path jail; signed-media gate (observe mode; F4 of docs/19) |
| Super admin (schools, enter, admins, dashboard, audit) | `canManage/canAdmins/canAudit` capability guards; per-request school context only |
| User profile by id | school-scoped, 404-uniform (`user.routes.js:98-145`) |
| Messaging (staff + portal) | see §3 |

## 5. Findings — carried over from the students/portal audit

Full details were established in the session that produced them; they are
restated here in short form so this document is the single inventory. File
`src/routes/students.routes.js` unless noted.

| # | Sev | Finding |
|---|---|---|
| F1 | Medium | `GET /teacher/students` / `my-students`: `?classId=` bypasses the TeacherAssignment intersection (`:761`); full raw documents via `normaliseStudent` (`:276`). Teacher enumerates the school with guardian/medical/identity fields. |
| F2 | Medium | `POST /` dedup lookup `Student.findById(id)` (`:1580-1589`) has no `schoolId` — cross-tenant full-record read. |
| F3 | Low | `GET /subject-content` (`:1181`): unplaced student bypasses the class check; query never carries `schoolId`. |
| F4 | Medium | `normaliseStudent` spreads the whole lean document — `students.view` (bursar) receives `gateToken`, `documents[]`, `nationalId`, medical fields, defeating `students.viewFull`. |
| F5 | Low | Announcement read/acknowledge writes unscoped; the `server.js:420-489` copies are also role-less. |
| F6 | Low | `GET /debug-count` (`:1487`) returns a platform-wide `Student.countDocuments({})`. |
| F7 | Info | By-id student routes answer 403 (not 404) after `findById` confirms existence — `GET /:id` already answers 404 uniformly. |
| F8 | Medium | `POST /api/students/:id/enrollment-number` (`server.js:501-671`): no school scope, caller's school wins, cross-school User lookup by email, returns `tempPassword` always. Cross-tenant write + credential issuance. |
| F9 | Low | `PUT /profile` lets a student rewrite guardian contact fields, redirecting absence/fee/gate notifications. |
| F10 | Low | Portal login lockout is per-`GuardianAccess` row keyed by sequential admission numbers; 429-vs-401 distinguishes "code exists"; no IP throttle. |
| F11 | Low | `POST /apply` accepts unvalidated `schoolId`/`classId` and arbitrary `documents[].url`; no rate limit. |

Informational carry-overs: Info-A (super_admin + no `?schoolId` = platform-wide
read on `GET /` and `POST /:id/reset-password`), Info-B (email-clash guard
degrades for super_admin), Info-C (`announcement.routes.js` class-scoping on
the student surface), Info-D (portal access token outlives logout ≤20 min),
Info-E (`?academicYear[$ne]=` operator injection on `/fees`), Info-F (guardian
→ own child messaging broken, fails closed).

## 6. New findings (this sweep)

### N1 — Cross-tenant assignment row disclosed through the dedup shortcut

- **Feature:** teacher-assignment upsert (offline replay).
- **Endpoint/file:** `POST /api/admin/assignments` — `src/routes/admin.routes.js:2878-2888`.
- **Current behavior:** `TeacherAssignment.findById(String(id))` — no `schoolId`.
  A caller supplying another school's assignment `_id` receives that row
  (teacher/class/subject ids of the other school, `deduplicated: true`).
- **Expected:** `TeacherAssignment.findOne({ _id, schoolId })`; foreign id →
  treat as not-found and create normally.
- **Severity:** Low. Ids only, no PII; requires a foreign UUID; holders of
  `teachers.manage`/assignments manage are ADMIN_ROLES.
- **Root cause:** the same offline-replay dedup pattern that produced F2,
  written as a pure existence check.
- **Fix:** add `schoolId` to the lookup (super_admin: explicit school), and
  return a reduced shape (`serverId`/`clientId` only) on the dedup path.

### N2 — Exam bulk score writes ignore the teacher's assignment

- **Feature:** CA/sequence mark entry.
- **Endpoint/file:** `POST /api/exams/:examId/scores/bulk` — `src/routes/exam.routes.js:1176-1290` (and the single-score equivalents in the same router).
- **Current behavior:** `staffOnly = requirePermission("exams.view")`
  (`exam.routes.js:39`). The exam is school-checked and `guardResultWrite`
  enforces lock/publish, but **nothing checks `TeacherAssignment`** for the
  teacher's `(classId, subjectId)`.
- **Expected:** a teacher holding `exams.view` without `exams.manage` may
  write scores only for subjects/classes they are assigned, exactly as quiz
  authoring (`SUBJECT_NOT_ASSIGNED`, `quiz.routes.js:319,396`) and homework
  (`teacherTeaches`, `homework.controller.js:129`) already enforce.
- **Severity:** Medium (integrity, same school): any teacher (or any role a
  school grants `exams.view`) can alter any class's marks in their school.
  The marks feed averages, grades, rankings and published report cards.
- **Root cause:** guard is a capability, not a relationship; predates the
  assignment-check pattern the quiz and homework routers use.
- **Fix:** for `req.user.role === "teacher"`, resolve the caller's assignments
  for the school and refuse `403 SUBJECT_NOT_ASSIGNED` when
  `(classId, subjectId)` is not among them. Admins pass. **Policy question —
  see §8 before implementing.**

### N3 — Single-score upsert is unscoped on exam/student/subject

- **Feature:** single-mark correction.
- **Endpoint/file:** `POST /api/results/score` — `src/controllers/results.controller.js:1390-1470`.
- **Current behavior:** `schoolId: schoolId || req.user?.schoolId` is stamped
  onto written rows, but neither `StudentScore.findOne({ examId, studentId,
  subjectId })` nor the `create` verifies that `examId`, `studentId` and
  `subjectId` belong to the caller's school. No `TeacherAssignment` check
  either. The door rule keeps a caller from *naming* a foreign `schoolId`,
  but the target ids themselves are never validated.
- **Expected:** resolve the exam by `{ _id: examId, schoolId }` first (404
  otherwise); require the student and subject to resolve within the same
  school; enforce the teacher relationship as in N2.
- **Severity:** Medium. Cross-tenant mark write — a `results.edit` holder
  (teacher) who supplies another school's exam/student/subject UUIDs creates a
  score row that references the foreign student. Requires knowing foreign
  UUIDs, same reasoning as F2.
- **Root cause:** handler written before tenancy was centralised; the row's
  `schoolId` field was mistaken for the scope check.
- **Fix:** school-check the exam, then the student; assignment-check per N2.

### N4 — Publish paths are unscoped on exam and summary ids

- **Feature:** publishing/unpublishing results.
- **Endpoint/file:** `POST /api/results/:examId/publish` and
  `PUT /api/results/summary/:summaryId/publish` — `src/controllers/results.controller.js:1284-1384`.
- **Current behavior:** `ResultSummary.updateMany({ examId, classId? })` — no
  `schoolId` in the filter; `Exam.findByIdAndUpdate(examId)` unscoped;
  `ResultSummary.findById(summaryId)` unscoped before the publish toggle.
  `adminOnly = requirePermission("results.publish")` (ADMIN_ROLES,
  non-delegable) is the only guard.
- **Expected:** every lookup carries `schoolId` (super_admin: explicit school,
  404 uniformly otherwise), matching the read routes which already resolve a
  school.
- **Severity:** Medium. A school admin who supplies a foreign `examId` or
  summary id publishes or retracts *another school's* report cards — the exact
  "published under a family with no record" hazard the lock system exists to
  prevent, triggered cross-tenant. Requires foreign UUIDs.
- **Root cause:** same as N3.
- **Fix:** add `schoolId` to the three lookups; answer 404 uniformly.

### N5 — Score delete trusts the row's own school, not the caller's

- **Feature:** score deletion (audit-logged).
- **Endpoint/file:** `DELETE /api/results/score/:scoreId` — `src/controllers/results.controller.js:1491-1526`.
- **Current behavior:** `StudentScore.findById(req.params.scoreId)` unscoped;
  the `schoolId` handed to `guardResultWrite` is `String(score.schoolId)` —
  the row's own school. Nothing compares it to the caller's school.
- **Expected:** resolve by `{ _id, schoolId }` (super_admin: explicit school)
  and answer 404 uniformly.
- **Severity:** Medium. A `results.publish` holder can soft-delete any
  school's score by id.
- **Root cause:** the guard was retrofitted for lock/publish and reused the
  row's own field as if it were the caller's.
- **Fix:** one-line scope change plus the uniform-404 pattern.

### N6 — Super admin without a school reads/edits generated reports across schools

- **Feature:** generated report cards.
- **Endpoint/file:** `GET/PUT/DELETE /api/generated-reports/:id` — `src/routes/generated.report.routes.js:185-243`.
- **Current behavior:** `...(schoolId ? { schoolId } : {})` — a super_admin
  who names no school gets an unscoped lookup, and the row returned includes
  `renderedHtml` (a full report card of any school). PUT/DELETE behave the
  same on the write side.
- **Expected:** consistent with Info-A — acceptable as *platform* behavior,
  but it should be explicit and, on writes, deliberate (require a named
  school, or record it in the audit trail).
- **Severity:** Info/Low. Platform role only; same convention already noted on
  `GET /api/students`.
- **Fix:** document as intended platform behavior; optionally require
  `?schoolId` for the write paths so a mistake cannot silently cross schools.

### N7 — Attendance writes ignore the teacher's assignment

- **Feature:** the register.
- **Endpoint/file:** `POST /api/attendance/students/bulk` and `POST /api/attendance/students` — `src/routes/attendance.routes.js:451-700+`.
- **Current behavior:** `teachingOnly = requirePermission("attendance.mark")`
  (TEACHING_ROLES). Students are verified to exist in the named class of the
  caller's school, but nothing verifies the caller is *assigned* to that
  class/subject.
- **Expected:** relationship check as in N2 — **if** that is the school's
  policy. Attendance is routinely taken by a form master who may hold no
  subject assignment for the class; enforcing subject-level assignment here
  could break real workflows. See §8.
- **Severity:** Low (integrity, same school): any teacher can alter any
  class's register in their school. Real-world impact is lower than marks.
- **Root cause:** capability-only guard.
- **Fix:** policy decision first (§8). If enforced, a class-level (not
  subject-level) membership check fits attendance practice best.

## 7. Counts

- **Endpoints audited:** 56 (students/portal/server.js, prior session) + 148
  across the remaining 20 routers ≈ **209**, plus the 5 inline `server.js`
  handlers.
- **Services/models audited:** 34 services; all models via the sync-feed
  classification; 190+ Mongoose query sites inspected.
- **Features audited:** auth, users, platform admin, students, admissions,
  guardians/portal, teachers, academic structure, exams/CA, results, quizzes,
  homework, attendance, timetable, periods, fees, finance, payroll, messaging,
  announcements, approvals, documents/ID cards, exports, insights, gate,
  promotion, templates, generated reports, sync (feed + push), uploads,
  verification.
- **Findings:** Critical 0 · High 0 · Medium 8 (F1, F2, F4, F8, N2, N3, N4,
  N5) · Low 7 (F3, F5, F6, F9, F10, F11, N1; N7 Low) · Info 1 numbered (F7)
  + 6 carry-over informational notes + N6.

## 8. The two policy questions, and how they were answered

These were the only two findings that could not be fixed from the code alone,
because each changes what a teacher may do in the product rather than closing a
leak. Both are recorded here as **intentionally changed access rules** — if the
school's practice disagrees with either answer, the change is one constant.

**Q1 — Marks (N2/N3, exam + results writes).** Should a teacher be confined to
their assigned `(class, subject)` pairs when writing scores?

*Answer applied: yes, subject-level.* The permission registry already states
this as the intent ("Affecter un enseignant à une classe détermine qui peut
saisir les notes de qui"), and quiz authoring and homework already enforce it —
so refusing on the marks surface is consistency, not a new rule. Admins and
`super_admin` are unaffected. A teacher holding `exams.view` with **no**
assignments now writes nothing; that is the crux of the question, and it is a
deliberate consequence.

**Q2 — Attendance (N7, the register).** Should the register be restricted to the
caller's classes, and at class level or subject level?

*Answer applied: yes, at CLASS level.* A form master takes a whole class, not one
subject within it, so a subject-level rule would break the ordinary case. The
register is therefore writable by any teacher assigned to the class for any
subject; teachers assigned to no class cannot write registers at all. Admins and
`super_admin` are unaffected.

## 9. Fix order (as executed)

1. **F8** (cross-tenant login minting) — highest concrete exposure.
2. **F2 + N1** (dedup lookups) and **N3/N4/N5** (results unscoped ids) —
   one-line `schoolId` additions, uniform 404s.
3. **F1** (teacher classId bypass) + roster projection.
4. **F4** (normaliseStudent allow-list projection; `gateToken` never to
   non-admin).
5. **N2/N7** and **F5** after the §8 decision.
6. **F3, F6, F9, F10, F11, F7** (404-uniformity), N6 (document).
7. Regression tests for every fix in `backend/scripts/` (the established
   check-suite pattern), wired into `check:all`.





---

## 6b. Additional findings (sub-audits of the exam, results, admin, students and account routers)

These were established by the per-router sub-audits that ran alongside §5/§6
and were not carried into the first draft of this document. Same citation
convention. Status for each is in §10.

| # | Sev | Finding |
|---|---|---|
| X1 | High | `DELETE /api/exams/:examId/subjects/:subjectId` (`exam.routes.js`) carried no guard at all — any signed-in account of the school, a pupil included, could soft-delete a subject out of an exam. |
| X2 | High | `results.controller.js` per-student reads — `getStudentResult`, `getExamRankings` → `results.service.getRankings`, `buildStudentReportCardData` (behind `/reportcard`, `/reportcard/html`, reissue) — filtered on `{ examId, studentId }` or `Exam.findById` with no school. A `results.view` holder in one school read another school's marks, positions, DOB/photo and full class ranking; `/reportcard/html` also minted a public verification code for the foreign pupil and archived the card into the caller's school. |
| X3 | High | `POST …/reportcard/calculate` used `Exam.findById` and an unscoped `ResultSummary.findOne`, and called no `guardResultWrite`: a teacher could rewrite any school's summary — or a published/locked one in their own — from body numbers, unlogged. |
| X4 | High | `POST …/reportcard/reissue` looked up `GeneratedReport.findOne({ examId, studentId })` without school and overwrote the frozen card found. |
| X5 | High | `POST /api/generated-reports` upserted on `{ examId, studentId }`; the unique index spans the platform, so another school's ids MATCHED that school's row and `$set` re-parented it to the caller with new HTML. |
| X6 | Medium | Bulk sheet `ExamSubject.findById(body.examSubjectId)` accepted another school's row, whose `maxScore` validated the sheet and whose submission status was flipped. |
| X7 | Medium | `POST /api/templates/:id/preview` read `{ examId, studentId }` marks and `Exam.findById` unscoped — another school's pupil rendered into this school's template. |
| X8 | Low | Exam writes copied another school's class/subject/teacher names by id (`Class.find({_id:{$in}})`, `Subject.findById`, `User.findById`). |
| X9 | High | `PUT /api/admin/students/:id/approve`, re-approval branch: `User.findByIdAndUpdate(user._id, { password: tempPassword, … })` bypassed the `pre("save")` hash — the temporary password was stored in clear text (and, since bcrypt then rejected it, the pupil was locked out). |
| X10 | Medium | Same route: `Class.findById(classId)` — a pupil could be approved into another school's class. |
| X11 | Medium | Same route: `User.findOne({ enrollmentNo })` and the `Student.findOne({$or})` were platform-wide; a prefix collision adopted (renamed, re-passworded, re-homed) another school's pupil account. |
| X12 | Medium | `DELETE /api/admin/students/:id` fell back to `StudentApplication.findByIdAndUpdate(id)` with no tenant filter. |
| X13 | Medium | `PUT /api/admin/teachers/:id` set `email` through `findOneAndUpdate`, skipping the staff-email uniqueness hook — a teacher could be given another school's staff address and that account's sign-in became a coin toss. |
| X14 | Low | `POST /api/admin/classes` / `subjects` offline-replay dedup `findById(id)` returned another school's row. |
| X15 | Medium | `School.applicationsOpen` — the administrator's "close admissions" switch — was never read on either intake path (`public.routes.js`, `students.routes.js /apply`). |
| X16 | Medium | Public application uploads kept the client's file extension while validating only the declared MIME type: `{ name: "x.html", mimeType: "image/png" }` was stored as `x.html` and served as a page from the API origin. |
| X17 | Medium | Applicant documents (birth certificates, ID scans) land under `/uploads/applications`, which `express.static` serves to anyone holding the link; the signed-media gate protects `messages/` only and runs in observe mode. |
| X18 | Low | `GET /api/public/schools?search=` compiled the term into `$regex` unescaped, unauthenticated, un-rate-limited. |
| X19 | Low | `GET /api/users/:id` scoped by school only `if (req.user.schoolId)` — a school_admin row with no school read any user. |
| X20 | Low | Login answered a pupil's email with a distinct message ("Students must log in with their enrollment number"), an account-existence oracle the file's own `DUMMY_HASH` exists to prevent. |
| X21 | Low | A `mustResetPassword` login received a 90-day refresh token beside its 15-minute access token; the ceiling was nominal. |
| X22 | Low | Public application duplicate detection (`already_enrolled` / `already_pending` / silent overwrite of a rejected application) is an enrolment oracle keyed on name + guardian email. |
| X23 | Low | `public.routes.js` error handler echoes internal `err.message` (Mongoose cast errors) to anonymous callers. |
| X24 | Low | Legacy `GET/POST /api/teacher/exams/:examId/marks` compared `exam.subjectId` (a field Exam does not have — never matched) and skipped the check entirely when the exam was not found, writing `ExamMark` rows under any id. |
| X25 | Info | Legacy `POST /api/teacher/attendance/mark` resolves the Attendance MODULE rather than a model through its lazy getter and 500s after authorisation (functional, pre-existing). |
| X26 | Info | `POST /api/results/:examId/publish` (`publishResults`) named in N4 is exported but not routed; only the summary route exists. |

## 7b. The teacher's READ scope — an open policy question

The N2/N3/N7 decisions in §8 govern WRITES. Reads remain capability-wide:
`GET /api/exams/:examId/scores`, `GET /api/exams/:examId/results`,
`GET /api/results/:examId`, `/rankings`, `/stats`, the class-list and transcript
printables (`documents.routes.js`), `POST /term-results/compute` and
`/annual-results/compute`, and — for the device — the sync feed's
`studentScore`, `resultSummary`, `studentAttendance`, `exam`, `examSubject` and
`homework` collections all answer a teacher with the whole school (only the
`student` collection is narrowed to taught classes). `results.view` is
documented as "a look, not a licence" and this matches the product as built;
confining teachers' reads to their assigned classes would be a product change
and is **not made here**. Recorded for a decision.

## 10. Status as of this revision

Legend: **Fixed** = code changed in this revision or the one before it and
covered by a regression check; **Verified** = code changed, correctness
established by reading, no HTTP check (reason given); **Open** = not changed.

| Finding | Status | Where | Check |
|---|---|---|---|
| F1 teacher `?classId=` bypass + full documents | Fixed | `students.routes.js` (`handleTeacherStudents`, `pickRoster`; `resolveAssignedClassIds` active rows only). Root cause found under it: the resolver spread `NOT_DELETED` (an `$or`) next to the teacher `$or`, leaving one `$or` in the query — so it matched every assignment in the school and ANY teacher was handed every assigned class. Rewritten as `$and`. | `check-tenant-ids` |
| F2 enrolment dedup `findById` | Fixed | `students.routes.js POST /` (scoped; foreign id → 409, roster shape) | `check-tenant-ids` |
| F3 subject-content unplaced bypass | Fixed | `students.routes.js` (class from the record, `schoolId` on the query) | `check-tenant-ids` |
| F4 `students.view` receives the whole record | Fixed | `pickRoster` + `permissions.can(…, "students.viewFull")` on `GET /`, `GET /:id`, `/pending` | `check-tenant-ids` |
| F5 announcement receipts unscoped / role-less | Fixed | `utils/announcementScope.js`; `server.js` copies gain `studentOnly` | `check-tenant-ids` (router copy); `server.js` copies verified by reading — inline in `server.js`, not mountable in a harness |
| F6 platform-wide debug count | Fixed | `students.routes.js /debug-count` (school-scoped, governance roles; the `deletedAt` cast that 500'd it repaired) | `check-tenant-ids` |
| F7 403-after-`findById` oracle | Fixed | nine by-id student routes → scoped `findOne`, 404 | `check-tenant-ids` |
| F8 enrollment-number minting cross-school | Verified | `server.js` inline handler: student scoped to caller's school, login's school = student's, email lookup scoped | inline in `server.js`, not mountable in a harness; read line by line |
| F9 pupil rewrites guardian contact | Fixed | `PUT /profile` guardian fields fill-only | `check-tenant-ids` |
| F10 portal login brute force | Verified | `portal.routes.js` route limiter (15/15 min/IP, test opt-out) | rate limiter; not exercised in a suite |
| F11 public application trusts school/class/document URLs | Fixed | `students.routes.js /apply` (school exists, open, class of it, relative upload URLs only) | `check-tenant-ids` |
| N1 assignment dedup | Fixed | `admin.routes.js handleCreateAssignment` (scoped, ids-only shape) | `check-tenant-ids` |
| N2 bulk sheet ignores assignment | Fixed | `exam.routes.js`: pair derived from the exam's `ExamSubject`, `teacherAssigned` (active rows), pupils verified in school | `check-marks-scope` |
| N3 single mark unscoped / unassigned | Fixed | `results.controller.js upsertScore`: exam in school, pupil in school, class from `ExamSubject`, pair check before the write | `check-marks-scope` |
| N4 publish unscoped | Fixed | `publishResult` scoped (`publishResults` scoped too, but unrouted — X26) | `check-marks-scope` |
| N5 score delete trusts the row's school | Fixed | `deleteScore` scoped to the caller | `check-marks-scope` |
| N6 super_admin without a school reads across | Open (documented) | platform behaviour, consistent with Info-A | — |
| N7 register ignores assignment | Fixed | `attendance.routes.js` both POSTs, class-level; legacy `/teacher/attendance/mark` already class-level | `check-register-scope` |
| X1 | Fixed | `adminOnly` on the subject delete | `check-marks-scope` |
| X2 | Fixed | `loadScopedExam` anchors every per-student read; `getRankings(…, schoolId)` | `check-marks-scope` |
| X3 | Fixed | scoped, `guardResultWrite`, class-level teacher check, `logResultChange` | `check-marks-scope` |
| X4 | Fixed | reissue lookup carries `schoolId` | `check-marks-scope` |
| X5 | Fixed | exam + pupil verified in school, `schoolId` in the upsert filter, E11000 → 409 | `check-marks-scope` |
| X6 | Fixed | `ExamSubject` resolved by `{ _id, examId, schoolId }` | `check-marks-scope` |
| X7 | Fixed | preview anchored on `Exam.findOne({ _id, schoolId })` | `check-marks-scope` |
| X8 | Fixed | class/subject/teacher lookups carry `schoolId`; mismatch → 400 | `check-marks-scope` |
| X9 | Fixed | re-approval goes through `user.save()` | `check-tenant-ids` (hash asserted, temp password verifies) |
| X10 | Fixed | `Class.findOne(getTenantQuery(req, classId))` | `check-tenant-ids` |
| X11 | Verified | `enrollmentNo` lookups carry `schoolId` | read; a collision fixture would need two schools sharing a code prefix |
| X12 | Fixed | application fallback uses the tenant query | `check-tenant-ids` |
| X13 | Fixed | conflict check before the update | `check-tenant-ids` |
| X14 | Fixed | scoped dedup; foreign id → 409 | `check-tenant-ids` |
| X15 | Fixed | both intake paths refuse a closed school | `check-tenant-ids` (students `/apply`); `public.routes.js` verified by reading |
| X16 | Verified | extension from a MIME table, `.bin` otherwise, both upload paths | multipart/base64 harness not built |
| X17 | **Open** | needs signed URLs from the admin console before `applications/` can join `PROTECTED_PREFIXES`; the gate is in observe mode | — |
| X18 | Verified | `escapeRegex` + length cap | read |
| X19 | Fixed | fail closed without a school | `check-tenant-ids` |
| X20 | Fixed | dummy compare + generic 401 | `check-tenant-ids` |
| X21 | Partially fixed | no refresh token on a `mustResetPassword` login; the access-token refresh mode still renews within the token's own lifetime | `check-tenant-ids` |
| X22 | **Open** | product decision: uniform 202 vs. the present 409 detail | — |
| X23 | **Open** | minor; generic 500 body recommended | — |
| X24 | Fixed | exam in school (404), class-level assignment (403) | `check-marks-scope` |
| X25 | **Open** | pre-existing functional defect in a legacy route, outside this audit | `check-register-scope` pins the refusals only |
| Info-E `?academicYear[$ne]=` | Fixed | `String()` on the portal fee filter | — |
| Sync feed teacher scope | Fixed | `config/syncFeed.js taughtStudentsOnly`: active rows, model field | existing `check-sync-feed` |

### 10.1 Intentionally changed access rules

1. Teachers write marks only for their active `TeacherAssignment`
   (class, subject) pairs, on the bulk sheet and the single-mark route (§8 Q1).
   A teacher with no assignment writes no marks.
2. Teachers mark the register only for classes they hold an active assignment
   in, for any subject (§8 Q2). A teacher with no assignment marks no register.
3. Teachers recompute a pupil's summary (`/reportcard/calculate`) only for a
   class they are assigned to, and never a published or locked one; admins need
   a recorded reason. This follows from 1 and from the lock rule the mark
   routes already had.
4. The login answers a pupil's email exactly as an unknown one.
5. A `mustResetPassword` session carries no refresh token.
6. Closed admissions (`applicationsOpen: false`) are refused on both intake
   paths.
7. `students.view` without `students.viewFull` receives roster fields only.

### 10.2 Regression checks added

`scripts/check-marks-scope.js` (65 assertions), `scripts/check-register-scope.js`
(21), `scripts/check-tenant-ids.js` (53) — wired as `check:marks`,
`check:register`, `check:tenantids` and into `check:all`. Fixtures of
`check-portal-notices.js`, `check-attendance-history.js` and
`check-conflicts.js` now seed the `TeacherAssignment` rows a real teacher would
hold; `check-portal-session.js` opts out of the new guardian login limiter the
way `check-login-response.js` opts out of the staff one.

### 10.3 Validation, this revision

- Backend `check:all`, 54 suites: 3,753 assertions, 0 failures (run as the
  first 31 suites, then the remaining 23 after the portal-session fixture was
  given the limiter opt-out; no code changed between the two halves).
- Mobile `npm run check` (parse rules, i18n, l10n, ESLint, TypeScript): all
  suites pass; ESLint 0 errors, 49 pre-existing warnings.
- Web: `tsc -b` clean; ESLint 0 errors, 1 pre-existing warning;
  `check:normalisers` and `check:roles` pass.
- Desktop `npm run check`: all suites pass.
