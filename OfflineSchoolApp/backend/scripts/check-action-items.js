// backend/scripts/check-action-items.js
"use strict";

/**
 * C11 — action items in the notification panel (GET /admin/action-items).
 *
 *   marks     e1: maths + english submitted, physics approved  → 2 awaiting, one exam → its marks tab
 *             e9 (deleted exam subject) submitted               → not counted
 *   results   e1: summaries processed, not published            → 1 unpublished → its results tab
 *             e2: published                                     → not counted
 *   fees      ama owes 50,000 due 10 days ago                   → 1 overdue, 50,000
 *             bih owes 70,000 due in 20 days                    → not yet overdue
 *
 *   An administrator sees all three; a teacher (who can do none of them) is
 *   refused (403), which the bell shows as no items.
 *   Once the marks are approved the item is gone — nothing to mark read.
 *
 *   node scripts/check-action-items.js
 */

const path     = require("path");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const { stopQuietly } = require("./stopQuietly");

const SRC = path.join(__dirname, "..", "src");

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const S = new mongoose.Types.ObjectId().toString();
  const YEAR = "2026/2027";
  const day = (n) => new Date(Date.now() + n * 86_400_000);
  await M("School").create({ _id: S, name: "Green Valley", email: "gv-ai@example.test", settings: { academicYear: YEAR } });
  for (const [id, role] of [["adm-1", "school_admin"], ["tch-1", "teacher"]]) {
    await M("User").create({ _id: id, name: id, email: `${id}@example.test`,
      password: "check-only-password", role, schoolId: S, isActive: true });
  }

  const exam = (id, extra = {}) => M("Exam").create({ _id: id, schoolId: S, name: id, type: "test",
    academicYear: YEAR, term: 1, sequenceNumber: 1, status: "completed", classId: "f1", classIds: ["f1"], ...extra });
  await exam("e1"); await exam("e2", { resultsPublished: true, status: "published" }); await exam("e9");
  const es = (_id, examId, subjectId, submissionStatus, extra = {}) => M("ExamSubject").create({
    _id, examId, subjectId, classId: "f1", schoolId: S, submissionStatus, ...extra });
  await es("es1", "e1", "maths", "submitted");
  await es("es2", "e1", "english", "submitted");
  await es("es3", "e1", "physics", "approved");
  await es("es9", "e9", "maths", "submitted", { deletedAt: new Date() });
  const summary = (examId, studentId, isPublished) => M("ResultSummary").create({
    examId, studentId, classId: "f1", schoolId: S, average: 12, isPublished, calcVersion: "exam-process/3" });
  await summary("e1", "ama", false); await summary("e2", "ama", true);

  for (const id of ["ama", "bih"]) {
    await M("Student").create({ _id: id, userId: `u-${id}`, schoolId: S, classId: "f1",
      studentName: id, enrollmentNo: `EN-${id}`, status: "approved", isActive: true });
  }
  await M("FeeCharge").create({ schoolId: S, studentId: "ama", academicYear: YEAR, code: "A", label: "Tuition", amount: 50000, dueDate: day(-10) });
  await M("FeeCharge").create({ schoolId: S, studentId: "bih", academicYear: YEAR, code: "B", label: "Tuition", amount: 70000, dueDate: day(20) });

  const auth = require(path.join(__dirname, "..", "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/admin", auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
  const server = app.listen(0);
  const get = async (id, role) => {
    const token = jwt.sign({ id, role, schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/action-items`,
      { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, items: body.items ?? body.data?.items ?? null };
  };

  console.log("\n--- an administrator ---");
  let r = await get("adm-1", "school_admin");
  check("→ 200", r.status, 200);
  const by = (k) => (r.items ?? []).find((i) => i.key === k) ?? null;
  check("two subjects' marks await approval, on one exam → its marks tab",
    [by("marksAwaitingApproval")?.count, by("marksAwaitingApproval")?.link], [2, "/exams/e1?tab=marks"]);
  check("one exam's results are processed and not published → its results tab",
    [by("resultsUnpublished")?.count, by("resultsUnpublished")?.link], [1, "/exams/e1?tab=results"]);
  check("one family is overdue, for 50,000 — fees not yet due are not counted",
    [by("overdueFees")?.count, by("overdueFees")?.amount], [1, 50000]);

  console.log("\n--- a teacher ---");
  r = await get("tch-1", "teacher");
  // Refused at the route like every admin route (check:admin); the bell reads a
  // refusal as "no items".
  check("is refused — a teacher can act on none of them", [r.status, r.items], [403, null]);

  console.log("\n--- the work is done ---");
  await M("ExamSubject").updateMany({ examId: "e1" }, { submissionStatus: "approved" });
  r = await get("adm-1", "school_admin");
  check("approving the marks removes the item, with nothing to mark read",
    (r.items ?? []).map((i) => i.key), ["resultsUnpublished", "overdueFees"]);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
