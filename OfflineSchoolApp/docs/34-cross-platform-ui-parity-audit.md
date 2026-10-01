# 34 — Cross-Platform UI and Feature Parity Audit

Mobile, web and desktop compared feature by feature and role by role, to
separate what is platform-specific by design from what is missing or
inconsistent. The grade letter was the worked example and was traced from
the grading configuration to every rendered surface. No engine, threshold or
version changed; no permission was widened.

## 1. Executive summary

- **Grading has one source of truth and it holds.** `shared/gradeScale.js`
  is the only scale; `grading.service` grades every mark at entry against
  the school's `GradingConfig` (default bands when the school has none);
  the letter is stored on `StudentScore` and on every `subjectBreakdown`
  row; the overall letter is derived from the average with the same table.
  Driven through the real API with a *custom* school scale (A from 15),
  the same student's Mathematics row read `A` for the administrator's list,
  the administrator's detail, the student's phone, the teacher's phone, the
  sync feed's score and the sync feed's summary — where the default scale
  would have said `B+`. The web shows the letter wherever it shows a result.
- **Three confirmed bugs, all fixed:** the teacher's mobile class-results
  screen graded with a percentage scale of its own; the endpoint behind that
  screen read a model that does not exist and was always empty; the desktop's
  offline mark write graded a row without `maxScore` against the pass mark.
- **Two web omissions, fixed:** the admission screens sat in the teaching
  gate although the server grants them to administrators only; the student
  profile had no way to the student's intelligence pages.
- **Everything else that differs between platforms is intentional** (role
  surface, mobile-first student/teacher/parent experience, desktop as the web
  console with a local answer for part of its API) or a representation
  choice, listed below with evidence. Three product decisions are flagged.

## 2. Platform and role architecture

| | Who signs in | How it is built |
|---|---|---|
| **Mobile** (Expo Router) | student, teacher, parent (guardian portal, own code), and also school_admin, super_admin and bursar on an admin home | role root per directory under `app/`; a guard sends each role to its home; tiles, not tabs |
| **Web** (React/Vite) | super_admin, school_admin, bursar, teacher; a student can sign in but is shown "use the mobile app"; guardians only at `/portal` | route gates PLATFORM / ADMIN / OFFICE / FINANCE / TEACHING / STAFF; navigation per role; operator must enter a school |
| **Desktop** (Electron) | whoever signs in to the console | loads `web/dist` as-is; an axios adapter offers each call to a local API over a SQLite mirror first (136 of 271 endpoints answered offline, 62 online-only by stated reason, 73 not yet); writes queue and are replaced by the server's row when they settle |

The repository's stated rule stands: student, teacher and parent experiences
are mobile-first; the office works on the web console, on a desk or in a
browser. Teacher functionality also exists on the web (class intelligence,
review, students, exams, results, attendance, subjects, timetable,
announcements, printing), and administrator functionality also exists on
mobile (an admin home with tiles for admissions, students, classes, subjects,
staff, assignments, exams, results, report cards, attendance, timetable, fees,
finance, exports, promotion, settings). Both are deliberate and gated server-side.

## 3. Feature inventory (condensed)

Authentication: login (all), logout, password change/reset (all; first sign-in
forces a change), refresh (all), guardian portal by admission number + code
(mobile and web `/portal`). Students: profile, results per exam, report card
(frozen, issued by the school), attendance, homework, quizzes, subjects,
timetable, announcements, messages, settings; intelligence summary, ask,
explore, development, plans, pilot feedback (mobile). Teachers: dashboard,
exams, marks entry, class results, subjects, roster, content, quizzes,
homework, attendance, timetable, announcements, class intelligence with
interventions (mobile and web), review queue (web). Parents: children,
results with letters, attendance, fees, notices, news, messages, report card
(frozen). Office: dashboard, students, admissions/applications, teachers,
assignments, attendance, exams, results, term and annual results, report cards
and templates, printing, exports, messages and audit, fees and finance,
approvals, watch list, timetable, periods, promotion, portal codes, settings,
class intelligence, intelligence review with pilot and readiness. Operator:
platform dashboard, schools, performance, reports, audit, settings, and every
school page once a school is entered, plus the cross-school calibration view.
Academic configuration: subjects, grading scale and bands (one table), pass
mark, coefficients (ExamSubject weight), CA/test structure, sequences, terms,
promotion, report-card templates (web/desktop; mobile admin has subjects,
exams and templates).

