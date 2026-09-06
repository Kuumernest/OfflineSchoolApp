# 05 — Database

*Documented commit `be2d2ac`. Source: `backend/src/db/models/` — 50 files
registering **56 Mongoose models**.*

MongoDB 7 (Docker) or MongoDB Atlas. Mongoose 9.

---

## Global conventions — IMPLEMENTATION VERIFIED

| Convention | Detail |
|---|---|
| Primary key | `_id` is a **String**, not an ObjectId, on every model. Most default to `uuidv4()`. |
| Tenancy | Every school-scoped model carries `schoolId: { type: String, required: true, index: true }`. Four models have no `schoolId`: `School`, `IdempotencyKey`, `SyncLog`, `Counter` (`Counter` does carry one). |
| Timestamps | `{ timestamps: true }` on all but `Counter` — `createdAt` / `updatedAt`. `updatedAt` is what both sync cursors read. |
| Soft delete | `deletedAt: Date \| null`. Documents are not removed; queries filter `deletedAt: null`. |
| Version key | Mostly disabled (`versionKey: false`) on newer models. |

### Why `_id` is a string

Two reasons, both structural:

1. **Offline clients generate ids.** A device creating a student while offline
   must name it immediately; it cannot wait for the server. See the ID map in
   [07-mobile.md](07-mobile.md).
2. **Some ids are *derived from a natural key*.** Attendance rows and exam scores
   compute `_id` from the tuple that identifies them, which makes the write
   idempotent for free: a replay upserts the same `_id` instead of inserting a
   duplicate. This is load-bearing for sync — see
   [10-synchronization.md](10-synchronization.md).

---

## Duplicate-sensitive entities

These are the models where a duplicate is a real-world error — a pupil counted
twice, a payment recorded twice, a mark stored twice. Each has a **unique** index
enforcing the natural key.

| Model | Unique key | Guard style | Note |
|---|---|---|---|
| `StudentAttendance` | `{schoolId, classId, studentId, subjectId, periodId, date}` | `unique`, named `unique_student_attendance` | `_id` is *derived* from the same tuple |
| `TeacherAttendance` | equivalent tuple | `unique`, named `unique_teacher_attendance` | |
| `StudentScore` | `{examId, studentId, subjectId}` | `unique, sparse` | `_id` derived; one mark per pupil per subject per exam |
| `ResultSummary` | `{examId, studentId}` | `unique, sparse` | one summary per pupil per exam |
| `TermResult` | `{schoolId, academicYear, term, classId, studentId}` | `unique, sparse` | |
| `AnnualResult` | `{schoolId, academicYear, classId, studentId}` | `unique, sparse` | |
| `Enrollment` | `{schoolId, studentId, academicYear}` | `unique` + `partialFilterExpression: {deletedAt: null}` | a soft-deleted enrolment does not block re-enrolment |
| `FeePayment` | `{schoolId, receiptNo}` | `unique` + `partialFilterExpression: {receiptNo: {$type:"string"}}` | receipt number is null until issued |
| `SalaryPayment` | `{schoolId, userId, periodMonth, runId}` | `unique` + `partialFilterExpression: {deletedAt: null}` | plus a second unique index on `payslipNo` |
| `Student` | `{gateToken}` | `unique` + `partialFilterExpression: {gateToken: {$type:"string"}}` | |
| `IdempotencyKey` | `{key, userId}` | `unique` | plus a TTL index, 14 days |

### `sparse` versus `partialFilterExpression` — a real distinction here

`Student.gateToken` carries the lesson, recorded in the schema itself: a plain
`sparse: true` index excludes documents where the field is **missing**, but this
schema stores an explicit `gateToken: null` on every student, and MongoDB treats
`null` as a value for uniqueness. The result was the classic
`E11000 duplicate key { gateToken: null }`. A `partialFilterExpression` limiting
the index to real strings fixes it without migrating the existing nulls.

