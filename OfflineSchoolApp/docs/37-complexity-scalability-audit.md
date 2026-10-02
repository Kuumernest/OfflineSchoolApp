# 37 — Complexity and scalability audit

How the current implementation grows with the school: time, memory,
database work and the shape of the queries, read from the code and measured
on synthetic schools of 100 to 5,000 pupils. Fixes were made only where the
code did more work than the answer required and the answer could be kept
exactly; everything else is classified and left.

## 1. Scope

Academic results (mark reads and writes, result processing, term and annual
computation, rankings, statistics, report cards, lists, exports), the
intelligence pipeline (per-pupil readings, class intelligence, the
school-wide analysis behind review cases, calibration and preflight, the
advanced-intelligence context), both synchronisation architectures (the
phone's `/sync/pull`, the desk's `/sync/changes`), finance, attendance,
announcements, logs, and the three clients' rendering and local storage.
Not in scope: correctness, security, features, parity (docs/32–36).

## 2. Baseline

Branch `ca-assessment`, HEAD `8f4ea3d`, working tree clean before the audit.
Engines, thresholds and versions untouched throughout (academic 1.0.0,
strengths 1.2.0, the others 1.0.0).

## 3. Optimisations already in place, verified

| Claim (docs/32) | Verified |
|---|---|
| School-wide analysis memoised under a SHA-1 of the cohort, 2-minute TTL, six entries | yes: `reviewCases.service.js` `analyse`; a hit skips the 44 engine passes (baseline + 43 sensitivity runs). The key is the serialised cohort, so the queries, the cohort copy, the serialisation and the hash still run on every call (§7) |
| Engine input built once per analysis | yes: `toEngineInput` once, passed to every sensitivity run |
| Teacher class review 961 → 67 ms | yes: 66 ms at 1,200, 111 ms at 5,000 |
| Student summary ~106 ms | yes: 100 ms at 1,200, 55 queries |
| Strengths / development / guidance P95 ≤ 112 ms | yes: 41–72 ms p95 across all sizes |
| Query plans all IXSCAN (docs/15, `check-query-plans.js`) | yes for the sixteen queries it covers; it does not cover the change feed's idle page (§6) |

## 4. Complexity map

S pupils, M subjects per pupil, A published assessments per pupil (all
years), C classes, E exams in the school, T terms, V interventions, H
homework per class, R result rows. Query counts are per request.

| Operation | Time | Memory | Queries | Grows with |
|---|---|---|---|---|
| Mark sheet read, one class | O(S_c·M) | O(S_c·M) | 1 | class |
| Bulk mark write, one pair | O(S_c·B) | O(S_c) | 9–13 const | class |
| Result processing, one exam | O(S·M + S log S) | O(S·M) | 9 const | school |
| Term compute, whole school | O(S·M·E_t) | O(S_c·M) per class | 4 + 6C, sequential | classes |
| Annual compute, whole school | **was** 1 + 4C + 4–6 per pupil; **now** 4 + 6C | O(S_c) | see §5 | classes |
| Positions (term, annual) | **was** O(S_c²) per class; **now** O(S_c log S_c) | O(S_c) | 2 | class |
| Exam result list, page | O(R log R) sort in memory when no class is named | O(page) | 2–5 | exam |
| Rankings, page | **was** whole table read then sliced; **now** limit in the query | O(page) | 3–5 | exam |
| Statistics | O(R·M) | O(R·M) | 1–3 | exam |
| Sequence report card, one pupil | **was** O(S_e·M) cohort read; **now** O(S_c·M) | **was** 67 MB at 2,500 | 13–17 | class |
| Term / annual report card, one pupil | O(S_sch·M·E) — the whole school's marks for the period | 143 MB at 2,500 | 15–18 | school (§8) |
| Class print (client loop) | S_c × one card | — | S_c × 15 | class × above |
| Term / annual list, page | **was** whole-school staleness aggregation per page; **now** the page's pupils | O(page) | 5–6 | page |
| Class intelligence | O(S_c·A·M) | O(S_c·A·M) | 9–12 const | class |
| Pupil summary / strengths / guidance | O(A·M + H·S_c) | O(A·M + H·S_c) | 7–61 const in S | pupil's history |
| Review cases, whole school, miss | 44 × O(S·A·M) | O(S) profiles × 2 live | 9–14 const | school, CPU-bound |
| Review cases, hit | O(S·A·M) serialise + hash | 3 copies of the cohort | 9–14 | school |
| Preflight | review package + a second cohort load + 3 consistency checks | 2 × cohort | ~62–71 | school |
| `/sync/pull`, full | O(school) | whole response in memory | 6–16 | school |
| `/sync/changes`, page | **was** O(N) examined per collection per page; **now** O(page) | 500 × collections | 1 per collection + 1 | page |
| Fees outstanding | 1 + 2 aggregations | O(S) | 3 | school |
| Attendance class report | **was** O(S_c × records); **now** O(records) | O(records) | 2 | class × range |

## 5. N+1 findings