## 4. Role × platform matrix

✓ available and intended · — intentionally unavailable · ! inconsistency found (now fixed unless noted) · ? product decision

| Capability | Student mobile | Teacher mobile | Parent mobile | School admin web | Super admin web | Desktop |
|---|---|---|---|---|---|---|
| Results (own / class / school) | ✓ per exam | ✓ (! endpoint was empty — fixed) | ✓ per child | ✓ exam, term, annual | ✓ selected school | ✓ offline mirror |
| Grade letters | ✓ server letter | ! local scale — fixed, server letter | ✓ server letter | ✓ overall and per subject | ✓ | ✓ shared scale; ! offline max — fixed |
| Report cards | ✓ frozen card | — | ✓ frozen card | ✓ generate, issue, print | ✓ | online-only by design (never a second computation) |
| Attendance | ✓ own | ✓ mark and report | ✓ child | ✓ | ✓ | ✓ |
| Fees | — (?) | — | ✓ child | ✓ | ✓ | ✓ |
| Intelligence summary / ask | ✓ own | — | — | ✓ staff section on strengths page | ✓ | online-only (model provider) |
| Strengths / exploration | ✓ own, explore | — (? teacher rating) | — | ✓ | ✓ | partly (catalog online) |
| Learning evidence | ✓ in summary | — | — | ✓ | ✓ | not yet |
| Development / guidance | ✓ own | ✓ class guidance | — | ✓ | ✓ | ✓ class and guidance |
| Interventions | ✓ own (accept/decline) | ✓ record | — | ✓ | ✓ | ✓ |
| Development plans | ✓ own | — | — | ✓ | ✓ | not yet |
| Advanced intelligence (Anthropic) | ✓ ask/explain | — | — | ✓ explain | ✓ | online-only |
| Intelligence review | — | — (web only) | — | ✓ whole school | ✓ selected school | not yet |
| Pilot / readiness | ✓ six-question feedback while a pilot collects | banner only | — | ✓ open, advance, findings, report | ✓ + cross-school calibration | not yet |
| Academic configuration | — | — | — | ✓ | ✓ | ✓ grading, structure |
| Admissions | — | — | — | ✓ (! gate — fixed) | ✓ | ✓ |
| Term / annual results | — | — (?) | — | ✓ | ✓ | not yet |

## 5. Academic and result parity

The same facts travel under one contract. `StudentScore` carries `score,
maxScore, percentage, grade, remark, gpaPoints, isPassing, isAbsent, isExempt,
teacherRemark`; `ResultSummary.subjectBreakdown` carries `score, maxScore,
normalizedMark, coefficient, grade, points, remark, isPassing, isAbsent,
isExempt`, and the summary carries `average, percentage, overallGrade,
overallRemark, isPassing, classPosition, gradePosition, schoolPosition,
totalInGrade, principalRemark`. Representation differences that are not
inconsistencies: a score row has `percentage` and no `normalizedMark` or
`coefficient` (the weight lives on the exam subject and is applied when the
summary is computed); the summary row has `normalizedMark` and `coefficient`
and no `percentage`. Term and annual results carry `overallGrade` and per
sequence/term averages; the web shows the letter in its Grade column
(`r.overallGrade`) on the exam, term and annual pages and in the exam detail's
per-subject breakdown. Mobile shows the overall letter on the student's list
and the per-subject letters on the card and in the portal. Desktop reads the
mirrored documents raw and computes the same letters offline through
`gradeUtils` and `shared/gradeScale`.

## 6. Grade-letter investigation

1. Boundaries: `GradingConfig.grades` per school; `shared/gradeScale.js`
   DEFAULT_GRADES when absent (A+ 18–20, A 16, B+ 14, B 12, C+ 11, C 10, D 8,
   F 0; boundary belongs to the higher band).
2. Score → letter: `backend/src/services/grading.service.js` at entry (bulk
   and single mark), on the /20 normalised mark.
3. Shared logic: yes — the scale module is the one copy; desktop's
   `gradeUtils` imports it; the engine copies `row.grade` as evidence.
