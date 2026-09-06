// backend/scripts/check-portal-gate.js
"use strict";

/**
 * The time a child reached school, where their parent can see it.
 *
 * The gate records every scan, and the scan does notify the guardian — but
 * only through the exceptions policy: a late arrival, or a child leaving at
 * eleven in the morning. That policy is right. "Arrived 07:42" pushed to a
 * phone every morning is noise somebody stops opening, and then the message
 * that mattered is buried in it.
 *
 * The consequence nobody had looked at is that a child who is never late has
 * no gate record in the portal at all. The parent of a punctual child could
 * not answer "what time did she get there?" — the data existed and had no
 * surface.
 *
 * A portal is not a push. Nobody is interrupted by a page they chose to open,
 * so the times now travel with the attendance the parent already fetches, and
 * the notification policy is untouched.
 *
 *   node scripts/check-portal-gate.js
 */

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

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

  require(path.join(SRC, "db/models"));
  const Student        = mongoose.model("Student");
  const Class          = mongoose.model("Class");
  const GuardianAccess = mongoose.model("GuardianAccess");
  const GateEvent      = mongoose.model("GateEvent");
  const Attendance     = mongoose.model("StudentAttendance");
  const User           = mongoose.model("User");

  const S      = "sch-1";
  const ACCESS = "acc-1";
  const DAY    = "2026-09-01";

  await User.create({
    _id: "adm-1", name: "Admin", email: "adm@example.test",
    password: "check-only-password", role: "school_admin", schoolId: S, isActive: true,
  });
  await Class.create({ _id: "cls-1", schoolId: S, name: "Form 1" });

  for (const [id, name] of [["st-1", "Mine"], ["st-2", "Somebody else's"]]) {
    await Student.create({
      _id: id, userId: `usr-${id}`, schoolId: S, classId: "cls-1",
      studentName: name, enrollmentNo: id, isActive: true,
    });
  }

  await GuardianAccess.create({
    _id: ACCESS, schoolId: S, studentIds: ["st-1"],
    codeHash: "$2a$10$check.only.not.a.real.hash.value.padding.padding.pad",
    codeHint: "11",
  });

  const scan = (id, studentId, direction, iso, extra = {}) => GateEvent.create({
    _id: id, schoolId: S, studentId, direction, date: DAY,
    at: new Date(iso), scannedBy: "adm-1", station: "main", ...extra,
  });

  // A day with more than one of each: out to the dentist and back again.
  await scan("g1", "st-1", "in",  "2026-09-01T07:42:00Z");
  await scan("g2", "st-1", "out", "2026-09-01T10:05:00Z");
  await scan("g3", "st-1", "in",  "2026-09-01T11:30:00Z");
  await scan("g4", "st-1", "out", "2026-09-01T15:10:00Z");

  // Must not appear: voided, and another child's.
  await scan("g5", "st-1", "in", "2026-09-01T06:00:00Z",
    { voidedAt: new Date(), voidReason: "scanned the wrong badge" });
  await scan("g6", "st-2", "in", "2026-09-01T07:15:00Z");

  const app = express();
  app.use(express.json());
  app.use("/api/portal", require(path.join(SRC, "routes/portal.routes")));
  const server = app.listen(0);
  const port   = server.address().port;

  const token = jwt.sign({ accessId: ACCESS, schoolId: S },
    process.env.JWT_SECRET, { audience: "portal", expiresIn: "1h" });

  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/portal${p}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    let body = {}; try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };

  const hhmm = (iso) => (iso ? new Date(iso).toISOString().slice(11, 16) : null);

  // ── With no register at all ───────────────────────────────────────────────
  console.log("\n--- a school that scans at the gate but keeps no register ---");

  let r = await get("/attendance");
  let d = r.body?.data ?? {};

  if (r.status === 200) ok("the attendance payload answers");
  else bad("the attendance payload answers", `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);

  if ((d.total ?? 0) === 0) ok("and there is no register to report");
  else bad("there is no register to report", String(d.total));

  if ((d.gate?.length ?? 0) === 1) ok("the gate day still comes through — the parent is not shown an empty tab");
  else bad("the gate day comes through", JSON.stringify(d.gate));

  // ── The times themselves ──────────────────────────────────────────────────
  console.log("\n--- the times ---");

  const day = (d.gate ?? [])[0] ?? {};

  if (hhmm(day.arrivedAt) === "07:42") ok("arrival is the FIRST way in that day (07:42, not the 11:30 return)");
  else bad("arrival is the first way in", `${hhmm(day.arrivedAt)}`);

  if (hhmm(day.departedAt) === "15:10") ok("departure is the LAST way out (15:10, not the 10:05 dentist trip)");
  else bad("departure is the last way out", `${hhmm(day.departedAt)}`);

  if (day.scans === 4) ok("all four live scans are counted");
  else bad("all four live scans are counted", `scans=${day.scans}`);

  // ── What must not be in it ────────────────────────────────────────────────
  console.log("\n--- what must not be in it ---");

  // Both of these would pass on an empty payload, which is exactly how a
  // missing feature disguises itself as a safe one. They require the day to
  // have arrived first.
  const haveDay = Boolean(day.arrivedAt);

  // The voided 06:00 scan would have become the arrival if it counted.
  if (haveDay && hhmm(day.arrivedAt) !== "06:00") ok("a voided scan is not the arrival");
  else bad("a voided scan is not the arrival",
    haveDay ? "06:00 came through" : "no gate day to check — see the failures above");

  const text = JSON.stringify(d.gate ?? []);
  if (haveDay && !text.includes("st-2") && !text.includes("07:15")) {
    ok("another child's scan is nowhere in it");
  } else {
    bad("another child's scan is absent",
      haveDay ? text.slice(0, 200) : "no gate day to check — see the failures above");
  }

  // ── Alongside a register ──────────────────────────────────────────────────
  console.log("\n--- and beside the register, when there is one ---");

  await Attendance.create({
    _id: "at-1", schoolId: S, classId: "cls-1", studentId: "st-1",
    date: DAY, status: "present", markedBy: "adm-1",
  });

  r = await get("/attendance");
  d = r.body?.data ?? {};
  const summary = (d.dailySummaries ?? []).find((x) => x.date === DAY) ?? {};

  if (hhmm(summary.arrivedAt) === "07:42" && hhmm(summary.departedAt) === "15:10") {
    ok("the day's register row carries the same two times");
  } else {
    bad("the register row carries the times",
      JSON.stringify({ a: summary.arrivedAt, d: summary.departedAt }));
  }

  // ── The notification policy is untouched ──────────────────────────────────
  console.log("\n--- the push policy is left exactly as it was ---");

  const gate = require("fs").readFileSync(path.join(SRC, "services/gate.service.js"), "utf8");
  if (/gateNotify\s*\?\?\s*"exceptions"/.test(gate)) {
    ok("gate notifications still default to exceptions only, not every scan");
  } else {
    bad("gate notifications still default to exceptions",
      "the portal was given the times so that the push could stay quiet. If " +
      "the default has been changed to notify on every scan, that trade is off.");
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
