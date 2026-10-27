// backend/scripts/check-timetable-rules.js
"use strict";

/**
 * B1 (decided 2026-10-27): no lesson in a Break, and only a teacher the
 * class-subject assignment names — through the real endpoint, and the pure
 * rule the desktop mirror shares.
 *
 *   Form 1 English is Mr Kum's; Form 1 French is Mrs Johnson's.
 *   Mrs Johnson for Form 1 English on Friday → refused (it was accepted)
 *   Mr Kum for Form 1 English in Break        → refused
 *   Mr Kum for Form 1 English in Period 1     → created
 *   moving it to Mrs Johnson (PUT)             → refused
 *
 *   node scripts/check-timetable-rules.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  console.log("--- the rule ---");
  const { timetableSlotProblem } = require("../../shared/timetableRules");
  const P1 = { _id: "p1", name: "Period 1", isBreak: false };
  check("a break", timetableSlotProblem({ period: { name: "Break", isBreak: true }, assignedIds: ["kum"], teacherId: "kum" })?.code, "break_period");
  check("a deleted period", timetableSlotProblem({ period: { ...P1, deletedAt: new Date() }, assignedIds: ["kum"], teacherId: "kum" })?.code, "period_missing");
  check("no period at all", timetableSlotProblem({ period: null, assignedIds: ["kum"], teacherId: "kum" })?.code, "period_missing");
  check("a teacher not assigned", timetableSlotProblem({ period: P1, assignedIds: ["kum"], teacherId: "grace" })?.code, "teacher_not_assigned");
  check("an assigned teacher in a teaching period", timetableSlotProblem({ period: P1, assignedIds: ["kum", "buh"], teacherId: "buh" }), null);

  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);

  const S = "gva";
  await M("User").create([
    { _id: "adm", name: "Admin", email: "adm@example.test", password: "check-only-password", role: "school_admin", schoolId: S, isActive: true },
    { _id: "kum", name: "Mr Kum", email: "kum@example.test", password: "check-only-password", role: "teacher", schoolId: S, isActive: true },
    { _id: "grace", name: "Grace Johnson", email: "grace@example.test", password: "check-only-password", role: "teacher", schoolId: S, isActive: true },
  ]);
  await M("Period").create([
    { _id: "p1", schoolId: S, name: "Period 1", startTime: "08:00", endTime: "08:55", sortOrder: 1 },
    { _id: "brk", schoolId: S, name: "Break", startTime: "10:25", endTime: "10:45", sortOrder: 3, isBreak: true },
  ]);
  await M("TeacherAssignment").create([
    { _id: "a1", schoolId: S, teacher: "kum",   class: "f1", subject: "en-f1" },
    { _id: "a2", schoolId: S, teacher: "grace", class: "f1", subject: "fr-f1" },
  ]);

  const auth = require(path.join(ROOT, "middleware/auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/admin/timetable", auth.authenticate, require(path.join(SRC, "routes/timetable.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, error: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api/admin/timetable`;
  const TOKEN = jwt.sign({ id: "adm", role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, url, body) => {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let b = {}; try { b = await res.json(); } catch {}
    return { status: res.status, body: b };
  };
  const lesson = { schoolId: S, classId: "f1", subjectId: "en-f1", dayOfWeek: "FRI" };

  console.log("--- the endpoint ---");
  const grace = await call("POST", API, { ...lesson, teacherId: "grace", periodId: "p1" });
  check("Mrs Johnson for Form 1 English: refused", [grace.status, grace.body.code], [422, "teacher_not_assigned"]);
  const brk = await call("POST", API, { ...lesson, teacherId: "kum", periodId: "brk" });
  check("a lesson in Break: refused", [brk.status, brk.body.code], [422, "break_period"]);
  const okay = await call("POST", API, { ...lesson, teacherId: "kum", periodId: "p1" });
  check("Mr Kum for Form 1 English in Period 1: created", okay.status, 201);
  const moved = await call("PUT", `${API}/${okay.body.slot?._id}`, { teacherId: "grace" });
  check("changing it to Mrs Johnson: refused", [moved.status, moved.body.code], [422, "teacher_not_assigned"]);
  const toBreak = await call("PUT", `${API}/${okay.body.slot?._id}`, { periodId: "brk" });
  check("moving it into Break: refused", [toBreak.status, toBreak.body.code], [422, "break_period"]);
  check("and nothing was written but the one good lesson", await M("TimetableSlot").countDocuments({ schoolId: S }), 1);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Harness error:", e); process.exit(1); });
