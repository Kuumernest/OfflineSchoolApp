# Pre-launch QA fixes (launch 1 Nov 2026)

Branch: `fix/launch-readiness`. One commit per numbered item, tagged with the
item number. Every calculation fix gets a check script in `backend/scripts/`
wired into `npm run check:all`. Ask the project owner before changing a
calculation rule beyond what is written here.

To resume: `git log master..HEAD --oneline`, then the first unticked item below.

Rules already decided: coefficients always applied; an absent subject is
removed with its coefficient; CA on/off per school; grading is /20.

## Decisions from the owner (2026-10-27)

- A8: several teachers on one class-subject are allowed; every screen lists them all.
- B2: school hours and periods are each school's own setting — no fixed defaults; warn when they disagree.
- B3: age range warning starts at Form 1 = 9–14, then +2 years per level up.

## Phase A — wrong numbers (fix first)

- [x] **A1** Class positions: rank denominator = pupils in that class with results (Term Results page and printed report card; find where "50" comes from). — `52088d7`
- [x] **A2** One term average everywhere: sum(mark × coef) / sum(coef of subjects with marks); shared in `shared/`, used by term results, report card, analytics, exports; same for annual. — `3fb211c`
- [x] **A3** One outstanding-balance function (no voided payments, current academic year) on Fees > Outstanding, Financial reports, Platform dashboard. — `0846dd5`
- [x] **A4** One pass rate: average ≥ school pass mark on /20, denominator = pupils with results, same exam/term/year scope. — `ccfaf44`
- [x] **A5** /20 everywhere on results analytics, exams overview, Students to watch; no GPA, no letter grades; the school's remark scale. — `shared/examAnalytics.js`
- [x] **A6** Rankings per class: class filter on exam analytics, rank within class; bottom-5 sorted ascending and numbered consistently. — `shared/examAnalytics.js` topAndBottom
- [x] **A7** Marks progress "2/0 entered": denominator = enrolled pupils in the class. — exam submissions now carry `totalStudents`
- [x] **A8** Teacher assignments: one source of truth (class-subject assignment) for Subjects page, exam marks screen, report card. — `shared/classSubjectTeachers.js`
- [x] **A9** French report header: all 10 region names translated; remark typo "Faire" → "Fair". — regions in `shared/officialHeader.js`; "Faire" is in a school's saved grading scale (data, not code) → repaired by the Phase D script after go-ahead

## Phase B — validation rules

- [x] **B1** Timetable: no lessons in Break/non-teaching rows; only a teacher assigned to that class+subject; Wednesday column width. — `shared/timetableRules.js`; existing bad slots listed by the Phase D report
- [x] **B2** School hours: one source of truth between Settings and Periods; warn on conflict; header counts teaching periods only. — both stay school-set (owner); warning on Settings + Periods; dashboard counts teaching periods only
- [ ] **B3** Student validation (frontend + backend): DOB not in future, age range per class level (warn, configurable); Cameroon phones → +237 + 9 digits; one system-generated admission number format for new pupils, report existing mismatches (don't rewrite).
- [x] **B4** Flag unassigned class-subjects on Dashboard and Teachers page; relabel "Subjects: 105" as class-subject pairs or show distinct subjects. — `classSubjectCoverage`; `GET /admin/class-subjects/unassigned`
- [ ] **B5** Year pickers on Progression and Academic structure default to the school's current academic year.

## Phase C — UX fixes (after A and B)

- [ ] **C1** Fee account page header: student's name and class.
- [ ] **C2** Loading states/skeletons instead of blank tables; report card speed (~3s each); batch class print (bulk query, no N+1).
- [ ] **C3** Attendance "–" instead of 0% when nobody was marked; 7-day chart counts school days only.
- [ ] **C4** Remove developer wording from school-facing screens; Intelligence review pilot section Super Admin only.
- [ ] **C5** Class intelligence: no change flag with < 3 data points; never "declined" and "strength emerging" for one subject; no duplicated phrasing.
- [ ] **C6** Students to watch: fee debt only when overdue.
- [ ] **C7** Consistency: shared DD/MM/YYYY + HH:mm formatter; line icons only; one primary button colour; Admissions vs Applications; class-name casing; Fees group header "Form 5 – 5 owing".
- [ ] **C8** Portal access: "Last opened" column ("Never" when null); guardian names; flag access codes linked to no student.
- [ ] **C9** Settings: broken school logo; Cameroon school types (Collège / Lycée, general/technical); pass mark label "/20".
- [ ] **C10** Student profile: results, attendance, fee balance, guardian contact. *(may go to follow-up PR)*
- [ ] **C11** Notifications: action items (marks awaiting approval, unpublished exams, overdue fees). *(may go to follow-up PR)*
- [ ] **C12** Report templates: 3 ready-made layouts + toggles; raw HTML as advanced. *(may go to follow-up PR)*

## Phase D — test data (prepare only, do NOT run)

- [ ] **D1** Cleanup script with dry-run: student "Bin Laden", "Testing testing" announcement, pupils sharing one test email; report Kena Academy (7 students, 0 teachers) and exams with no dates. Show dry-run output and wait for go-ahead before deleting.

## Final

- [ ] Run all suites; open PR listing what was fixed and what was skipped and why.

## Notes / skipped

- A5: Term and Annual Results showed `overallGrade`, which for schools on the shipped bands is a US letter (A+…F); replaced with the stored remark. The bands themselves (and their `gpaPoints`) were left in the data model.
- A8: Form 1 English has two active assignments (Mr Buh, Mr Kum); every screen shows both — allowed (owner, 2026-10-27).
- B2: the dashboard period-count fix (exclude breaks) has no automated test — the admin dashboard endpoint has no fixture harness yet.
