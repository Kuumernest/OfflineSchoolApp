// backend/scripts/check-attendance-dashboard.js
"use strict";

/**
 * The dashboard's attendance figures must be the attendance report's figures.
 *
 * Two endpoints answer "how many children are in school today":
 *
 *   GET /api/admin/attendance/stats      — the administrator dashboard widget
 *   GET /api/attendance/report/overview  — the attendance report screen
 *
 * They disagreed. A register has four states — present, absent, late, excused —
 * and the dashboard counted two of them, then divided by their sum:
 *
 *     rate = present / (present + absent)
 *
 * So a pupil marked late or excused was missing twice over: absent from the
 * figures, and absent from the denominator that produced the headline rate. A
 * class of 40 with 30 present, 5 absent and 5 late showed 86% of a total of 35
 * on the dashboard while the report called the same day 75% of 40. Five
 * children were invisible, and the number the head teacher reads first was the
 * flattering one.
 *
 * Neither endpoint was obviously wrong on its own. That is what makes this
 * worth pinning by example rather than by reading: the bug only exists in the
 * gap between them, and the gap is invisible from either side.
 *
 * What this proves, on one seeded day:
 *   • every one of the four states is counted
 *   • the roster is the denominator, not the number of marked pupils
 *   • an unmarked register reads as unmarked, not as nobody present
 *   • the two endpoints return the same present/absent/late/excused/rate
 *
 * Boots mongodb-memory-server. No external services.
 *
 *   node scripts/check-attendance-dashboard.js
 */

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");

const SCHOOL  = "aaaaaaaaaaaaaaaaaaaaaaaa";
const CLASS   = "class-1";

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180_000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "attendance-dashboard" });
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const User    = require("../src/db/models/User");
  const Student = require("../src/db/models/Student");
  const { StudentAttendance } = require("../src/db/models/Attendance");
  const { todayStr } = require("../../shared/attendance");

  const admin = async (role, id) => {
    await User.collection.insertOne({
      _id: id, name: `Test ${role}`, email: `${id}@x.com`, role,
      schoolId: SCHOOL, isActive: true, password: "x",
      createdAt: new Date(), updatedAt: new Date(),
    });
    return jwt.sign({ id, role, schoolId: SCHOOL }, process.env.JWT_SECRET, { expiresIn: "1h" });
  };

  const token = await admin("school_admin", "admin-1");

  // ── A roster of 12, and a register that uses all four states ─────────────
  const ROSTER = 12;
  for (let i = 1; i <= ROSTER; i++) {
    await Student.collection.insertOne({
      _id: `student-${i}`, schoolId: SCHOOL, classId: CLASS,
      studentName: `Pupil ${i}`, status: "approved", isActive: true,
      deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
  }

  const date = todayStr();
  // 6 present, 2 absent, 2 late, 1 excused, 1 never marked.
  const PLAN = [
    ...Array(6).fill("present"),
    ...Array(2).fill("absent"),
    ...Array(2).fill("late"),
    "excused",
  ];
  for (let i = 0; i < PLAN.length; i++) {
    await StudentAttendance.collection.insertOne({
      _id: `att-${i}`, schoolId: SCHOOL, classId: CLASS,
      subjectId: null, periodId: null,
      studentId: `student-${i + 1}`, markedBy: "admin-1",
      date, status: PLAN[i], markedAt: new Date(),
      createdAt: new Date(), updatedAt: new Date(),
    });
  }

  const app = express();
  app.use(express.json());
  const auth = require("../middleware/auth");
  app.use("/api/admin", auth.authenticate, require("../src/routes/admin.routes"));
  app.use("/api/attendance", auth.authenticate, require("../src/routes/attendance.routes"));
  const server = app.listen(0);
  const port   = server.address().port;

  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json ?? {} };
  };

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the dashboard counts every state a register has ---");

  const dash = await get(`/api/admin/attendance/stats?schoolId=${SCHOOL}`);
  check("the dashboard endpoint answers", dash.status, 200);

  const d = dash.body?.data ?? dash.body;
  check("present",  d.todayPresent, 6);
  check("absent",   d.todayAbsent,  2);
  check("late is counted, not dropped",    d.todayLate,    2);
  check("excused is counted, not dropped", d.todayExcused, 1);

  console.log("\n--- the roster is the denominator ---");

  check("total is the roster, not the marked pupils", d.total, ROSTER);
  check("marked counts the register rows", d.marked, PLAN.length);
  check("and the pupil nobody marked is visible", d.unmarked, ROSTER - PLAN.length);
  // 6 of 12, not 6 of 8 (which would be 75%) and not 6 of 11 (55%).
  check("rate is present over the roster", d.rate, 50);

  console.log("\n--- and it agrees with the attendance report ---");

  const rep = await get(`/api/attendance/report/overview?schoolId=${SCHOOL}`);
  check("the report endpoint answers", rep.status, 200);

  const r = (rep.body?.data ?? rep.body)?.students ?? {};
  check("present agrees",  d.todayPresent, r.present);
  check("absent agrees",   d.todayAbsent,  r.absent);
  check("late agrees",     d.todayLate,    r.late);
  check("excused agrees",  d.todayExcused, r.excused);
  check("total agrees",    d.total,        r.total);
  check("unmarked agrees", d.unmarked,     r.unmarked);
  check("and the headline rate agrees", d.rate, r.rate);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- a register nobody took is not a school nobody attended ---");

  await StudentAttendance.deleteMany({ schoolId: SCHOOL });
  const empty = await get(`/api/admin/attendance/stats?schoolId=${SCHOOL}`);
  const e = empty.body?.data ?? empty.body;

  check("present is zero", e.todayPresent, 0);
  check("rate is zero",    e.rate, 0);
  // The pair that tells "nobody came" apart from "nobody marked the register".
  check("but the roster is still known", e.total, ROSTER);
  check("and every pupil reads as unmarked", e.unmarked, ROSTER);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongo.stop();
  process.exit(fail ? 1 : 0);
};

main().catch(async (err) => {
  console.error("\nHarness error:", err);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
