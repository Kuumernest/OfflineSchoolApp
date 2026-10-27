// backend/scripts/check-student-overview.js
"use strict";

/**
 * C10 — the student profile overview (GET /admin/students/:id/overview).
 *
 * Worked by hand, "today" = 2026-10-27, current year 2026/2027, pass mark 12:
 *
 *   results  ama: seq 1 = 14.5 (2nd of 3 in Form 1), seq 2 = 9 (3rd of 3),
 *            seq 3 = 18 but NOT published                → seq 2 first, then seq 1
 *   attendance (last 30 days): present 6, late 2, absent 2 → marked 10, rate 80
 *            plus one absence 40 days ago                → outside the window
 *   fees     2026/2027: 100,000 less 10,000 waived, paid 30,000 → balance 60,000
 *            2025/2026: 50,000 unpaid                    → another year, not counted
 *   bih      never marked                                → rate null (C3), not 0
 *
 *   node scripts/check-student-overview.js
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
  const { overviewFor } = require(path.join(SRC, "services/studentOverview.service"));

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const S = new mongoose.Types.ObjectId().toString();
  const YEAR = "2026/2027";
  const TODAY = new Date("2026-10-27T10:00:00Z");
  const day = (n) => new Date(TODAY.getTime() - n * 86_400_000).toISOString().slice(0, 10);

  await M("School").create({ _id: S, name: "Green Valley", email: "gv-ov@example.test", settings: { academicYear: YEAR } });
  await M("GradingConfig").create({ schoolId: S, passMark: 12 });
  await M("User").create({
    _id: "adm-1", name: "Admin", email: "adm-ov@example.test",
    password: "check-only-password", role: "school_admin", schoolId: S, isActive: true,
  });
  const pupil = (id) => M("Student").create({
    _id: id, userId: `u-${id}`, schoolId: S, classId: "f1", className: "Form 1",
    studentName: `Pupil ${id}`, enrollmentNo: `EN-${id}`, status: "approved", isActive: true,
    guardianName: "Mrs Tem", guardianPhone: "+237670000000",
  });
  await pupil("ama"); await pupil("bih"); await pupil("cho");

  const exam = (id, seq) => M("Exam").create({ _id: id, schoolId: S, name: `Sequence ${seq}`, type: "test",
    academicYear: YEAR, term: 1, sequenceNumber: seq, status: "published", classId: "f1", classIds: ["f1"] });
  await exam("s1", 1); await exam("s2", 2); await exam("s3", 3);
  const summary = (examId, studentId, average, classPosition, extra = {}) => M("ResultSummary").create({
    examId, studentId, classId: "f1", schoolId: S, average, classPosition, isPublished: true,
    calcVersion: "exam-process/3", academicYear: YEAR, term: "1", ...extra,
  });
  await summary("s1", "ama", 14.5, 2); await summary("s1", "bih", 15, 1); await summary("s1", "cho", 8, 3);
  await summary("s2", "ama", 9, 3);    await summary("s2", "bih", 13, 1); await summary("s2", "cho", 11, 2);
  await summary("s3", "ama", 18, 1, { isPublished: false });

  const mark = (studentId, date, status, i) => M("StudentAttendance").create({
    schoolId: S, classId: "f1", subjectId: null, period: `p${i}`, studentId, date, status, markedBy: "adm-1",
  });
  let i = 0;
  for (const st of ["present", "present", "present", "present", "present", "present", "late", "late", "absent", "absent"]) {
    await mark("ama", day(1 + i), st, i); i++;
  }
  await mark("ama", day(40), "absent", 99);

  await M("FeeCharge").create({ schoolId: S, studentId: "ama", academicYear: YEAR, code: "T1", label: "Tuition", amount: 100000, waivedAmount: 10000 });
  await M("FeePayment").create({ schoolId: S, studentId: "ama", academicYear: YEAR, amount: 30000 });
  await M("FeeCharge").create({ schoolId: S, studentId: "ama", academicYear: "2025/2026", code: "T0", label: "Tuition", amount: 50000 });

  console.log("\n--- the service ---");
  const ama = await M("Student").findById("ama").lean();
  const o = await overviewFor({ schoolId: S, student: ama, asOf: TODAY });
  check("published results only, newest first, on /20, against the pass mark, out of the class",
    o.results.map((r) => [r.examName, r.average, r.passed, r.position, r.outOf]),
    [["Sequence 2", 9, false, 3, 3], ["Sequence 1", 14.5, true, 2, 3]]);
  check("attendance in the window: late counts as attended",
    [o.attendance.present, o.attendance.late, o.attendance.absent, o.attendance.marked, o.attendance.rate],
    [6, 2, 2, 10, 80]);
  check("fees for the current year only, net of waivers",
    o.fees, { academicYear: YEAR, charged: 90000, paid: 30000, balance: 60000 });
  check("the guardian's contact", [o.guardian.name, o.guardian.phone], ["Mrs Tem", "+237670000000"]);

  const bih = await overviewFor({ schoolId: S, student: await M("Student").findById("bih").lean(), asOf: TODAY });
  check("never marked → no rate (–), not 0%", [bih.attendance.marked, bih.attendance.rate], [0, null]);
  const noFees = await overviewFor({ schoolId: S, student: ama, withFees: false, asOf: TODAY });
  check("a caller without fees.view gets no fee figures", noFees.fees, null);

  console.log("\n--- the route ---");
  const auth = require(path.join(__dirname, "..", "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/admin", auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
  const server = app.listen(0);
  const token  = jwt.sign({ id: "adm-1", role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const get = async (id) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/students/${id}/overview`,
      { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const r = await get("ama");
  const ov = r.body?.data?.overview ?? r.body?.overview;
  check("an administrator reads it → 200 with results and fees",
    [r.status, ov?.results?.length, ov?.fees?.balance], [200, 2, 60000]);
  check("a pupil of another school → 404", (await get("nobody")).status, 404);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