| Site | Verdict | Action |
|---|---|---|
| `annualGrading.computeClassAnnualAverages`: structure, grading config, term results and promotion exams read per pupil; one upsert per pupil (10,254 queries for 2,500 pupils) | genuine | **fixed**: one context per class, one read of the class's term results grouped by pupil, one read of promotion results, one `bulkWrite`; rows identical (checked pupil for pupil) |
| `GET /exams/:id/submissions` and `/submissions/submissions`: `countDocuments` per ExamSubject (1,500 counts at 5,000 pupils; the web polls the first every 30 s) | genuine | **fixed**: one `$group` per request |
| `exploration.history`: `ExplorationActivity.findOne` per non-catalog row | genuine, small (custom activities only) | documented |
| `intelligence-summary`: full strength/development stack rebuilt per intervention and per active plan (V + P_a + K times) | genuine, bounded by one pupil's interventions; 55 queries, 100–140 ms | documented (docs/32 left it; unchanged) |
| `sendReminders`, `notifyAbsences`: `School.findById` without projection + `Student.findOne` per family | genuine, office batch / per register | documented |
| portal guidance: `outcomeFor` per intervention rebuilds the child's history | genuine, per child | documented |
| `taughtStudentsOnly`: the teacher's assignments read once per scoped collection per feed page (6×) | redundant | **fixed**: memoised on the request |
| `getTeacherScope`: `Subject.find` without `schoolId` on fourteen teacher routes | tenant-unscoped scan of every school's subjects | **fixed**: scoped to the school |
| phone `pullAssignmentsFromServer`: per-row upsert and per-row user lookup, no transaction | genuine on the device | documented |
| desktop `merge`: SELECT + prepared INSERT per row inside one transaction | bounded (500 per page) | documented |
| finance `balancesFor`, `applyStructure`, payroll, attendance bulk write, finance reports | already batched | — |

## 6. MongoDB and index findings

**The change feed had no index for its own page.** `GET /api/sync/changes`
filters `{schoolId, updatedAt > at | (updatedAt = at, _id > id)}` and sorts
`{updatedAt, _id}`. Only Announcement and ReportTemplate had a
`{schoolId, updatedAt}` index. On every other collection the planner walked a
`schoolId`-prefixed index over every row of the school and top-k sorted, on
every page and on every idle poll — N documents examined to return none. The
phone's `/sync/pull` (`updatedAt >= since`) had the same shape.

Measured: `StudentScore` feed page at 2,500 pupils, 150,000 documents
examined for 150,000 returned (the first page of a full sync), 2.5 s; the
idle page examined every row to return zero (§13). **Added**
`{schoolId: 1, updatedAt: 1, _id: 1}` on the twenty-five collections the feed
pages that grow with the school (StudentScore, ResultSummary, student and
teacher attendance, FeeCharge, FeePayment, TermResult, AnnualResult, Student,
Homework, Enrollment, PromotionDecision, Expense, SalaryPayment, Exam,
ExamSubject, Class, Subject, TeacherAssignment, User, Period, Grade,
TimetableSlot, StudentApplication, ApprovalRequest). Cost: one more index
entry per write on each (StudentScore already maintains six), storage of the
order of 50 bytes per document. After: idle pages examine 0 documents on all
four collections checked.

**Production does not build declared indexes.** `autoIndex` is off when
`NODE_ENV=production` (`config/database.js`), and the server ensures only two
indexes at boot. The feed index, like every index in the models, reaches a
production database only through `syncIndexes()` or a deployment step.
**Decision required** (§15).

Other plans, from `explain("executionStats")` at 2,500 pupils: published
history for the school 10,000/10,000 (IXSCAN, 85 ms; the whole-school
analysis needs them all); one pupil's history 5 examined for 4 returned; the
exam list sorted by class position 2,500/2,500 (the sort is in memory when no
class is named — an `{examId, classPosition}` index would serve the
administrator's whole-exam list; not added: 333 ms at 2,500, once per page
view); class roster 40/40; name search by regex 2,500 examined for 111
returned (a regex cannot use an index; bounded by the school's roster);
term list 2,500/2,500 (covered).

Queries that scan the school's whole collection by design: `/exams/stats`
counts of unmarked scores (`{schoolId, score: null}` has only the `schoolId`
prefix); `getProtection`'s two `exists` on `{examId, isLocked|isPublished}`.
Both bounded and cheap at the sizes tested.

## 7. Intelligence scaling

Per-pupil routes are constant in S and linear in the pupil's own history:
guidance 7 queries, strengths 16, the summary 55, all 30–140 ms from 100 to
5,000 pupils. Class intelligence is one class's history in 12 queries, 90–150
ms at every size. None of them touches the school.

The school-wide analysis is the cost centre. Its input is every published
result of every pupil in scope with the subject breakdown, plus every exam
in the school, and the analysis runs the engine 44 times over it (the
baseline and a sensitivity sweep of eleven thresholds × four deltas). Both
are by design and neither is changed here.

| Pupils | Cold (miss), before → after | Heap during the miss, before → after | Warm (hit) | Heap during a hit |
|---|---|---|---|---|
| 1,200 | 16.6 s → 15.1 s | +514 → +184 MB | 0.9–1.0 s | +73 MB |
| 2,500 | 28.1 s → 26.3 s | +367 → +356 MB | 1.8–2.0 s | +109 MB |
| 5,000 | 60.6 s → 47.3 s | +1,114 → +700 MB | 3.0–3.7 s | +217 MB |

(The heap figure is the growth during the request over a collected
baseline; before the change the previous entry's profiles were still
resident when the next miss ran.)

Cold time grows about linearly (1,200 → 5,000: 3.6× for 4.2×). The hit is
not free: the cohort is loaded, copied into the cohort document, serialised
(`JSON.stringify`) and hashed on every call, which is what the 217 MB and
3.7 s at 5,000 are. The memo keeps only the engine's output.

Two things changed. The memoised report carried every pupil's full profile,
which nothing reads after the analysis (the route voids the report, the
calibration summary and the pilot read its reports and sensitivity table):
at 5,000 pupils that was hundreds of megabytes per entry, up to six entries.
The profiles are now dropped before the entry is kept; every output is
unchanged. Preflight's second full cohort load and its five reads of the
school's exams are documented, not changed (it is the head's pilot-time
operation).

