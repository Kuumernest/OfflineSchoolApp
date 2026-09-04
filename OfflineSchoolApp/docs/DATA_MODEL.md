# Data Model

All models live in `backend/src/db/models/` (Mongoose 9, MongoDB 7). Every
school-scoped collection carries `schoolId`; soft-deleted documents carry
`deletedAt` rather than being removed. This page groups them by domain — the
schema files remain the source of truth for field definitions, validators and
indexes.

## People & access

| Model | Purpose |
|---|---|
| `User` | Staff, admins, teachers, students-as-users. Role enum = the five roles in `config/roles.js`. Passwords bcrypt-hashed; temp-password flag drives the 15-minute token rule. |
| `Student` | The pupil record: identity, class, status (pending / approved / suspended), photo, enrollment number. Merged with `StudentApplication` in the admissions queue. |
| `StudentApplication` | Public applications before conversion to a `Student`. |
| `Enrollment` | Student ↔ class/year link (with a uniqueness index — see `check-enrollment-index.js`). |
| `GuardianAccess` | Parent/guardian portal credential row. Not a `User`; authenticates the `/api/portal/*` surface. |
| `DocumentVerification` | Verification records for generated documents (revocable/restore-able). |

## Academic structure

| Model | Purpose |
|---|---|
| `School` | Tenant root: name, logo, settings, contact. |
| `Class` | Classes with a defined sort order. |
| `Subject` | Subjects with coefficients (`subjectCoefficient.service.js` repairs/normalises them). |
| `AcademicStructure` | Terms and year structure per school/year. |
| `Period` | Daily periods (toggle, reorder). |
| `TimetableSlot` | Timetable entries per class/subject/teacher. |
| `TeacherAssignment` | Teacher ↔ class/subject links (single + bulk). |

## Attendance, content & communication

| Model | Purpose |
|---|---|
| `Attendance` | Student and teacher attendance, per day and per period. |
| `GateEvent` | QR sign-in/sign-out events at the school gate. |
| `Content` | Teacher-uploaded learning material (syllabus, notes, video, audio, document, image) under `uploads/content/*`. |
| `Homework` | Assignments + submissions + grading state. |
| `QuizModule` | Quiz categories, questions, quizzes, attempts. |
| `Announcement` | Tenancy-checked announcements with read/acknowledge/pin state. |
| `Message` | Threaded messages; attachments under `uploads/messages` get **signed URLs** at read time (`mediaSignature.js`). |
| `Conversation` | Conversation membership + policy context. |
| `Notification` | Outbound queue drained by the 60-second dispatcher. |

## Fees & finance

| Model | Purpose |
|---|---|
| `FeeStructure` | Configurable fee items per class/year. |
| `FeeCharge` | A charge on a family's ledger (target of waivers). |
| `FeePayment` | Payments + reversals; receipts are printable and numbered (shared receipt counter). |
| `PaymentPlan` | Instalment plans — can be agreed with no connection. |
| `ExpenseCategory` , `Expense` | Spending with void support. |
| `SalaryStructure` , `SalaryPayment` | Staff pay configuration and payslips (joined to payroll runs). |
| `PayrollRun` | Prepared → approved (signed) → confirmed (paid); reversals recorded. |
| `ApprovalRequest` | The segregated-of-duties queue: kind (expense / refund / waiver / payroll), target, decision, frozen once decided. |
| `Counter` | Atomic sequence generator (enrollment numbers, receipt numbers). |

## Exams & results

| Model | Purpose |
|---|---|
| `Exam` | Exams with classes, terms, promotion flag, lock state. |
| `ExamSubject` | Per-exam subject submissions (submission status drives the pipeline). |
| `StudentScore` | Individual marks, coefficient-aware. |
| `ResultSummary` | Computed per-exam results; publish flag gates visibility. |
| `TermResult` , `AnnualResult` | Term and annual cards computed by `termGrading` / `annualGrading` services. |
| `ResultChangeLog` | Audit trail for changes to published results. |
| `ReportTemplate` | School-customisable report-card templates (token engine). |
| `GeneratedReport` | Generated report cards (per student/exam), stored and addressable. |
| `GradingConfig` , `Grade` | School-configurable grade scales and boundaries. |

## Promotions

| Model | Purpose |
|---|---|
| `PromotionRun` | An end-of-year rollover run (compute → decide → commit / reverse). |
| `PromotionDecision` | Per-student decision inside a run. |

## Sync & infrastructure

| Model | Purpose |
|---|---|
| `IdempotencyKey` | Deduplicates retried writes from offline clients. |
| `SyncLog` | Sync sessions/pushes for observability. |
| `SyncOverwrite` | Records where a pushed client write overwrote server state — nothing is silently lost. |
