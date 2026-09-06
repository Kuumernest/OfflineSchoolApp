// backend/scripts/check-student-results.js
"use strict";

/**
 * GET /api/results/my-results
 *
 * A pupil could not see their own results at all. Every route on the results
 * router is gated on results.view, and a student holds neither that nor
 * exams.view — so the two calls the student screen makes both answered 403,
 * while the same published figures reached parents through the portal, which
 * is a different router with a guardian token of its own.
 *
 * The fix could not be "give students results.view": that permission opens
 * GET /results/:examId, which answers with the entire cohort, and /rankings,
 * which puts them in order. Reading your own mark and reading everyone's are
 * different rights.
 *
 * So this endpoint answers a narrower question, and the assertions below are
 * the reasons it is allowed to exist without a permission check:
 *
 *   • it can only ever name the caller
 *   • an identity it cannot establish gets nothing, not everything
 *   • an unpublished result is not a result
 *   • it returns the pupil's OWN rank, because the parent portal and the
 *     printed report card both carry it — withholding it here would show a
 *     pupil less of their own result than their family already has
 *
 *   node scripts/check-student-results.js
 */

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require("../src/db/models");
  const User          = mongoose.model("User");
  const Student       = mongoose.model("Student");
  const Exam          = mongoose.model("Exam");
  const ResultSummary = mongoose.model("ResultSummary");

  const SCHOOL = "sch-1";

  const mkUser = (id, role, name) => User.create({
    _id: id, name, email: `${id}@example.test`,
    password: "check-only-password", role, schoolId: SCHOOL, isActive: true,
  });

  await mkUser("usr-ama", "student", "Ama");
  await mkUser("usr-kofi", "student", "Kofi");

  await Student.create({
    _id: "stu-ama", userId: "usr-ama", schoolId: SCHOOL, classId: "cls-1",
    studentName: "Ama", enrollmentNo: "ENR-1", isActive: true,
  });
  await Student.create({
    _id: "stu-kofi", userId: "usr-kofi", schoolId: SCHOOL, classId: "cls-1",
    studentName: "Kofi", enrollmentNo: "ENR-2", isActive: true,
  });

  await Exam.create({
    _id: "ex-1", schoolId: SCHOOL, name: "First Sequence", type: "test",
    academicYear: "2026/2027", term: 1, sequenceNumber: 1,
    status: "completed", classId: "cls-1", totalMarks: 20, passMark: 10,
  });

  const summary = (id, studentId, published, extra = {}) => ResultSummary.create({
    _id: id, examId: "ex-1", schoolId: SCHOOL, studentId, classId: "cls-1",
    totalScore: 68, maxTotalScore: 100, percentage: 68, average: 13.6,
    overallGrade: "B", isPublished: published,
    publishedAt: published ? new Date() : null,
    classPosition: 3, totalInClass: 40,
    ...extra,
  });

  const app = express();
  app.use(express.json());
  app.use("/api/results", require("../src/routes/results.routes"));
  const server = app.listen(0);
  const port   = server.address().port;

  const asUser = (id, role) =>
    jwt.sign({ id, role, schoolId: SCHOOL }, process.env.JWT_SECRET, { expiresIn: "1h" });

  const get = async (token, qs = `schoolId=${SCHOOL}`) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/results/my-results?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // ── The thing that was broken ─────────────────────────────────────────────
  console.log("\n--- a pupil reading their own published result ---");

  await summary("sum-ama", "stu-ama", true);
  let r = await get(asUser("usr-ama", "student"));

  if (r.status === 200) ok("a student is not 403'd");
  else bad("a student is not 403'd", `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);

  if (r.body?.data?.length === 1) ok("their result comes back");
  else bad("their result comes back", JSON.stringify(r.body).slice(0, 160));

  const row = r.body?.data?.[0] ?? {};
  if (row.examName === "First Sequence") ok("with the exam's name, not just its id");
  else bad("with the exam's name", JSON.stringify(row.examName));

  if (row.overallGrade === "B" && row.percentage === 68) ok("and the figures the school published");
  else bad("and the figures the school published", JSON.stringify(row));

  // ── The leaks ─────────────────────────────────────────────────────────────
  console.log("\n--- what it must never answer with ---");

  await summary("sum-kofi", "stu-kofi", true);
  r = await get(asUser("usr-ama", "student"));

  const ids = (r.body?.data ?? []).map((d) => String(d.studentId));
  if (ids.length === 1 && ids[0] === "stu-ama") ok("another pupil's published result is not included");
  else bad("another pupil's published result is not included", JSON.stringify(ids));

  // Rank IS returned, matching the parent portal and the printed report card.
  // What must not appear is anybody else's row, which the id assertion above
  // covers — a position is the pupil's own standing, not a list of the others.
  const mine = r.body?.data?.[0] ?? {};
  if (mine.classPosition === 3 && mine.totalInClass === 40) ok("their own rank is included, as on the report card");
  else bad("their own rank is included", JSON.stringify(mine).slice(0, 140));

  // An account with no student record at all must see nothing, not everything.
  await mkUser("usr-ghost", "student", "Ghost");
  r = await get(asUser("usr-ghost", "student"));
  if (r.status === 200 && (r.body?.data?.length ?? 0) === 0) ok("an unmatched identity sees nothing, not everything");
  else bad("an unmatched identity sees nothing", `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);

  // ── Naming another school gets you nothing of that school's ──────────────
  //
  // This used to assert that a foreign schoolId returned an empty list, which
  // it did, because the parameter was filtered on. The parameter is no longer
  // trusted at all — resolveSchoolId gives the caller their own school — so the
  // answer is now their own results rather than nothing.
  //
  // That is the stronger behaviour, and the weaker assertion would have hidden
  // it: "returns nothing" is also what a broken endpoint returns. What has to
  // be true is that no row of the other school comes back, so there is now a
  // row over there to come back, and the assertion looks for it by name.
  await User.create({
    _id: "usr-far", name: "Far", email: "far@example.test",
    password: "check-only-password", role: "student", schoolId: "sch-other", isActive: true,
  });
  await Student.create({
    _id: "stu-far", userId: "usr-far", schoolId: "sch-other", classId: "cls-far",
    studentName: "Far", enrollmentNo: "ENR-FAR", isActive: true,
  });
  await Exam.create({
    _id: "ex-far", schoolId: "sch-other", name: "Far Sequence", type: "test",
    academicYear: "2026/2027", term: 1, sequenceNumber: 1,
    status: "completed", classId: "cls-far", totalMarks: 20, passMark: 10,
  });
  await ResultSummary.create({
    _id: "sum-far", examId: "ex-far", schoolId: "sch-other", studentId: "stu-far",
    classId: "cls-far", totalScore: 99, maxTotalScore: 100, percentage: 99,
    average: 19.8, overallGrade: "A", isPublished: true, publishedAt: new Date(),
    classPosition: 1, totalInClass: 1,
  });

  r = await get(asUser("usr-ama", "student"), "schoolId=sch-other");
  const leaked = JSON.stringify(r.body ?? {}).includes("sum-far");
  if (!leaked) ok("naming another school returns nothing belonging to it");
  else bad("naming another school returns nothing belonging to it",
    JSON.stringify(r.body).slice(0, 200));

  const mineOnly = (r.body?.data ?? []).every((d) => String(d.studentId) === "stu-ama");
  if (mineOnly) ok("and still only ever the caller's own rows");
  else bad("only the caller's own rows",
    JSON.stringify((r.body?.data ?? []).map((d) => d.studentId)));

  // ── Publishing is the gate ────────────────────────────────────────────────
  console.log("\n--- computed is not published ---");

  await ResultSummary.updateOne({ _id: "sum-ama" }, { isPublished: false, publishedAt: null });
  r = await get(asUser("usr-ama", "student"));
  if ((r.body?.data?.length ?? 0) === 0) ok("an unpublished result is not shown");
  else bad("an unpublished result is not shown", JSON.stringify(r.body?.data));

  await ResultSummary.updateOne({ _id: "sum-ama" }, { isPublished: true, publishedAt: new Date() });
  r = await get(asUser("usr-ama", "student"));
  if ((r.body?.data?.length ?? 0) === 1) ok("and appears again once published");
  else bad("and appears again once published", JSON.stringify(r.body?.data));

  // A soft-deleted summary stays gone.
  await ResultSummary.updateOne({ _id: "sum-ama" }, { deletedAt: new Date() });
  r = await get(asUser("usr-ama", "student"));
  if ((r.body?.data?.length ?? 0) === 0) ok("a deleted summary stays hidden");
  else bad("a deleted summary stays hidden", JSON.stringify(r.body?.data));

  // ── Staff are not broken by it ────────────────────────────────────────────
  console.log("\n--- staff ---");

  await ResultSummary.updateOne({ _id: "sum-ama" }, { deletedAt: null });
  await mkUser("usr-teacher", "teacher", "A Teacher");
  r = await get(asUser("usr-teacher", "teacher"));
  if (r.status === 200) ok("a teacher may call it too, and gets their own (none)");
  else bad("a teacher may call it", `${r.status}`);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
