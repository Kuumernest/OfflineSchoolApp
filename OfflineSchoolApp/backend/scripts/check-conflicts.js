// backend/scripts/check-conflicts.js
"use strict";

/**
 * What happens when two devices change the same record.
 *
 * Every write in this system is last-write-wins; nothing does version numbers
 * or If-Match. That is a legitimate choice for a school, where two people
 * editing the same pupil in the same minute is rare and a merge dialog on a
 * phone in a staffroom is worse than the problem. But last-write-wins is only
 * acceptable while the losing write leaves a trace, and no suite had ever
 * checked that it does.
 *
 * So this establishes the actual behaviour for the four kinds of record where
 * losing an edit matters most — exam marks, student records, attendance and
 * money — and pins it. Where a trace exists, the assertion proves it contains
 * the value that was overwritten, because a log that records "something
 * changed" without the old figure cannot restore anything.
 *
 * Two of these are not last-write-wins at all, and that is worth pinning too:
 * money is append-only, and a locked or published result refuses the write.
 *
 *   node scripts/check-conflicts.js
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
  const User            = mongoose.model("User");
  const Student         = mongoose.model("Student");
  const Class           = mongoose.model("Class");
  const Subject         = mongoose.model("Subject");
  const Exam            = mongoose.model("Exam");
  const ExamSubject     = mongoose.model("ExamSubject");
  const StudentScore    = mongoose.model("StudentScore");
  const ResultChangeLog = mongoose.model("ResultChangeLog");
  const Attendance      = mongoose.model("StudentAttendance");
  const FeePayment      = mongoose.model("FeePayment");

  const S    = "school-a";
  const YEAR = "2026/2027";

  const mk = (id, role, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: "check-only-password",
    role, schoolId: S, isActive: true,
  });
  await mk("adm-1", "school_admin", "Admin");
  await mk("tea-1", "teacher", "Teacher One");
  await mk("tea-2", "teacher", "Teacher Two");
  await mk("bur-1", "bursar",  "Bursar");

  await Class.create({ _id: "cls-1", schoolId: S, name: "Form 1" });
  await Subject.create({ _id: "sub-1", schoolId: S, classId: "cls-1", name: "Maths" })
    .catch(() => {});
  await Student.create({
    _id: "st-1", userId: "usr-st-1", schoolId: S, classId: "cls-1",
    studentName: "A Pupil", enrollmentNo: "E-1", isActive: true,
  });
  await Exam.create({
    _id: "ex-1", schoolId: S, name: "First Sequence", type: "test",
    academicYear: YEAR, term: 1, sequenceNumber: 1, status: "ongoing",
    classId: "cls-1", totalMarks: 20, passMark: 10,
  });
  await ExamSubject.create({
    _id: "es-1", examId: "ex-1", schoolId: S, classId: "cls-1",
    subjectId: "sub-1", subjectName: "Maths", maxScore: 20,
  }).catch((e) => console.log("  (exam subject: " + e.message + ")"));

  const auth = require(path.join(ROOT, "middleware/auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/exams", auth.authenticate, require(path.join(SRC, "routes/exam.routes")));
  app.use("/api/fees",  auth.authenticate, require(path.join(SRC, "routes/fees.routes")));

  const server = app.listen(0);
  const port   = server.address().port;

  const tok = (id, role) => jwt.sign({ id, role, schoolId: S },
    process.env.JWT_SECRET, { expiresIn: "1h" });

  const post = async (who, role, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok(who, role)}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let json = {}; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };

  // ── Exam marks: two teachers, the same pupil, the same subject ────────────
  console.log("\n--- two teachers enter a different mark for the same pupil ---");

  const marks = (who, score) => post(who, "teacher", "/api/exams/ex-1/scores/bulk", {
    schoolId: S, classId: "cls-1", subjectId: "sub-1", examSubjectId: "es-1",
    scores: [{ studentId: "st-1", score }],
  });

  const first = await marks("tea-1", 12);
  if (first.status < 400) ok(`the first teacher's mark is accepted (${first.status})`);
  else bad("the first mark is accepted", `${first.status} ${JSON.stringify(first.body).slice(0, 200)}`);

  const second = await marks("tea-2", 17);
  if (second.status < 400) ok(`the second teacher's mark is accepted (${second.status})`);
  else bad("the second mark is accepted", `${second.status} ${JSON.stringify(second.body).slice(0, 200)}`);

  const stored = await StudentScore.findOne({ examId: "ex-1", studentId: "st-1", subjectId: "sub-1" }).lean();
  if (stored?.score === 17) ok("the later mark wins — last write, as designed");
  else bad("the later mark wins", JSON.stringify(stored?.score));

  if (!stored || (await StudentScore.countDocuments({ examId: "ex-1", studentId: "st-1", subjectId: "sub-1" })) === 1) {
    ok("and there is one score row, not two");
  } else {
    bad("there is one score row", "the unique index on examId+studentId+subjectId did not hold");
  }

  // The trace. Without the old value in it, the log cannot undo anything.
  const logs = await ResultChangeLog.find({ studentId: "st-1" }).lean();
  const sawTwelve = logs.some((l) =>
    String(l.oldValue) === "12" || Number(l.oldValue) === 12);

  if (logs.length > 0) ok(`the overwrite is recorded (${logs.length} change row(s))`);
  else bad("the overwrite is recorded",
    "nothing in ResultChangeLog. A mark a teacher spent an evening entering " +
    "can be replaced by another device with no way to find out what it was.");

  if (sawTwelve) ok("and the record carries the mark that was replaced, not just that it changed");
  else bad("the record carries the replaced mark",
    JSON.stringify(logs.map((l) => ({ f: l.field, o: l.oldValue, n: l.newValue }))).slice(0, 220));

  // ── A published result refuses the write outright ─────────────────────────
  console.log("\n--- a locked exam is not last-write-wins at all ---");

  // Protection is read from ResultSummary, not from the Exam — getProtection
  // asks whether any summary for this exam is locked or published. Setting the
  // flag on the Exam looked right and proved nothing.
  await mongoose.model("ResultSummary").create({
    _id: "sum-1", examId: "ex-1", schoolId: S, studentId: "st-1", classId: "cls-1",
    totalScore: 17, maxTotalScore: 20, percentage: 85, average: 17,
    overallGrade: "A", isLocked: true,
  });
  const afterLock = await marks("tea-1", 3);
  const lockedStored = await StudentScore.findOne({ examId: "ex-1", studentId: "st-1" }).lean();

  if (afterLock.status >= 400) ok(`a locked exam refuses the write (${afterLock.status})`);
  else bad("a locked exam refuses the write", `${afterLock.status}`);

  if (lockedStored?.score === 17) ok("and the mark on record is untouched by the refusal");
  else bad("the mark is untouched", JSON.stringify(lockedStored?.score));

  // ── And the way through it ───────────────────────────────────
  //
  // A refusal with no way past it is not a safeguard, it is a dead end. The
  // override existed on the server from the start and no client could reach
  // it: the strings for the prompt sat in both locale files and nothing
  // rendered them, so an administrator correcting a mark after an appeal got
  // a 423 and nowhere to put the reason.
  console.log("\n--- correcting a published result, which an admin may do ---");

  // The same summary, moved from locked to published: ResultSummary carries a
  // unique index on examId+studentId, so there is only ever one per pupil.
  await mongoose.model("ResultSummary").updateOne(
    { _id: "sum-1" },
    { $set: { isLocked: false, isPublished: true, publishedAt: new Date() } }
  );

  const marksAs = (who, role, score, changeReason) =>
    post(who, role, "/api/exams/ex-1/scores/bulk", {
      schoolId: S, classId: "cls-1", subjectId: "sub-1", examSubjectId: "es-1",
      scores: [{ studentId: "st-1", score }],
      ...(changeReason ? { changeReason } : {}),
    });

  // A teacher is refused whatever they write in the box.
  const teacherTry = await marksAs("tea-1", "teacher", 19, "I disagree with it");
  if (teacherTry.status === 423 && teacherTry.body?.code === "RESULTS_PUBLISHED") {
    ok("a teacher is refused a published result, and a reason does not help them");
  } else {
    bad("a teacher is refused a published result",
      `${teacherTry.status} ${JSON.stringify(teacherTry.body).slice(0, 140)}`);
  }

  const noReason = await marksAs("adm-1", "school_admin", 19);
  if (noReason.status === 423 && noReason.body?.code === "REASON_REQUIRED") {
    ok("an administrator with no reason is asked for one, by a code the client can act on");
  } else {
    bad("an administrator with no reason is asked for one",
      `${noReason.status} ${JSON.stringify(noReason.body).slice(0, 140)}`);
  }

  const REASON = "Paper 2 remarked after appeal";
  const withReason = await marksAs("adm-1", "school_admin", 19, REASON);
  if (withReason.status < 400) ok(`and with one the correction goes through (${withReason.status})`);
  else bad("the correction goes through", `${withReason.status} ${JSON.stringify(withReason.body).slice(0, 160)}`);

  const corrected = await StudentScore.findOne({ examId: "ex-1", studentId: "st-1" }).lean();
  if (corrected?.score === 19) ok("the mark is the corrected one");
  else bad("the mark is corrected", JSON.stringify(corrected?.score));

  const override = (await ResultChangeLog.find({ studentId: "st-1" }).lean())
    .find((l) => l.isOverride);

  if (override) ok("the change is recorded as an override, not an ordinary edit");
  else bad("the change is recorded as an override", "no row carries isOverride");

  if (override?.reason === REASON) {
    ok("and the reason typed by the administrator is what was stored");
  } else {
    bad("the reason is stored", JSON.stringify(override?.reason));
  }

  // The web has to be able to send it, or the server’s door opens onto a wall.
  const page = require("fs").readFileSync(
    path.join(ROOT, "..", "web", "src", "pages", "exams", "[id]", "index.tsx"), "utf8");
  if (/REASON_REQUIRED/.test(page) && /changeReason/.test(page)) {
    ok("the web marks screen recognises the refusal and can send a reason back");
  } else {
    bad("the web marks screen can send a reason",
      "the server asks for a changeReason and the screen has nowhere to type one, " +
      "so the correction cannot be completed in the app at all.");
  }

  const mobileScreen = require("fs").readFileSync(
    path.join(ROOT, "..", "mobile", "app", "admin", "exams", "marks.js"), "utf8");
  if (/REASON_REQUIRED/.test(mobileScreen) && /changeReason/.test(mobileScreen)) {
    ok("and so does the phone");
  } else {
    bad("the phone can send a reason too",
      "an administrator correcting a mark on a handset still has no way through.");
  }

  // The phone writes marks locally before sending them. A refusal that leaves
  // that write behind is worse than the web case: the sheet shows a mark the
  // server rejected, flagged unsent, and nothing on the device retries it.
  const mobileService = require("fs").readFileSync(
    path.join(ROOT, "..", "mobile", "src", "services", "exam.service.js"), "utf8");
  if (/snapshotScores/.test(mobileService) && /restoreScores\(before/.test(mobileService)) {
    ok("and a refused save is rolled back on the device rather than left dirty");
  } else {
    bad("a refused save is rolled back on the device",
      "saveBulkScores writes locally first and only queues on an OFFLINE error, " +
      "so a 423 left the mark on the phone marked unsent with nothing to send it.");
  }

  await mongoose.model("ResultSummary").deleteOne({ _id: "sum-1" });

  // ── Attendance: the natural key is unique, so a re-mark is an update ──────
  console.log("\n--- the same pupil marked twice for the same day ---");

  const mark = (status, by) => Attendance.updateOne(
    { schoolId: S, classId: "cls-1", studentId: "st-1", subjectId: null, periodId: null, date: "2026-09-01" },
    { $set: { status, markedBy: by }, $setOnInsert: { _id: `at-${Date.now()}-${Math.random()}` } },
    { upsert: true }
  );
  await mark("absent",  "tea-1");
  await mark("present", "tea-2");

  const att = await Attendance.find({ studentId: "st-1", date: "2026-09-01" }).lean();
  if (att.length === 1) ok("one register entry survives, not two");
  else bad("one register entry survives", `${att.length} rows`);
  if (att[0]?.status === "present") ok("and it is the later mark");
  else bad("it is the later mark", JSON.stringify(att[0]?.status));

  // This one has no trace, and saying so is the point of the assertion.
  console.log("       (note: no equivalent of ResultChangeLog exists for attendance —");
  console.log("        the overwritten status is not recoverable. markedBy names who");
  console.log("        set the surviving value, which is the whole of the audit.)");

  // ── Money does not overwrite at all ───────────────────────────────────────
  console.log("\n--- money is append-only ---");

  const p1 = await post("bur-1", "bursar", "/api/fees/payments", {
    schoolId: S, studentId: "st-1", academicYear: YEAR, amount: 5000, method: "cash", _id: "pay-1",
  });
  if (p1.status < 400) ok(`a payment is recorded (${p1.status})`);
  else bad("a payment is recorded", `${p1.status} ${JSON.stringify(p1.body).slice(0, 160)}`);

  const rev = await post("bur-1", "bursar", "/api/fees/payments/pay-1/reverse", {
    schoolId: S, reason: "Entered against the wrong pupil",
  });
  if (rev.status < 400) ok(`a correction is accepted (${rev.status})`);
  else bad("a correction is accepted", `${rev.status} ${JSON.stringify(rev.body).slice(0, 160)}`);

  const original = await FeePayment.findById("pay-1").lean();
  if (original && original.amount === 5000) {
    ok("the original payment still exists, unedited — a correction appends, it does not overwrite");
  } else {
    bad("the original payment is preserved", JSON.stringify(original));
  }

  const all = await FeePayment.find({ studentId: "st-1" }).lean();
  if (all.length === 2) ok("the ledger holds both the payment and its reversal");
  else bad("the ledger holds both rows", `${all.length} row(s)`);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
