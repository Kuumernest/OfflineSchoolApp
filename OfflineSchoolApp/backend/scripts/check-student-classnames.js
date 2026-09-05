// backend/scripts/check-student-classnames.js
"use strict";

/**
 * A student's class name, on every route that names one.
 *
 * Three students on a seventy-one student roster showed as "Unassigned" on the
 * student page and the student detail page, and as Form 1 everywhere else.
 * Nothing was wrong with them: each held a valid classId. What differed was the
 * route. normaliseStudentDoc copies className off the record and stops there,
 * so a record enrolled without that string — three were, on the day they were
 * admitted — reads as unassigned on any route that trusts it. /students/approved
 * happened to resolve the id itself and so looked correct, which is what made
 * the fault look like a broken class assignment rather than a missing join.
 *
 * The rule these assertions hold to: the classId is the fact, the className is
 * a copy of it, and no route may answer with the copy when it disagrees with
 * the fact — or with nothing, when the fact is right there to look up.
 *
 *   node scripts/check-student-classnames.js
 */

const express  = require("express");
const mongoose = require("mongoose");


let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

(async () => {

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require("../src/db/models");
  const User    = mongoose.model("User");
  const Student = mongoose.model("Student");
  const Class   = mongoose.model("Class");

  const SCHOOL = "sch-1";

  await User.create({
    _id: "usr-admin", name: "An Admin", email: "admin@example.test",
    password: "check-only-password", role: "school_admin", schoolId: SCHOOL, isActive: true,
  });

  await Class.create({ _id: "cls-1", schoolId: SCHOOL, name: "Form 1", level: "Form 1" });
  await Class.create({ _id: "cls-2", schoolId: SCHOOL, name: "Form 2", level: "Form 2" });

  // The three real shapes on the roster.
  //
  //   bern    — a classId and no className at all. This is the one that read
  //             "Unassigned" while every class page listed her under Form 1.
  //   ada     — both, and they agree. Nothing to correct.
  //   kofi    — both, and they disagree: the copy still says Form 1 after a
  //             move to Form 2. The copy must lose.
  const mk = async (id, name, classId, className, status = "approved") => {
    await User.create({
      _id: `u-${id}`, name, email: `${id}@example.test`,
      password: "check-only-password", role: "student", schoolId: SCHOOL, isActive: true,
    });
    return Student.create({
      _id: id, userId: `u-${id}`, schoolId: SCHOOL, studentName: name, classId, className,
      enrollmentNo: `ENR-${id}`, status, isActive: true,
    });
  };

  await mk("stu-bern", "Bern Constance", "cls-1", undefined);
  await mk("stu-ada",  "Ada Nkeng",      "cls-1", "Form 1");
  await mk("stu-kofi", "Kofi Tabi",      "cls-2", "Form 1");
  await mk("stu-pend", "Pending Pupil",  "cls-1", undefined, "pending");

  // The real router behind the same stub check-admin-guards uses, stamping an
  // administrator on the request the way middleware/auth.js would.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      _id: "usr-admin", id: "usr-admin", role: "school_admin",
      schoolId: SCHOOL, email: "admin@example.test",
    };
    next();
  });
  app.use("/api/admin", require("../src/routes/admin.routes"));

  const server = app.listen(0);
  const port   = server.address().port;

  const get = async (path) => {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`http://127.0.0.1:${port}/api/admin${path}${sep}schoolId=${SCHOOL}`);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const rows = (body) => body?.data?.students ?? body?.students ?? body?.data?.data ?? body?.data ?? [];
  const find = (list, id) => (Array.isArray(list) ? list : []).find((s) => String(s._id ?? s.id) === id);

  // ── The page that was wrong ───────────────────────────────────────────────
  console.log("\n--- the student list ---");

  let r = await get("/students");
  if (r.status === 200) ok("the list answers");
  else bad("the list answers", `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

  let bern = find(rows(r.body), "stu-bern");
  if (bern?.className === "Form 1") ok("a student with a classId and no stored name is named by their class");
  else bad("a student with a classId and no stored name is named", JSON.stringify(bern?.className));

  let kofi = find(rows(r.body), "stu-kofi");
  if (kofi?.className === "Form 2") ok("a stale stored name loses to the class the id points at");
  else bad("a stale stored name loses to the id", JSON.stringify(kofi?.className));

  const ada = find(rows(r.body), "stu-ada");
  if (ada?.className === "Form 1") ok("a student whose stored name already agrees is unchanged");
  else bad("a student whose stored name agrees is unchanged", JSON.stringify(ada?.className));

  // ── The other page that was wrong ─────────────────────────────────────────
  console.log("\n--- the student detail page ---");

  r = await get("/students/stu-bern");
  const one = r.body?.data?.student ?? r.body?.student ?? null;
  if (one?.className === "Form 1") ok("the detail page names the class too");
  else bad("the detail page names the class", `${r.status} ${JSON.stringify(one?.className)}`);

  if (String(one?.classId) === "cls-1") ok("and still carries the id it resolved from");
  else bad("and still carries the id", JSON.stringify(one?.classId));

  // ── The pages that were right, and must stay right ────────────────────────
  console.log("\n--- the rosters that already worked ---");

  r = await get("/students/approved");
  bern = find(rows(r.body), "stu-bern");
  if (bern?.className === "Form 1") ok("the approved roster is unchanged by the shared helper");
  else bad("the approved roster is unchanged", `${r.status} ${JSON.stringify(bern?.className)}`);

  kofi = find(rows(r.body), "stu-kofi");
  if (kofi?.className === "Form 2") ok("and it, too, prefers the id over a stale copy");
  else bad("the approved roster prefers the id", JSON.stringify(kofi?.className));

  r = await get("/students/pending");
  const pend = find(rows(r.body), "stu-pend");
  if (pend?.className === "Form 1") ok("a pending applicant's chosen class is named");
  else bad("a pending applicant's class is named", `${r.status} ${JSON.stringify(pend?.className)}`);

  // ── Paging must not change the answer ─────────────────────────────────────
  console.log("\n--- paging ---");

  r = await get("/students?page=1&limit=2");
  const paged = rows(r.body);
  if (paged.length === 2) ok("a page holds the number of students asked for");
  else bad("a page holds the number asked for", JSON.stringify(paged.length));

  if (paged.every((s) => s.className)) ok("and every student on it is named");
  else bad("every student on a page is named",
    JSON.stringify(paged.map((s) => [s.studentName, s.className])));

  // ── Nothing to resolve from ───────────────────────────────────────────────
  console.log("\n--- a student who really has no class ---");

  await mk("stu-none", "No Class Yet", undefined, undefined);
  r = await get("/students");
  const none = find(rows(r.body), "stu-none");
  if (none && none.className === null) ok("a student with no classId is still reported unnamed, not invented");
  else bad("a student with no classId is reported unnamed", JSON.stringify(none?.className));

  // A classId pointing at a class that is gone must not resurrect as a name.
  await mk("stu-ghost", "Ghost Class", "cls-deleted", undefined);
  r = await get("/students");
  const ghost = find(rows(r.body), "stu-ghost");
  if (ghost && ghost.className === null) ok("a classId with no class behind it yields no name");
  else bad("a classId with no class behind it yields no name", JSON.stringify(ghost?.className));

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