**Remaining, documented (§15):** the per-call serialise-and-hash on a hit; a
cold miss at 5,000 pupils needs more than a gigabyte of heap and blocks the
event loop for a minute, so two concurrent misses on a default Node heap are
a crash risk; the sweep's 43 engine passes are the semantics of calibration.

## 8. Results and report cards

Result processing is nine queries and one `bulkWrite` whatever the size; its
time is the JavaScript loop and the write (§13; linear). Term compute is six
queries per class, sequential, one `bulkWrite` per class. Annual compute was
the N+1 of §5 and is now the same shape as term compute.

Report cards: a **sequence** card read every score of the exam across every
class to rank one pupil per subject. The ranking groups by `examSubjectId`
(the pupil's own paper) and looks the pupil up in that group only, so the
rows that can move the pupil's place are those sharing one of their keys;
the read now carries those keys. Positions are unchanged (checked:
every subject placed, out of the class's size). A **term** or **annual** card
reads every mark of every pupil in the school for the period, because its
per-subject position is keyed by `subjectId` and is therefore school-wide;
the code's comment says per class. Whether a term card's subject position is
the class's or the school's is a product question, so this read is left as it
is (143 MB and 1.9 s per card at 2,500; a class print of forty cards reads
the school forty times). **Decision required** (§15).

## 9. Rankings and statistics

Rankings sort in the database on the position index and now cut the page
there too; the name backfill runs over the page. Statistics read the exam's
summaries with their breakdowns (R·M) once; linear, 0.9 s at 2,500, 1.9 s
at 5,000 for a teacher — bounded by the exam. No ranking semantics changed.

## 10. Synchronisation

**Desk (`/sync/changes`).** One query per collection per page, ~40 in
sequence; page size 500, at most 2,000; cursor a keyset of (updatedAt, _id).
The index gap of §6 made every page and every idle poll a full walk of each
collection; fixed. The engine re-requests every collection on every page
even once exhausted (client side, documented). Memory per page: up to 500
rows × collections, built in one response (1.3–1.8 MB measured for a
teacher's first page).

**Phone (`/sync/pull`).** Six collections, no paging: a first sync carries
the whole school in one response (1.6 MB at 2,500 pupils for an
administrator). Soft deletes are filtered out and `deletedItems` is always
empty, so a deletion never reaches the phone except through the whole-list
pulls. The phone also pulls the last 30 days of the **whole school's**
attendance on every sync, unpaged and not narrowed to the teacher's classes;
at 2,000 pupils that is of the order of 250,000 rows per device per sync.
These are contract and design questions, not local fixes (§15).

## 11. Clients

Web: lists are paginated or class-scoped except the exam detail's results
tab (every pupil of the exam), the whole-school review queue, the watch list,
fees outstanding and arrears, and a promotion run's decisions, all drawn with
a plain map; fine to about a thousand rows, at risk at 5,000. Term and annual
pages left `page` out of their query key, so Next never fetched — fixed. The
students search fires a request per keystroke; on the desk that request
loads and sorts the whole roster and ignores the search term (documented).

Mobile: five SQLite indexes were never created because their names collided
with the core schema's (`idx_scores_exam`, `idx_scores_student`,
`idx_results_exam`, `idx_results_student`, `idx_exams_school`,
`idx_ta_synced`, `idx_students_class`) — the mark sheet, the per-pupil
reads and the class roster scanned their tables. Renamed; the indexes now
exist. The teacher's results screen loads an unlimited history, starts every
group expanded and computes analytics in render; the administrator's
students list writes every page row without a transaction and caps at 4,000;
the admin exam detail caches the whole exam before first draw. Documented.

Desktop: the document store is one JSON table with indexes on collection,
school, updatedAt and pending only; any filter on examId, classId,
studentId or date is a `json_extract` scan of the collection. The
submissions handler scans scores once per subject and is polled every 30 s;
the dashboard and the weekly attendance trend parse whole histories in JS.
Documented.

## 12. Memory

| Path | 1,200 | 2,500 | 5,000 | Note |
|---|---|---|---|---|
| Review cases, miss | +514 MB | +367 MB | +1,114 MB | engine profiles, two runs live |
| Review cases, hit | +73 MB | +109 MB | +217 MB | three cohort copies + the serialised key |
| Preflight | +103 MB | +205 MB | +217 MB | two cohort loads |
| Result processing | +71 MB | +160 MB | +405.5 MB | S·M scores + S summaries |
| Term report card | +22 MB (100) | +143 MB | +274.7 MB | the school's marks for the term |
| Sequence report card, before → after | +34 MB → +9.9 MB | +67 MB → +13.9 MB | — | §8 |
| Memo, resident | up to 6 full reports with profiles → 6 reports without | | | §7 |

The same cohort is held three times during one analysis (documents, the
cohort record, the engine input) plus once as a string for the key; a
request-scoped reuse would halve it (documented).

## 13. Synthetic benchmark

Synthetic school: 40 pupils a class, 12 subjects, 4 published sequences in
two terms, one further sequence marked and unprocessed; fresh in-memory
MongoDB per size, the real routers, five measured calls per path after one
warm-up (the cold review opts out), peak heap sampled every 5 ms,
database commands counted per request. `node --expose-gc
scripts/perf-scalability.js` (`npm run perf:scale`). One machine; the shape
is the finding, not the millisecond.

| Path | 100 | 300 | 600 | 1200 | 2500 | 5000 | queries | heap at 5,000 | rows |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| insights/class/cls-0 (t) | 144 ms | 143 ms | 83 ms | 70 ms | 84 ms | 72 ms | 12 | +19.3 MB | 40 |
| insights/review-cases (head, cold) | 1532 ms | 6863 ms | 7043 ms | 15.1 s | 26.3 s | 47.3 s | 14 | +699.5 MB | 24 |
| insights/review-cases (head, warm) | 92 ms | 480 ms | 450 ms | 871 ms | 2015 ms | 2980 ms | 14 | +217.2 MB | 24 |
| insights/review-cases?classId=cls-0 (t) | 83 ms | 92 ms | 87 ms | 64 ms | 66 ms | 66 ms | 13 | +15.8 MB | 24 |
| insights/calibration-summary (h) | 114 ms | 482 ms | 418 ms | 775 ms | 1705 ms | 3198 ms | 15 | +217.1 MB |  |
| insights/pilot/preflight (h) | 327 ms | 732 ms | 1047 ms | 2401 ms | 3770 ms | 7266 ms | 74 | +217 MB |  |
| insights/student/st-7/intelligence-summary | 103 ms | 91 ms | 88 ms | 163 ms | 76 ms | 104 ms | 56 | +10.4 MB |  |
| insights/student/st-7/strengths | 39 ms | 42 ms | 37 ms | 58 ms | 47 ms | 64 ms | 16 | +3 MB |  |
| insights/student/st-7/guidance | 24 ms | 25 ms | 28 ms | 32 ms | 30 ms | 28 ms | 7 | +1.2 MB |  |
| insights/explorations/summary (h) | 16 ms | 17 ms | 18 ms | 15 ms | 22 ms | 17 ms | 3 | +0.4 MB |  |
| POST exams/ex-next/process (whole school) | 794 ms | 1587 ms | 2014 ms | 5170 ms | 8933 ms | 15.1 s | 16 | +405.5 MB | 5000 |
| results/ex-0?limit=50 (a) | 39 ms | 68 ms | 44 ms | 37 ms | 55 ms | 79 ms | 4 | +5.7 MB | 5000 |
| results/ex-0/rankings?rankBy=school (t) | 53 ms | 87 ms | 53 ms | 41 ms | 50 ms | 61 ms | 4 | +10.9 MB | 100 |
| results/ex-0/stats (t) | 44 ms | 97 ms | 180 ms | 357 ms | 423 ms | 1063 ms | 4 | +70.2 MB | 5000 |
| results/ex-0/student/st-7 (t) | 19 ms | 16 ms | 30 ms | 20 ms | 24 ms | 20 ms | 5 | +0.8 MB |  |
| results/ex-0/student/st-7/reportcard/html (a) | 75 ms | 94 ms | 124 ms | 125 ms | 158 ms | 356 ms | 24 | +21.5 MB |  |
| exams/ex-0/scores?classId=cls-0 (t) | 38 ms | 41 ms | 49 ms | 35 ms | 40 ms | 35 ms | 3 | +6.6 MB | 480 |
| teacher/results (teacher, pair-scoped) | 123 ms | 244 ms | 136 ms | 120 ms | 95 ms | 115 ms | 8 | +26.3 MB | 2000 |
| POST term-results/compute term 1 (whole school) | 272 ms | 1251 ms | 1354 ms | 1937 ms | 3863 ms | 7680 ms | 756 | +28.2 MB | 5000 |
| term-results?term=1&limit=50 (a) | 33 ms | 37 ms | 50 ms | 30 ms | 38 ms | 41 ms | 5 | +2.5 MB | 5000 |
| term-results/st-7/report-card (a) | 113 ms | 214 ms | 326 ms | 614 ms | 1183 ms | 1898 ms | 19 | +274.7 MB |  |
| POST annual-results/compute (whole school) | 250 ms | 787 ms | 2309 ms | 2018 ms | 4353 ms | 7312 ms | 1003 | +30 MB | 5000 |
| sync/pull (admin, full) | 92 ms | 69 ms | 68 ms | 133 ms | 539 ms | 337 ms | 20 | +28.7 MB | 8250 |
| sync/pull (teacher, delta since now) | 25 ms | 23 ms | 17 ms | 21 ms | 34 ms | 20 ms | 8 | +0.8 MB |  |
| sync/changes studentScore,resultSummary limit=500 (teacher, page 1) | 207 ms | 254 ms | 479 ms | 230 ms | 323 ms | 177 ms | 7 | +29.1 MB | 1000 |
| sync/changes (teacher, every collection, page 1) | 313 ms | 260 ms | 248 ms | 224 ms | 206 ms | 217 ms | 28 | +23.3 MB | 1547 |
| admin/students?limit=50 | 22 ms | 24 ms | 22 ms | 33 ms | 42 ms | 85 ms | 4 | +1.3 MB | 50 |
| students?search=Pupil 7&limit=50 | 23 ms | 23 ms | 32 ms | 55 ms | 45 ms | 65 ms | 5 | +1.9 MB | 50 |
| students/teacher/students?classId=cls-0 | 29 ms | 28 ms | 24 ms | 25 ms | 29 ms | 35 ms | 5 | +1.7 MB | 40 |

P95 at 5,000 (five calls): insights/class/cls-0 (t) 100 ms; insights/review-cases (head, warm) 3526 ms; insights/review-cases?classId=cls-0 (t) 125 ms; insights/calibration-summary (h) 4188 ms; insights/pilot/preflight (h) 8227 ms; insights/student/st-7/intelligence-summary 273 ms; insights/student/st-7/strengths 83 ms; insights/student/st-7/guidance 43 ms; insights/explorations/summary (h) 24 ms; results/ex-0?limit=50 (a) 308 ms; results/ex-0/rankings?rankBy=school (t) 67 ms; results/ex-0/stats (t) 1141 ms; results/ex-0/student/st-7 (t) 30 ms; results/ex-0/student/st-7/reportcard/html (a) 401 ms; exams/ex-0/scores?classId=cls-0 (t) 66 ms; teacher/results (teacher, pair-scoped) 167 ms; term-results?term=1&limit=50 (a) 50 ms; term-results/st-7/report-card (a) 2442 ms; sync/pull (teacher, delta since now) 24 ms; admin/students?limit=50 87 ms; students?search=Pupil 7&limit=50 204 ms; students/teacher/students?classId=cls-0 85 ms.

Query plans at 5,000 (after):

| Query | stage | ms | examined | returned |
|---|---|---:|---:|---:|
| ResultSummary published history (school) | IXSCAN | 86 | 20000 | 20000 |
| ResultSummary one pupil | IXSCAN | 0 | 5 | 4 |
| ResultSummary exam list sorted | IXSCAN | 331 | 5000 | 5000 |
| StudentScore exam sheet (class) | IXSCAN | 7 | 480 | 480 |
| StudentScore one pupil one exam | IXSCAN | 1 | 12 | 12 |
| StudentScore feed page (updatedAt keyset) | IXSCAN | 1210 | 300000 | 300000 |
| ResultSummary feed page published | IXSCAN | 89 | 25000 | 20000 |
| StudentScore feed page, idle cursor | IXSCAN | 2 | 0 | 0 |
| ResultSummary feed page, idle cursor | IXSCAN | 1 | 0 | 0 |
| Student feed page, idle cursor | IXSCAN | 1 | 0 | 0 |
| Student mobile pull, since now | IXSCAN | 0 | 0 | 0 |
| Student class roster | IXSCAN | 1 | 40 | 40 |
| Student name search (regex) | IXSCAN | 22 | 5000 | 111 |
| TermResult list sorted | IXSCAN | 19 | 5000 | 5000 |


### Growth, p50 ratio between consecutive sizes (size ratio in brackets)

| Path | 100→300 | 300→600 | 600→1200 | 1200→2500 | 2500→5000 | reading |
|---|---:|---:|---:|---:|---:|---|
| insights/class/cls-0 (t) | 0.99× | 0.58× | 0.84× | 1.20× | 0.86× | flat / bounded |
| insights/review-cases (head, cold) | 4.48× | 1.03× | 2.14× | 1.75× | 1.80× | ≈ linear in the school |
| insights/review-cases (head, warm) | 5.23× | 0.94× | 1.94× | 2.31× | 1.48× | ≈ linear in the school |
| insights/review-cases?classId=cls-0 (t) | 1.11× | 0.94× | 0.74× | 1.02× | 1.00× | flat / bounded |
| insights/calibration-summary (h) | 4.22× | 0.87× | 1.86× | 2.20× | 1.88× | ≈ linear in the school |
| insights/pilot/preflight (h) | 2.24× | 1.43× | 2.29× | 1.57× | 1.93× | ≈ linear in the school |
| insights/student/st-7/intelligence-summary | 0.88× | 0.97× | 1.86× | 0.47× | 1.36× | flat / bounded |
| insights/student/st-7/strengths | 1.09× | 0.88× | 1.56× | 0.81× | 1.37× | flat / bounded |
| insights/student/st-7/guidance | 1.05× | 1.12× | 1.15× | 0.93× | 0.93× | flat / bounded |
| insights/explorations/summary (h) | 1.08× | 1.06× | 0.81× | 1.52× | 0.76× | ≈ linear |
| POST exams/ex-next/process (whole school) | 2.00× | 1.27× | 2.57× | 1.73× | 1.69× | ≈ linear in the school |
| results/ex-0?limit=50 (a) | 1.75× | 0.65× | 0.83× | 1.50× | 1.42× | flat / bounded |
| results/ex-0/rankings?rankBy=school (t) | 1.66× | 0.60× | 0.77× | 1.22× | 1.23× | flat / bounded |
| results/ex-0/stats (t) | 2.18× | 1.86× | 1.99× | 1.18× | 2.51× | ≈ linear |
| results/ex-0/student/st-7 (t) | 0.85× | 1.81× | 0.69× | 1.18× | 0.82× | flat / bounded |
| results/ex-0/student/st-7/reportcard/html (a) | 1.26× | 1.31× | 1.01× | 1.26× | 2.26× | ≈ linear |
| exams/ex-0/scores?classId=cls-0 (t) | 1.07× | 1.19× | 0.72× | 1.15× | 0.87× | flat / bounded |
| teacher/results (teacher, pair-scoped) | 1.98× | 0.56× | 0.88× | 0.80× | 1.21× | flat / bounded |
| POST term-results/compute term 1 (whole school) | 4.60× | 1.08× | 1.43× | 1.99× | 1.99× | ≈ linear in the school |
| term-results?term=1&limit=50 (a) | 1.12× | 1.36× | 0.60× | 1.28× | 1.08× | flat / bounded |
| term-results/st-7/report-card (a) | 1.89× | 1.52× | 1.88× | 1.93× | 1.60× | ≈ linear in the school |
| POST annual-results/compute (whole school) | 3.14× | 2.93× | 0.87× | 2.16× | 1.68× | ≈ linear in the school |
| sync/pull (admin, full) | 0.74× | 0.99× | 1.95× | 4.06× | 0.63× | superlinear late |
| sync/pull (teacher, delta since now) | 0.92× | 0.71× | 1.28× | 1.62× | 0.57× | ≈ linear |
| sync/changes studentScore,resultSummary limit=500 (teacher, page 1) | 1.23× | 1.88× | 0.48× | 1.40× | 0.55× | flat / bounded |
| sync/changes (teacher, every collection, page 1) | 0.83× | 0.96× | 0.90× | 0.92× | 1.05× | flat / bounded |
| admin/students?limit=50 | 1.07× | 0.94× | 1.49× | 1.26× | 2.03× | ≈ linear |
| students?search=Pupil 7&limit=50 | 1.01× | 1.38× | 1.71× | 0.81× | 1.46× | flat / bounded |
| students/teacher/students?classId=cls-0 | 0.95× | 0.87× | 1.05× | 1.14× | 1.21× | flat / bounded |


## 14. Before and after

| Path | size | before p50 | after p50 | before queries | after queries | before heap | after heap |
|---|---:|---:|---:|---:|---:|---:|---:|
| POST annual-results/compute (whole school) | 1200 | 10.3 s | 2018 ms | 4922 | 242 | +28.4 MB | +29.2 MB |
| POST annual-results/compute (whole school) | 2500 | 28.5 s | 4353 ms | 10254 | 506 | +31.1 MB | +29.4 MB |
| POST annual-results/compute (whole school) | 5000 | 42.6 s | 7312 ms | 20503 | 1003 | +36.7 MB | +30 MB |
| exams/ex-0/scores?classId=cls-0 (t) | 1200 | 59 ms | 35 ms | 3 | 3 | +6.6 MB | +6.6 MB |
| exams/ex-0/scores?classId=cls-0 (t) | 2500 | 78 ms | 40 ms | 4 | 3 | +6.6 MB | +6.6 MB |
| exams/ex-0/scores?classId=cls-0 (t) | 5000 | 97 ms | 35 ms | 3 | 3 | +6.6 MB | +6.6 MB |
| results/ex-0/student/st-7/reportcard/html (a) | 1200 | 532 ms | 125 ms | 24 | 23 | +34.3 MB | +9.9 MB |
| results/ex-0/student/st-7/reportcard/html (a) | 2500 | 1084 ms | 158 ms | 23 | 23 | +66.9 MB | +13.9 MB |
| results/ex-0/student/st-7/reportcard/html (a) | 5000 | 1249 ms | 356 ms | 24 | 24 | +122.3 MB | +21.5 MB |
| results/ex-0/rankings?rankBy=school (t) | 1200 | 397 ms | 41 ms | 5 | 5 | +15.3 MB | +10.8 MB |
| results/ex-0/rankings?rankBy=school (t) | 2500 | 967 ms | 50 ms | 5 | 4 | +42.7 MB | +10.8 MB |
| results/ex-0/rankings?rankBy=school (t) | 5000 | 1013 ms | 61 ms | 5 | 4 | +65.1 MB | +10.9 MB |
| term-results?term=1&limit=50 (a) | 1200 | 278 ms | 30 ms | 6 | 5 | +6.4 MB | +2.5 MB |
| term-results?term=1&limit=50 (a) | 2500 | 349 ms | 38 ms | 6 | 5 | +10.6 MB | +2.6 MB |
| term-results?term=1&limit=50 (a) | 5000 | 2277 ms | 41 ms | 6 | 5 | +19 MB | +2.5 MB |
| sync/changes studentScore,resultSummary limit=500 (teacher, page 1) | 1200 | 1064 ms | 230 ms | 7 | 6 | +29.1 MB | +29 MB |
| sync/changes studentScore,resultSummary limit=500 (teacher, page 1) | 2500 | 1983 ms | 323 ms | 7 | 6 | +29.2 MB | +29 MB |
| sync/changes studentScore,resultSummary limit=500 (teacher, page 1) | 5000 | 6011 ms | 177 ms | 7 | 7 | +29.4 MB | +29.1 MB |
| sync/changes (teacher, every collection, page 1) | 1200 | 1932 ms | 224 ms | 33 | 29 | +23.1 MB | +23.1 MB |
| sync/changes (teacher, every collection, page 1) | 2500 | 2023 ms | 206 ms | 33 | 28 | +23.2 MB | +23.1 MB |
| sync/changes (teacher, every collection, page 1) | 5000 | 2505 ms | 217 ms | 33 | 28 | +23.4 MB | +23.3 MB |
| sync/pull (teacher, delta since now) | 1200 | 56 ms | 21 ms | 9 | 8 | +0.9 MB | +0.8 MB |
| sync/pull (teacher, delta since now) | 2500 | 107 ms | 34 ms | 8 | 8 | +0.8 MB | +0.8 MB |
| sync/pull (teacher, delta since now) | 5000 | 213 ms | 20 ms | 8 | 8 | +0.8 MB | +0.8 MB |
| sync/pull (admin, full) | 1200 | 197 ms | 133 ms | 15 | 15 | +28.8 MB | +28.7 MB |
| sync/pull (admin, full) | 2500 | 440 ms | 539 ms | 16 | 15 | +30 MB | +31 MB |
| sync/pull (admin, full) | 5000 | 1061 ms | 337 ms | 20 | 20 | +27.5 MB | +28.7 MB |
| POST term-results/compute term 1 (whole school) | 1200 | 3257 ms | 1937 ms | 185 | 185 | +27.2 MB | +27.3 MB |
| POST term-results/compute term 1 (whole school) | 2500 | 7464 ms | 3863 ms | 383 | 383 | +27.3 MB | +27.3 MB |
| POST term-results/compute term 1 (whole school) | 5000 | 18.2 s | 7680 ms | 756 | 756 | +28.1 MB | +28.2 MB |
| insights/review-cases (head, warm) | 1200 | 991 ms | 871 ms | 11 | 11 | +72.5 MB | +72.5 MB |
| insights/review-cases (head, warm) | 2500 | 1816 ms | 2015 ms | 13 | 13 | +109.2 MB | +109.2 MB |
| insights/review-cases (head, warm) | 5000 | 3690 ms | 2980 ms | 14 | 14 | +217.1 MB | +217.2 MB |

Idle feed page (cursor at now), documents examined → returned, before → after:

| Collection | 2,500 before | 2,500 after | 5,000 after |
|---|---:|---:|---:|
| StudentScore | 150000 examined (full page; no idle measurement before) | 0 → 0 | 0 → 0 |
| ResultSummary | 10000 examined (full page; no idle measurement before) | 0 → 0 | 0 → 0 |
| Student | every row | 0 → 0 | 0 → 0 |

The sequence-card cohort read, annual compute, submissions counts and staleness aggregation were measured directly by `check-complexity.js` as query shapes; the table above shows their effect on wall time and heap.


## 15. Remaining risks and decisions

- **P1** A cold school-wide review at 5,000 pupils: 60 s on the event loop,
  +1.1 GB heap. Mitigations that keep the semantics: serve the analysis from
  a worker or a job so it does not block; de-duplicate in-flight misses;
  start the process with a heap of 2 GB or more for schools above ~2,500.
  Infrastructure decision.
- **P2** The memo's key costs a full cohort load, copy, serialisation and
  hash per hit (3.7 s, 217 MB at 5,000). A two-level key — a cheap
  fingerprint over `(updatedAt, _id)` of the scope's summaries and exams
  with a projection, the full load only when the fingerprint changes — would
  make a hit a few milliseconds. Design change; not made here.
- **P1 (decision)** Term and annual report cards read the whole school's
  marks for the period; a class print multiplies that by the class. Per-class
  subject positions would make the read O(S_c); school-wide positions need a
  per-print cache or a server-side class print. Product decision first.
- **P1 (decision)** Indexes in production: `autoIndex` is off and nothing
  syncs them; whether the declared indexes (this audit's included) exist on
  the deployed database must be verified and a deployment step chosen.
- **P2** The phone's attendance pull: the whole school's last 30 days,
  unpaged, every sync. A class-scoped, paged pull is a mobile and server
  contract change.
- **P2** `/sync/pull` carries no deletions; hard deletes on mirrored
  collections reach neither client without a cursor reset.
- **P2** Preflight loads the scope's cohort twice and the school's exams
  five times; the pilot's own operation, run by the head.
- **P2** Desktop document store: JSON-field filters scan; the submissions
  handler polled every 30 s is the one that hurts first.
- **P2** Web whole-school lists without pagination (review queue, watch
  list, fees outstanding, promotion decisions) at several thousand rows.
- **P3** `/api/results/:examId` whole-exam list sorts in memory
  (`{examId, classPosition}` would serve it); unbounded `limit` on list
  routes; the per-intervention rebuilds in the pupil summary; the
  notification senders' per-family reads; `Math.max(...arr)` on large arrays.

## 16. Tested boundary

Synthetic schools up to **5,000 pupils, 125 classes, 12 subjects, 4
published sequences** (300,000 marks, 20,000 result summaries) on one
developer machine, in-memory MongoDB. Larger sizes were not run.

- Every per-pupil and per-class path stays flat from 100 to 5,000 pupils:
  class intelligence 70–120 ms, pupil summary ≤ 140 ms, strengths and
  guidance ≤ 80 ms, mark sheet ≤ 100 ms, one pupil's result ≤ 50 ms, a
  sequence report card 356 ms p50 at 5,000 (was 1.2 s), rankings 61 ms (was
  1.0 s), the term list 41 ms (was 2.3 s), a feed page 180–220 ms (was
  2.5–6 s), a delta pull 20 ms (was 213 ms).
- Linear in the school, as expected and acceptable as office batches:
  result processing 15 s at 5,000 (+405 MB), term compute 7.7 s (was 18 s),
  annual compute 7.3 s (was 42.6 s), statistics 1.1 s.
- **At 2,500 pupils** the whole-school review costs 26 s cold on the event
  loop and +340 MB, 2 s and +109 MB warm; preflight 6 s. Workable for a
  head's occasional use on a 1 GB heap; two concurrent cold misses are not.
- **At 5,000 pupils** the cold school-wide review is the first observed
  bottleneck: 47 s blocking and +700 MB; the term and annual report card
  (one pupil) reads the school's marks for the period, 1.9 s and +275 MB;
  statistics and the whole-exam list sort grow with the exam. Beyond this
  size the cold review needs a heap above the default and must not run on
  the request thread.
- Not verified: real hardware and a remote database (latency multiplies the
  sequential per-class batches), concurrent users beyond the four of
  docs/32, attendance volumes (not seeded here), multi-year histories
  (A grows the per-pupil paths linearly), and whether production carries
  the declared indexes at all.

## 17. Classification

Commit: COMMIT_HASH


| Level | Items |
|---|---|
| P0 | none observed |
| P1 | cold school-wide review memory and event-loop time at ≥ 2,500 pupils (infrastructure); term/annual card school-wide read (decision); production index provisioning (decision); the feed without its index (**fixed**) |
| P2 | memo key cost on a hit; phone attendance pull; pull deletions; preflight double load; desktop store scans; web unpaginated school lists; annual compute N+1 (**fixed**); submission counts N+1 (**fixed**); mobile index collisions (**fixed**); taught-scope 6× (**fixed**) |
| P3 | quadratic positions (**fixed**); staleness aggregation per page (**fixed**); report-card cohort read (**fixed**); rankings slice after read (**fixed**); attendance class report quadratic (**fixed**); teacher scope unscoped subject read (**fixed**); web result pages' query key (**fixed**); in-memory sort of the whole-exam list; unbounded limits |
| Informational | everything linear and bounded in §4; the sensitivity sweep's 44 runs are the semantics of calibration |

## 18. Files changed

Backend: `src/services/termGrading.service.js` (competitionPlaces, positions),
`src/services/annualGrading.service.js` (class-level context, one read, one
write, positions), `src/services/results.service.js` (rankings limit),
`src/services/resultStaleness.service.js` (page-scoped aggregation),
`src/controllers/results.controller.js` (ranking limit; report-card cohort
keys), `src/routes/exam.routes.js` (grouped submission counts),
`src/routes/attendance.routes.js` (class report grouping),
`src/routes/teacher.routes.js` (subject scope tenancy),
`src/config/syncFeed.js` (taught scope memo),
`src/services/intelligence/reviewCases.service.js` (memo without profiles),
`src/services/fees.service.js` (ledger order made deterministic: time, then id),
twenty-five models under `src/db/models/` (the feed index),
`scripts/check-complexity.js` (new, in `check:all`),
`scripts/perf-scalability.js` (new, `npm run perf:scale`), `package.json`.
Mobile: `src/services/examCache.service.js`, `src/services/attendance.service.js`,
`src/services/student.service.js` (index names). Web:
`src/hooks/useExamResults.ts` (page in the query key). Docs: this file.

## 19. Commands run

| Command | Result |
|---|---|
| `npm run perf:scale` (backend; `SCALE_SIZES=100,300,600,1200,2500,5000`), before and after | §13, §14 |
| `npm run check:complexity` (backend, new) | 17 of 17 |
| `npm run check:all` (backend, 65 parts; `check:brevo` skipped as always) | 63 of 64 run passed in the chain; `check:studentfees` failed on an ordering tie the new FeeCharge index exposed (two charges created in the same millisecond returned in index order rather than insertion order). The ledger's sort was by creation time alone, which never defined a tie; it now sorts by time and id, the fixture creates its charges a day apart, and the suite passes 13 of 13 alone with the portal suites (portalvis 33, portalmsg 15, portalgate 10) and the mobile portal client (61) green |
| `npm run check` (mobile, 23 suites) | 23 of 23 |
| `npm run check` (desktop, 12 suites) | 12 of 12 |
| web: lint, build, i18n:check, api:check, check:normalisers, check:roles, check:intelui, check:pilotui, check:grouping, check:l10n, check:layout | 11 of 11 |

## 20. Conclusion

**A. Fixed before this audit** (verified): the school-wide analysis memo
and single engine-input build; the teacher class queue; the per-pupil
intelligence latencies; indexed plans for the sixteen hot queries.

**B. Found and fixed here**, every output unchanged and each covered by
`check-complexity.js`: the change feed's missing index (every page and
every idle poll walked the school; now an index seek); annual compute's
per-pupil N+1 (20,503 → 1,003 queries, 42.6 s → 7.3 s at 5,000); the two
quadratic position loops; the per-subject count N+1 on both submission
views; rankings reading the whole table to slice a page (1.0 s → 61 ms);
the staleness aggregation over the whole school per page (2.3 s → 41 ms);
the sequence report card reading the whole exam to rank one pupil (1.2 s →
356 ms, 122 → 22 MB); the taught-scope read six times per feed page; the
teacher scope's cross-tenant subject scan; the class attendance report's
quadratic loop; the memo holding every pupil's profile; the phone's five
never-created indexes; the web result pages' broken pagination key.

**C. Acceptable as it stands**: everything per pupil or per class, which is
flat to 5,000; the office batches (processing, term and annual compute,
statistics), which are linear; finance, which is already aggregated; the
mobile outbox and the desktop merge, which are sequential by design.

**D. Remaining risks**: the cold school-wide review's event-loop time and
heap at and above 2,500 pupils; the per-hit cost of the memo's key; the
term and annual card's school-wide read; the phone's school-wide attendance
pull and deletion blindness; the desktop store's JSON scans; web
whole-school lists without pagination.

**E. Decisions outside this review**: whether production builds the
declared indexes and how; whether a term card's subject position is the
class's or the school's; whether the school-wide analysis moves off the
request thread; whether the phone's attendance pull becomes class-scoped
and paged.

The system is not "fully scalable". It is linear or flat on every path
measured up to 5,000 pupils, with one CPU- and memory-bound operation whose
cost is the semantics of calibration and whose placement is an
infrastructure decision.
