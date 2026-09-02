// backend/scripts/check-coefficients.js
"use strict";

/**
 * A coefficient set on a subject has to reach the exams, and stop where it must.
 *
 * ── The bug ───────────────────────────────────────────────────────────────
 *
 * PUT /admin/subjects/:id wrote Subject.coefficient and nothing else. The
 * grading service and the mark-entry screen both read ExamSubject.weight, which
 * is seeded when the subject is attached and was never updated again — so a
 * head could set Mathematics to coefficient 4, open the marks sheet, and find
 * it still counting as 1, with nothing anywhere to say the edit had gone
 * nowhere.
 *
 * ── What is worth pinning ─────────────────────────────────────────────────
 *
 * Not that the cascade happens: that is one line and obvious when it breaks.
 * The three cases where it must NOT happen, each of which is somebody's work:
 *
 *   an exam weighted deliberately for one paper, which keeps its own value
 *   an exam whose results are published, locked or archived
 *   another school's rows, which this edit may never touch
 *
 * And that a reprocess is reported when the exam already has marks, since
 * nothing is recomputed and a stale average nobody is told about is worse than
 * one they can see.
 *
 *   node scripts/check-coefficients.js
 */

const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  const Exam        = require("../src/db/models/Exam");
  const ExamSubject = require("../src/db/models/ExamSubject");
  const Score       = require("../src/db/models/StudentScore");
  const {
    cascadeCoefficient, coefficientOf, weightFor, isFinalised,
  } = require("../src/services/subjectCoefficient.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}: got ${a}, expected ${e}`); }
  };

  const SCHOOL = "sch-1", OTHER = "sch-2";
  const SUBJECT = "subj-maths";

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- reading a coefficient ---");

  check("a plain coefficient is itself", coefficientOf({ coefficient: 4 }), 4);
  // Rows written before the field existed hold nothing, and the whole app
  // reads that as 1. The cascade has to agree, or a first edit would compare
  // against a different "old" value than the screens were showing.
  check("a missing one reads as 1", coefficientOf({}), 1);
  check("so does a zero", coefficientOf({ coefficient: 0 }), 1);
  check("and a nonsense one", coefficientOf({ coefficient: "abc" }), 1);
  check("100 to the coefficient's 1", weightFor(1), 100);
  check("and 400 to its 4", weightFor(4), 400);

  console.log("--- which exams count as finished ---");
  check("a published exam", isFinalised({ status: "published" }), true);
  check("an archived one", isFinalised({ status: "archived" }), true);
  // status alone is not enough: an exam can carry resultsPublished with a
  // status the school never advanced.
  check("one whose results are out, whatever its status",
    isFinalised({ status: "ongoing", resultsPublished: true }), true);
  check("one whose results are locked",
    isFinalised({ status: "completed", resultsLockedAt: new Date() }), true);
  check("an ordinary one is not", isFinalised({ status: "ongoing" }), false);
  check("nor a draft", isFinalised({ status: "draft" }), false);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- the cascade ---");

  const mkExam = async (id, over = {}) => Exam.create({
    _id: id, schoolId: SCHOOL, name: id, type: "test",
    academicYear: "2026/2027", term: 1, status: "ongoing",
    totalMarks: 20, passMark: 10, ...over,
  });

  const mkEs = async (id, examId, weight, over = {}) => ExamSubject.create({
    _id: id, examId, subjectId: SUBJECT, classId: "cls-1",
    schoolId: SCHOOL, maxScore: 20, passMark: 10, weight, ...over,
  });

  await mkExam("ex-following");
  await mkExam("ex-own");
  await mkExam("ex-published", { status: "published", resultsPublished: true });
  await mkExam("ex-draft", { status: "draft" });

  await mkEs("es-following",  "ex-following", 100);   // still on the old default
  await mkEs("es-own",        "ex-own",       250);   // weighted for this paper
  await mkEs("es-published",  "ex-published", 100);   // results already out
  await mkEs("es-draft",      "ex-draft",     100);
  // Another school's row, which this edit may never reach. Its own exam and
  // class, because (examId, subjectId, classId) is unique.
  await mkExam("ex-other-school", { schoolId: OTHER });
  await mkEs("es-other", "ex-other-school", 100,
    { schoolId: OTHER, classId: "cls-9" });

  const one = await cascadeCoefficient({
    schoolId: SCHOOL, subjectId: SUBJECT, from: 1, to: 4,
  });

  check("the rows that were following it are updated", one.updated, 2);
  check("across both their exams", one.examIds.sort(),
    ["ex-draft", "ex-following"]);
  check("the exam with its own coefficient is left alone", one.skippedOverridden, 1);
  check("and the one whose results are out", one.skippedFinalised, 1);
  check("with no marks anywhere, no reprocess is asked for",
    one.reprocessRequired, false);

  const weightOf = async (id) =>
    (await ExamSubject.findById(id).lean())?.weight;

  check("the following row now carries the new coefficient",
    await weightOf("es-following"), 400);
  check("and the draft's", await weightOf("es-draft"), 400);
  check("the deliberately weighted one is untouched",
    await weightOf("es-own"), 250);
  check("the published one is untouched",
    await weightOf("es-published"), 100);
  check("and the other school's row is untouched",
    await weightOf("es-other"), 100);

  // ── Idempotence, which is what makes a second save harmless ─────────────
  const again = await cascadeCoefficient({
    schoolId: SCHOOL, subjectId: SUBJECT, from: 1, to: 4,
  });
  check("running it again moves nothing", again.updated, 0);
  check("and does not count an already-correct row as overridden",
    again.skippedOverridden, 1);

  // ── An edit that changes nothing ────────────────────────────────────────
  const same = await cascadeCoefficient({
    schoolId: SCHOOL, subjectId: SUBJECT, from: 4, to: 4,
  });
  check("the same coefficient twice does nothing at all", same.updated, 0);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- when a reprocess has to be asked for ---");

  await Score.create({
    examId: "ex-following", examSubjectId: "es-following", subjectId: SUBJECT,
    studentId: "stu-1", classId: "cls-1", schoolId: SCHOOL,
    score: 14, maxScore: 20,
  });

  const marked = await cascadeCoefficient({
    schoolId: SCHOOL, subjectId: SUBJECT, from: 4, to: 2,
  });
  check("a marked exam is still updated", marked.updated, 2);
  // Nothing is recomputed — the same decision PUT /exams/:examId/subjects/:id
  // takes, and for the same reason: it would rewrite results an admin may be
  // about to publish.
  check("and a reprocess is reported", marked.reprocessRequired, true);
  check("the average itself is not rewritten",
    (await Score.findOne({ examId: "ex-following" }).lean())?.score, 14);

  // A subject nothing is attached to.
  check("a subject on no exam cascades to nothing",
    (await cascadeCoefficient({
      schoolId: SCHOOL, subjectId: "subj-nowhere", from: 1, to: 3,
    })).updated, 0);
  check("and one with no id at all is refused quietly",
    (await cascadeCoefficient({ schoolId: SCHOOL, subjectId: null, from: 1, to: 3 })).updated,
    0);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- the backfill's force, which the route never uses ---");

  /*
   * The rows that drifted while the cascade did not exist do not match ANY old
   * default — they were seeded before an edit the exams never saw. Only the
   * repair script may align those, and only with a person reading the list,
   * which is why it is a separate flag rather than the cascade being loose.
   */
  await mkExam("ex-drifted");
  await mkEs("es-drifted", "ex-drifted", 100);
  const notForced = await cascadeCoefficient({
    schoolId: SCHOOL, subjectId: SUBJECT, from: 7, to: 3,
  });
  check("an ordinary edit will not touch a drifted row",
    (await weightOf("es-drifted")), 100);
  check("it is reported as somebody's own choice instead",
    notForced.skippedOverridden >= 1, true);

  const forced = await cascadeCoefficient({
    schoolId: SCHOOL, subjectId: SUBJECT, to: 3, force: true,
  });
  check("the backfill aligns it", await weightOf("es-drifted"), 300);
  check("and still refuses the published exam", await weightOf("es-published"), 100);
  check("and still refuses another school's", await weightOf("es-other"), 100);
  check("the deliberately weighted row is aligned only under force",
    await weightOf("es-own"), 300);
  check("forcing reports what it moved", forced.updated >= 1, true);

  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongo.stop();
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