The same pattern is used for `FeePayment.receiptNo` and `SalaryPayment.payslipNo`
— both are null until issued — and for the `deletedAt: null` partials on
`Enrollment` and `SalaryPayment`, so that a soft-deleted row stops occupying its
natural key.

**FeePayment has no unique constraint on the payment itself.** Duplicate payment
prevention is done at the request layer, not by an index: either an
`Idempotency-Key` header, or a client-generated `_id` supplied in the body. A
retry carrying neither records two payments — which is the documented, tested
behaviour, not an oversight. See [13-financial-workflows.md](13-financial-workflows.md).

---

## Models by domain

### Identity and tenancy

| Model | Purpose | Notable |
|---|---|---|
| `School` | The tenant. | No `schoolId` — it *is* the school. 9 indexes. |
| `User` | Staff and student accounts. | `role` enum: `super_admin`, `school_admin`, `bursar`, `teacher`, `student`. `password`, `tempPassword`, `mustResetPassword`, `isActive`. 10 indexes. |
| `GuardianAccess` | A guardian's access code and the pupils it covers. | Guardians are **not** `User`s. One code covers all their children. |
| `Counter` | Atomic sequences behind receipt and enrolment numbers. | Not synced — two offline machines cannot share a counter. |

### Academic structure

| Model | Purpose |
|---|---|
| `AcademicStructure` | Year, terms, sequences, weights, `passMark`, `promotionThreshold`, `annualAverageMethod`, `promotionExams`, `maxAbsences`. |
| `Class` | A class/form. 12 indexes. |
| `Subject` | A subject, usually scoped to a class. |
| `Period` | Timetable periods. |
| `TeacherAssignment` | Which teacher teaches which subject in which class. |
| `TimetableSlot` | The timetable grid. |
| `Enrollment` | A pupil in a class for an academic year. |
| `GradingConfig` | Per-school grade bands; falls back to `shared/gradeScale.js`. |
| `Grade` | Computed grade records. |

### Pupils and admissions

| Model | Purpose |
|---|---|
| `Student` | The pupil record. `status`, `isActive`, `enrollmentNo`, `gateToken`, `classId`. 7 indexes. |
| `StudentApplication` | Pre-admission applications, including the public intake route. 11 indexes. |
| `PromotionRun`, `PromotionDecision` | End-of-year promotion. |
| `GateEvent` | Arrival and departure scans. |

### Assessment

| Model | Purpose |
|---|---|
| `Exam` | An exam sitting. `status`: `draft`, `scheduled`, `ongoing`, `completed`. |
| `ExamSubject` | Subject configuration within an exam (coefficient, max mark). |
| `StudentScore` | One mark. Derived `_id`. Carries `syncStatus`. |
| `ResultSummary` | Per-pupil per-exam aggregate: averages, positions, `isPublished`, `isLocked`. |
| `TermResult`, `AnnualResult` | Term and annual aggregates. |
| `ReportTemplate`, `GeneratedReport` | Report-card templates and rendered artefacts. |
| `QuizModule` | Registers **6 models** in one file: `QuestionCategory`, `Question`, `Quiz`, `QuizAttempt`, `QuestionAnalytics`, `QuizAnalytics`. |
| `Homework`, `Content` | Assignments and uploaded teaching material. |

### Attendance

| Model | Purpose |
|---|---|
| `Attendance.js` | Registers **two models**: `StudentAttendance` and `TeacherAttendance`. |
| `AttendanceChangeLog` | What a register entry used to say. See below. |

### Money

| Model | Purpose |
|---|---|
| `FeeStructure` | What a class owes for a year. |
| `FeeCharge` | A charge raised against a pupil. |
| `FeePayment` | A receipt. `receiptNo` unique per school once issued. |
| `PaymentPlan` | Instalment arrangements. |
| `Expense`, `ExpenseCategory` | Outgoings. |
| `SalaryStructure`, `PayrollRun`, `SalaryPayment` | Payroll, salaried and hourly. |
| `ApprovalRequest` | Threshold-gated approval of financial actions. |

### Communication