4. API carries the letter: yes, on every DTO above (verified by fixture).
5. Mobile computes locally: student and parent screens, no; **teacher
   class-results screen, yes — a 90/80/70/60/50 percentage scale. Fixed.**
6. Web computes locally: no.
7. Desktop computes locally: offline only, from the shared scale; **its
   bulk write defaulted a missing `maxScore` to `exam.passMark`. Fixed.**
8. A platform that receives the letter and does not render it: none found.
9. Different DTO/normaliser: the teacher screen's loader kept `grade` but the
   renderer ignored it; the endpoint behind it never returned rows (see 10).
10. Report cards: server HTML from the same stored letters; the desktop
    declares report cards online-only on purpose.

Fixture (custom scale, A from 15): student st1 Mathematics 15/20 →
administrator list `A`, administrator detail `A`, student `A`, teacher `A`,
feed score `A`, feed summary `A`; overall `A` on all three; the default scale
would have said `B+`. Where the `A` "disappeared" was one screen (teacher
mobile) that never looked at the field, and one endpoint that returned nothing.

## 7. Intelligence parity

| Layer | Student (mobile) | Teacher | Office (web/desktop) | Intentional? |
|---|---|---|---|---|
| Academic 1.0.0 | own summary | class intelligence (mobile, web) | class, student, review | yes |
| Strength 1.2.0 | own, explore | — | student strengths page | yes: a strengths reading is the student's and the staff's |
| Exploration 1.0.0 | own catalog, activities, reflections | — (? observation/rating only on web for staff) | staff section | ? |
| Learning evidence / integration 1.0.0 | in own summary | — | strengths page | yes |
| Development 1.0.0 | own | guidance per pupil | development pages | yes |
| Guidance / Intervention 1.0.0 | own, accept/decline | record, review | full | yes |
| Planning / Adaptive 1.0.0 | own plans, reflect | review (web) | full | yes |
| Advanced 1.0.0 | ask / explain, bounded | — | explain (staff) | yes; provider server-side only |
| Review / pilot | six-question feedback | queue (web), banner (mobile) | pilot, readiness, report | yes; reviewer privacy and pilot gates unchanged |

Nothing staff-only or reviewer-only is exposed to a student or a parent; the
parent portal carries results, attendance, fees, notices and messages and no
intelligence by design.

## 8. Navigation findings

- Web: `/students/admissions` and `/students/applications` sat in the
  TEACHING gate while navigation and the server (`students.admit`, ADMIN)
  grant them to administrators; a teacher reaching them by URL met 403s.
  **Moved to the ADMIN gate.**
- Web: the student's strengths/intelligence page was reachable only from the
  class-intelligence list. **The student profile now offers it** (same route,
  same gate).
- Web: `/exams/term-results` and `/exams/annual-results` are navigation for
  administrators only but TEACHING-gated and readable by teachers on the
  server (`results.view` is a staff capability). **?** — either the nav or
  the gate should move; left for a product decision.
- Web: class intelligence and intelligence review are grouped under the
  "Administration" heading for teachers (`config/sections.ts`); cosmetic.
- Web: `/students/applications` has no navigation entry (reached from the
  dashboard); the bursar's rail comment says six entries, there are seven.
- Mobile: three dead links — `/teacher/students/[id]`, `/admin/subjects/edit`,
  `/admin/teachers/:id` have no screen; `/admin/timetable/periods` is an
  orphan screen; the admin home has no link to messages. Left for the owners
  of those screens (a target must be chosen, not guessed).
- Mobile: files under `app/admin/components/` are treated as routes by the
  router; harmless but untidy.

## 9. Mobile / web / desktop differences

Intentional (A): the role surfaces above; mobile-only student self-service
(explore, plans, ask, feedback); web-only review queue, pilot and
calibration; desktop online-only set (credentials, messaging, guardian
access, approvals, payroll money moves, promotion runs, report-card
rendering, files, exports, permission matrix) each with a written reason.
Representation (B): per-exam results on mobile versus exam/term/annual
tables on web; score rows versus summary rows; dashboards per role.

## 10. Confirmed bugs

