// backend/scripts/check-attendance-history.js
"use strict";

/**
 * What the register used to say.
 *
 * Attendance was the one record type where last-write-wins left no trace. The
 * natural key is unique, so a re-mark UPDATES the row: the old status was
 * overwritten in place and gone. `markedBy` names whoever set the value that
 * survived and nothing anywhere said what it replaced, or who had said
 * otherwise.
 *
 * A pupil marked present by the form master and absent by a subject teacher an
 * hour later ended the day absent, and nobody could find out there had been a
 * disagreement — which is precisely the question a parent asks.
 *
 * check-conflicts records that gap; this closes it. The assertions below are
 * the properties the history has to hold, and the one that matters most is not
 * "a row was written" but "the overwritten value can be read back".
 *
 * ── The idempotency argument, asserted rather than assumed ────────────────
 *
 * There is no de-duplication key. A row is written only where the status
 * actually moved, and that is what makes a replayed sync safe: the first
 * attempt applies present → absent and records it; the replay reads absent,
 * finds the new value equal to the old, and writes nothing. A deliberate change
 * back is three genuine rows, and any key clever enough to suppress the retry
 * would suppress that too.
 *
 *   node scripts/check-attendance-history.js
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
  const User      = mongoose.model("User");
  const Student   = mongoose.model("Student");
  const Class     = mongoose.model("Class");
  const Register  = mongoose.model("StudentAttendance");
  const History   = mongoose.model("AttendanceChangeLog");

  const A = "school-a";
  const B = "school-b";
  const DAY = "2026-09-01";

  const mkUser = (id, role, schoolId, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: "check-only-password",
    role, schoolId, isActive: true,
  });

  await mkUser("form-master",  "teacher",      A, "Form Master");
  await mkUser("subject-tea",  "teacher",      A, "Subject Teacher");
  await mkUser("adm-a",        "school_admin", A, "Admin A");
  await mkUser("stu-a",        "student",      A, "A Pupil");
  await mkUser("adm-b",        "school_admin", B, "Admin B");

  await Class.create({ _id: "cls-a", schoolId: A, name: "Form 1" });
  await Class.create({ _id: "cls-b", schoolId: B, name: "Form 1 B" });
  await Student.create({
    _id: "st-1", userId: "stu-a", schoolId: A, classId: "cls-a",
    studentName: "Bern Constance", enrollmentNo: "E-1", isActive: true,
  });
  await Student.create({
    _id: "st-b", userId: "usr-b", schoolId: B, classId: "cls-b",
    studentName: "Someone Else", enrollmentNo: "B-1", isActive: true,
  });

  const app = express();
  app.use(express.json());
  const auth = require(path.join(ROOT, "middleware/auth"));
  app.use("/api/attendance", auth.authenticate, require(path.join(SRC, "routes/attendance.routes")));
  const server = app.listen(0);
  const port   = server.address().port;

  const tok = (id, role, schoolId) =>
    jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });

  const TOK = {
    formMaster: tok("form-master", "teacher",      A),
    subjectTea: tok("subject-tea", "teacher",      A),
    adminA:     tok("adm-a",       "school_admin", A),
    student:    tok("stu-a",       "student",      A),
    adminB:     tok("adm-b",       "school_admin", B),
  };

  /** Mark the register, as a client would. */
  const mark = async (who, status, { studentId = "st-1", classId = "cls-a", schoolId = A } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/attendance/students/bulk`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOK[who]}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        schoolId, classId, date: DAY,
        records: [{ studentId, status }],
      }),
    });
    let body = {}; try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };

  const historyFor = (studentId = "st-1") =>
    History.find({ studentId }).sort({ changedAt: 1 }).lean();

  const readHistory = async (who, qs = "") => {
    const res = await fetch(`http://127.0.0.1:${port}/api/attendance/history${qs}`, {
      headers: { Authorization: `Bearer ${TOK[who]}` },
    });
    let body = {}; try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };

  // ── A first mark is not a conflict ────────────────────────────────────────
  console.log("\n--- taking the register for the first time ---");

  const first = await mark("formMaster", "present");
  if (first.status < 400) ok(`the form master marks the pupil present (${first.status})`);
  else bad("the first mark is accepted", `${first.status} ${JSON.stringify(first.body).slice(0, 200)}`);

  if ((await historyFor()).length === 0) {
    ok("and no history row is written — there was nothing to lose");
  } else {
    bad("a first mark writes no history", JSON.stringify(await historyFor()));
  }

  // ── The overwrite ─────────────────────────────────────────────────────────
  console.log("\n--- and an hour later a subject teacher says otherwise ---");

  await mark("subjectTea", "absent");

  const live = await Register.findOne({ studentId: "st-1", date: DAY }).lean();
  if (live?.status === "absent") ok("the later mark wins — last write, unchanged");
  else bad("the later mark wins", JSON.stringify(live?.status));

  const rows = await historyFor();
  if (rows.length === 1) ok("and exactly one history row is written");
  else bad("one history row is written", `${rows.length} row(s)`);

  const h = rows[0] ?? {};
  if (h.previousStatus === "present" && h.newStatus === "absent") {
    ok("recording present → absent: the overwritten value is recoverable");
  } else {
    bad("the overwritten value is recoverable",
      `${JSON.stringify(h.previousStatus)} → ${JSON.stringify(h.newStatus)}`);
  }

  if (h.previousMarkedBy === "form-master" && h.changedBy === "subject-tea") {
    ok("with both actors — whose mark it was, and who replaced it");
  } else {
    bad("both actors are recorded",
      `previous=${h.previousMarkedBy} changed=${h.changedBy}`);
  }

  if (h.schoolId === A && h.studentId === "st-1" && h.date === DAY && h.attendanceId) {
    ok("and enough to find the register entry it belongs to");
  } else {
    bad("the row identifies its register entry", JSON.stringify(h).slice(0, 200));
  }

  if (h.changedAt) ok("and when");
  else bad("the change is timestamped", JSON.stringify(h.changedAt));

  // ── The other direction ───────────────────────────────────────────────────
  console.log("\n--- and back again ---");

  await mark("formMaster", "present");
  const both = await historyFor();

  if (both.length === 2 && both[1].previousStatus === "absent" && both[1].newStatus === "present") {
    ok("absent → present records absent as the previous value");
  } else {
    bad("the reverse change is recorded",
      JSON.stringify(both.map((r) => `${r.previousStatus}→${r.newStatus}`)));
  }

  // ── A replay ──────────────────────────────────────────────────────────────
  console.log("\n--- the same request arrives twice ---");

  const beforeReplay = (await historyFor()).length;
  await mark("formMaster", "present");        // identical to the last one
  await mark("formMaster", "present");        // and again
  const afterReplay = (await historyFor()).length;

  if (afterReplay === beforeReplay) {
    ok("a replayed sync writes no history — the status did not move");
  } else {
    bad("a replay writes no history",
      `${beforeReplay} rows became ${afterReplay}. A retried outbox entry would ` +
      "fill the history with rows describing a change that never happened.");
  }

  const stillLive = await Register.findOne({ studentId: "st-1", date: DAY }).lean();
  if (stillLive?.status === "present") ok("and the register still says what it said");
  else bad("the register is unchanged by a replay", JSON.stringify(stillLive?.status));

  // ── Two devices, offline, then both reconnect ─────────────────────────────
  console.log("\n--- two devices that were both offline ---");

  const beforeRace = (await historyFor()).length;
  await mark("formMaster", "absent");     // device A drains first
  await mark("subjectTea", "excused");    // device B drains second

  const final = await Register.findOne({ studentId: "st-1", date: DAY }).lean();
  const race  = await historyFor();

  if (final?.status === "excused") ok("the last to arrive wins, as before");
  else bad("the last to arrive wins", JSON.stringify(final?.status));

  if (race.length === beforeRace + 2) ok("and both steps are in the history, in order");
  else bad("both steps are recorded", `${race.length - beforeRace} new row(s)`);

  const lastTwo = race.slice(-2);
  if (lastTwo[0].previousStatus === "present" && lastTwo[0].newStatus === "absent" &&
      lastTwo[1].previousStatus === "absent"  && lastTwo[1].newStatus === "excused") {
    ok("so the whole path present → absent → excused can be reconstructed");
  } else {
    bad("the path can be reconstructed",
      JSON.stringify(lastTwo.map((r) => `${r.previousStatus}→${r.newStatus}`)));
  }

  // The state and the history have to agree about where it ended up.
  if (race[race.length - 1].newStatus === final?.status) {
    ok("and the last history row agrees with the register");
  } else {
    bad("the history agrees with the register",
      `${race[race.length - 1].newStatus} vs ${final?.status}`);
  }

  // ── Who may read it ───────────────────────────────────────────────────────
  console.log("\n--- who may read the history ---");

  const asAdmin = await readHistory("adminA", `?studentId=st-1`);
  if (asAdmin.status === 200 && (asAdmin.body?.changes?.length ?? 0) > 0) {
    ok(`an administrator of the school reads it (${asAdmin.body.changes.length} rows)`);
  } else {
    bad("an administrator reads it", `${asAdmin.status} ${JSON.stringify(asAdmin.body).slice(0, 160)}`);
  }

  const named = asAdmin.body?.changes?.[0];
  if (named?.changedByName || named?.previousMarkedByName) {
    ok("with the actors named, not only their ids");
  } else {
    bad("the actors are named", JSON.stringify(named).slice(0, 200));
  }

  const asStudent = await readHistory("student", `?studentId=st-1`);
  if ([401, 403].includes(asStudent.status)) {
    ok(`a pupil may not read it (${asStudent.status})`);
  } else {
    bad("a pupil may not read the history",
      `${asStudent.status} — attendance.view is a staff capability and this is ` +
      "the register's own history.");
  }

  // ── Another school ────────────────────────────────────────────────────────
  console.log("\n--- another school asking ---");

  const asOther = await readHistory("adminB", `?studentId=st-1`);
  const leaked  = JSON.stringify(asOther.body ?? {}).includes("st-1");
  if (!leaked) ok("school B receives nothing of school A's register history");
  else bad("school B receives nothing of school A's",
    `${asOther.status} ${JSON.stringify(asOther.body).slice(0, 200)}`);

  // Proved against a real row over there, so "nothing came back" is not just
  // an empty collection.
  await mark("adminB", "absent", { studentId: "st-b", classId: "cls-b", schoolId: B });
  await mark("adminB", "present", { studentId: "st-b", classId: "cls-b", schoolId: B });

  const ownB = await readHistory("adminB", `?studentId=st-b`);
  if ((ownB.body?.changes?.length ?? 0) > 0) ok("while school B does see its own");
  else bad("school B sees its own history", JSON.stringify(ownB.body).slice(0, 160));

  const crossA = await readHistory("adminA", `?studentId=st-b`);
  if (!JSON.stringify(crossA.body ?? {}).includes("st-b")) {
    ok("and school A cannot read school B's either — it is scoped both ways");
  } else {
    bad("school A cannot read school B's", JSON.stringify(crossA.body).slice(0, 200));
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