| Model | Purpose |
|---|---|
| `Conversation`, `Message` | Staff ↔ staff and staff ↔ guardian threads. |
| `Announcement` | School-wide and targeted notices. 8 indexes. |
| `Notification` | Rendered notifications. **Body can contain a temporary password** — see [14-security.md](14-security.md). |

### Operational and audit

| Model | Purpose | Synced to devices? |
|---|---|---|
| `IdempotencyKey` | Replay protection. TTL 14 days. | No |
| `SyncLog` | A record of device syncs. | No |
| `SyncOverwrite` | One admin's edit replaced another's. | No — it is an instruction *to* a device |
| `ResultChangeLog` | Audit trail of mark changes. | No |
| `AttendanceChangeLog` | Audit trail of register changes. | No |
| `DocumentVerification` | Public verification records. | No |

---

## The three audit collections

These exist because the system resolves conflicts by last-write-wins, and
last-write-wins is only acceptable while the losing write leaves a trace.

### `ResultChangeLog`

Every change to a mark, summary, exam subject or exam.

| Field | Notes |
|---|---|
| `entity` | enum `score`, `summary`, `examSubject`, `exam` |
| `entityId`, `examId`, `studentId`, `subjectId` | what changed |
| `action` | enum including `locked`, `unlocked` |
| `field`, `oldValue`, `newValue` | Mixed — the actual before/after |
| `reason` | the `changeReason` an admin supplies when editing published results |
| `isOverride` | indexed — flags an edit made against a lock |
| `changedBy`, `changedByName`, `changedByRole`, `changedAt` | actor, name denormalised because users get renamed |
| `batchId` | groups a bulk edit |

### `AttendanceChangeLog`

Added at commit `be2d2ac`. Records what a register entry used to say.

| Field | Notes |
|---|---|
| `attendanceId` | the derived `_id` of the register row |
| `studentId`, `date` | `date` is the register's own `"YYYY-MM-DD"` **string**, duplicated deliberately so a history list needs no join |
| `previousStatus` → `newStatus` | the crossing |
| `previousMarkedBy`, `previousMarkedAt` | the half that was previously unrecoverable |
| `changedBy`, `changedByName`, `changedByRole`, `changedAt` | who overwrote it |
| `source` | free text — `"sync"`, `"web"`, a device id. Free because clients disagree about what they are and a strict enum would reject the honest answer. |

Indexes: `{schoolId, studentId, changedAt:-1}` and `{schoolId, date, changedAt:-1}`.

**There is deliberately no de-duplication key.** A row is written only when the
status genuinely *moved*, which makes a replayed sync safe with no key at all:
the first attempt applies present → absent and records it; the replay reads
absent, finds new equal to old, and writes nothing. A deliberate change back is
three genuine rows, and any key clever enough to suppress the retry would
suppress that too.

**Scope limitation:** only the **student** bulk path writes this log.
`POST /api/attendance/teachers/bulk` does not. Staff register overwrites leave
no history. `PARTIALLY IMPLEMENTED`.

### `SyncOverwrite`

Where one admin's edit silently replaced another's more recent edit.

| Field | Notes |
|---|---|
| `entityType`, `entityId`, `entityName` | what was overwritten |
| `overwrittenBy`, `overwrittenByName`, `overwrittenAt`, `newAction` | who won |
| `lostEditBy`, `lostEditByName`, `lostEditAt` | who lost |
| `lostVersion` | **Mixed — a snapshot of the replaced version**, so a diff can be shown |
| `seenByLoser`, `seenAt`, `dismissedAt` | resolution tracking |

The mobile app has screens for this at `app/admin/sync-overwrites/`.

---

## Index verification — TEST VERIFIED

`backend/scripts/check-query-plans.js` seeds ~2 000 pupils across two schools
(16 000 scores, 10 000 register rows, 2 000 payments, 6 000 term results) and
asserts with `explain("executionStats")` that every hot query uses an `IXSCAN`
and not a collection scan. It passed 15/15 during this audit. Full numbers in
[15-performance.md](15-performance.md).