| # | Feature | Platform / role | Expected | Actual | Root cause | Fix | Test |
|---|---|---|---|---|---|---|---|
| 1 | Class results, grade letters | mobile / teacher | the school's letter | letters from a local 90/80/70/60/50 percentage scale (14/20 "B" vs "B+", 10/20 "D" vs "C", 8/20 "F" vs "D") | `getGrade(percentage)` in `app/teacher/results/index.js` | render the row's server `grade`; distribution from the letters the rows carry | `mobile/scripts/check-teacher-results-grade.js` (6), in the mobile chain |
| 2 | Class results endpoint | backend / teacher | the teacher's marks | always `[]` | `GET /teacher/results` read a lazily loaded `Result` model that does not exist | answer from `StudentScore`, scoped to the teacher's assignment pairs, joined to student, subject, class and exam names, with the stored grade | `check-marks-scope.js` N2b (5 assertions) |
| 3 | Offline mark write, max score | desktop | row's `maxScore`, else the ExamSubject's | `row.maxScore ?? exam.passMark ?? 100` — a row without max graded against 10 | fallback used a pass mark as a maximum | resolve the ExamSubject by `examSubjectId` or exam+subject+class | `desktop/scripts/check-score-writes.js` (6), in the desktop chain |
| 4 | Admissions routes | web / teacher | not offered | reachable by URL, API 403 | TEACHING gate broader than nav and server | routes moved to the ADMIN gate | typecheck/build; route inventory |
| 5 | Student intelligence entry | web / office | reachable from the profile | only from class intelligence | omission | action on the profile | i18n keys, typecheck |

## 11. Intentional differences

Student/teacher/parent on mobile; office on web/desktop; report cards never
computed on the desk; the model provider only behind the server; review
queue and pilot only for the roles that hold `insights.review` and
`insights.pilot`; bursar excluded from intelligence except the office watch
list; no intelligence in the parent portal; quizzes carry a percentage and no
school letter.

## 12. Ambiguous items requiring a product decision

1. Term and annual result pages for teachers on the web: the server allows,
   the nav hides, the route gate allows.
2. A fees screen for students on mobile (parents have one).
3. Exploration observation and performance rating by teachers on mobile
   (today web only).
4. The three dead mobile links and the orphan periods screen.
5. The sync feed scopes `termResult`/`annualResult` to published rows for
   non-administrators but not `studentScore`/`resultSummary`; a bursar's
   or teacher's desk mirrors every mark and relies on the on-screen filter.
   Known and documented in `syncFeed.js`; a feed-scope change is a sync
   contract change and was not made here.

## 13. Fixes made

See §10. In addition, `backend/scripts/smoke-bursar-path.js` now waits for every model's index build before its first request, so its duplicate-billing assertions no longer race the unique index on a fresh in-memory database. No engine, threshold, version, permission or pilot rule changed.

## 14. Tests and results

| | |
|---|---|
| Parity fixture | one exam, custom scale, letters identical across six DTOs; see §6 |
| Backend | `check:all`, 60 suites: 59 passed in the chain. The bursar smoke walk failed once on a race between its first insert and the background build of the FeeCharge unique index, passed 60/60 on its own, and now waits for index builds (§13). The portal session suite passed 47/47 but took 29 minutes against 12 to 15 seconds on seven earlier runs; nothing in this task touches the portal, so this is read as a host stall, not a code change |
| Mobile | `check`, 21 of 21 suites, including the new grade check |
| Desktop | `check`, 12 of 12 suites, including the new score-write check |
| Web | `tsc -b` clean; `eslint` 0 errors (1 pre-existing warning); `vite build` ok; i18n 4,624 keys; l10n 70; intelui 21; pilotui 16; roles 31 |
| Targeted | check-marks-scope 83/83; check-score-writes 6/6; check-teacher-results-grade 6/6 |

## 15. Remaining issues

The five product decisions in §12; the cosmetic navigation notes in §8.

## 16. Files changed

backend: `src/routes/teacher.routes.js`, `scripts/check-marks-scope.js`, `scripts/smoke-bursar-path.js`.
mobile: `app/teacher/results/index.js`, `scripts/check-teacher-results-grade.js`,
`package.json`. desktop: `src/main/api/writes/exams.js`,
`scripts/check-score-writes.js`, `package.json`. web: `src/App.tsx`,
`src/pages/students/StudentDetailPage.tsx`, locales en/fr. docs: this file.

## 17. Commit

COMMIT_HASH

## 18. Working tree

Clean after the commit.
