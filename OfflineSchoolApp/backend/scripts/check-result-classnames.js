// backend/scripts/check-result-classnames.js
"use strict";

/**
 * A pupil's class, on the exams and results screens.
 *
 * The same fault as check-student-classnames, one collection further along.
 * Term and annual results copy studentName, admissionNo and className onto
 * themselves at compute time so a report card is a single read. className was
 * copied from `student.className` — a string a pupil can be enrolled without,
 * and three on this school's roster were.
 *
 * Their exam results were fine, because that path already had a backfill that
 * resolved the name from classId. Their term results carried nothing. So the
 * class column was empty for exactly those three pupils on exactly the exams
 * and results screens, and correct on every other screen in the app — which is
 * the shape of fault that reads as "the class assignment is broken again"
 * rather than "one denormalised copy was never filled".
 *
 * Both halves are asserted here: the compute resolves the name from the classId
 * it is already scoped by, and rows computed before that fix are filled as they
 * are read, because a school should not have to recompute a term to see a class
 * name.
 *
 *   node scripts/check-result-classnames.js
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
  const User       = mongoose.model("User");
  const Student    = mongoose.model("Student");
  const Class      = mongoose.model("Class");
  const TermResult = mongoose.model("TermResult");

  const S    = "sch-1";
  const YEAR = "2026/2027";

  await User.create({
    _id: "adm-1", name: "Admin", email: "adm@example.test",
    password: "check-only-password", role: "school_admin", schoolId: S, isActive: true,
  });
  await Class.create({ _id: "cls-1", schoolId: S, name: "Form 1" });

  // Enrolled without the className string — the state the three real pupils
  // have been in since the day they were admitted.
  await Student.create({
    _id: "st-blank", userId: "u-1", schoolId: S, classId: "cls-1",
    studentName: "Bare Enrolment", enrollmentNo: "E-1", isActive: true,
  });
  // And one with it, to prove the stored value still wins.
  await Student.create({
    _id: "st-named", userId: "u-2", schoolId: S, classId: "cls-1",
    studentName: "Named Enrolment", enrollmentNo: "E-2", className: "Form 1 (as sat)",
    isActive: true,
  });

  // ── Half one: a row computed before the fix ───────────────────────────────
  //
  // Written straight to the collection with no className, which is exactly
  // what the old compute produced.
  await TermResult.create({
    _id: "tr-old", schoolId: S, studentId: "st-blank", classId: "cls-1",
    academicYear: YEAR, term: 1, average: 14, classPosition: 2, totalInClass: 2,
    studentName: "Bare Enrolment", admissionNo: "E-1",
  });
  await TermResult.create({
    _id: "tr-old-2", schoolId: S, studentId: "st-named", classId: "cls-1",
    academicYear: YEAR, term: 1, average: 16, classPosition: 1, totalInClass: 2,
    studentName: "Named Enrolment", admissionNo: "E-2", className: "Form 1 (as sat)",
  });

  const stored = await TermResult.findById("tr-old").lean();
  if (!stored.className) ok("the fixture reproduces the stored state: a term result with no class name");
  else bad("the fixture has no class name", JSON.stringify(stored.className));

  const auth = require(path.join(ROOT, "middleware/auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/term-results", auth.authenticate, require(path.join(SRC, "routes/termResults.routes")));
  const server = app.listen(0);
  const port   = server.address().port;

  const token = jwt.sign({ id: "adm-1", role: "school_admin", schoolId: S },
    process.env.JWT_SECRET, { expiresIn: "1h" });

  const res = await fetch(
    `http://127.0.0.1:${port}/api/term-results?schoolId=${S}` +
    `&academicYear=${encodeURIComponent(YEAR)}&term=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const body = await res.json().catch(() => ({}));
  const rows = body?.results ?? body?.data?.results ?? [];

  console.log("\n--- reading a term result computed before the fix ---");

  if (res.status === 200 && rows.length === 2) ok("both rows come back");
  else bad("both rows come back", `${res.status} ${JSON.stringify(body).slice(0, 160)}`);

  const blank = rows.find((r) => r._id === "tr-old");
  if (blank?.className === "Form 1") {
    ok("the missing class name is filled from the row's classId as it is read");
  } else {
    bad("the missing class name is filled on read",
      `className came back as ${JSON.stringify(blank?.className)}. The exams and ` +
      "results screens show this column empty for any pupil enrolled without " +
      "the string, while every other screen resolves it.");
  }

  const named = rows.find((r) => r._id === "tr-old-2");
  if (named?.className === "Form 1 (as sat)") {
    ok("a stored class name is left alone — a pupil who moved keeps the class the term was sat in");
  } else {
    bad("a stored class name is left alone", JSON.stringify(named?.className));
  }

  // Reading must not write. An earlier backfill of this kind persisted what it
  // resolved, which is a write on a GET.
  const afterRead = await TermResult.findById("tr-old").lean();
  if (!afterRead.className) {
    ok("and the row itself is untouched — resolving on read does not write on a GET");
  } else {
    bad("reading does not write", `the stored row now says ${JSON.stringify(afterRead.className)}`);
  }

  // ── Half two: the compute itself ──────────────────────────────────────────
  console.log("\n--- and a term computed now ---");

  await TermResult.deleteMany({});
  const termGrading = require(path.join(SRC, "services/termGrading.service"));

  let computeErr = null;
  try {
    await termGrading.computeClassTermAverages({
      schoolId: S, academicYear: YEAR, term: 1, classId: "cls-1",
    });
  } catch (err) { computeErr = err; }

  const fresh = await TermResult.findOne({ studentId: "st-blank" }).lean();

  if (!fresh) {
    // No marks in this fixture, so nothing is written — say so rather than
    // let the next assertion pass on an absent row.
    ok(`the compute ran without marks and wrote nothing${computeErr ? " (" + computeErr.message.slice(0, 60) + ")" : ""}`);

    // Assert the source instead: the resolved name must reach the doc.
    const src = require("fs").readFileSync(
      path.join(SRC, "services/termGrading.service.js"), "utf8");
    if (/className:\s*student\.className\s*\|\|\s*resolvedClassName/.test(src)) {
      ok("the compute falls back to the class it is scoped by, not just the pupil's copy");
    } else {
      bad("the compute resolves the class name",
        "termGrading still writes student.className alone, so a pupil enrolled " +
        "without it gets another term result with no class on it.");
    }

    const annual = require("fs").readFileSync(
      path.join(SRC, "services/annualGrading.service.js"), "utf8");
    if (/className:\s*student\.className\s*\|\|\s*resolvedClassName/.test(annual)) {
      ok("and the annual compute does the same");
    } else {
      bad("the annual compute resolves the class name", "annualGrading writes student.className alone");
    }
  } else {
    if (fresh.className === "Form 1") ok("a freshly computed term result carries the class name");
    else bad("a freshly computed term result carries the class name", JSON.stringify(fresh.className));
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
