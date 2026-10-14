// backend/scripts/check-homework-scope.js
"use strict";

/**
 * A teacher sets homework for the subjects they teach, in the classes they
 * teach them, and for nothing else.
 *
 * The homework controller checked that a teacher's homework named the teacher
 * as its author, and stopped. It never asked whether the teacher taught that
 * subject to that class. The phone's pickers would not have offered the pair,
 * but the API would have taken it: Physics homework for Form 3A from the
 * teacher of Mathematics in 3A, addressed to a class of children who do not
 * take Physics from them. The author was also read from the body and merely
 * compared, which is a check a client can satisfy by copying.
 *
 * So this pins the rule at the API, with the same rows the pickers are built
 * from. TeacherAssignment is asked as a PAIR — class and subject together —
 * The author is the token.
 * A colleague cannot edit or delete another's homework; a teacher's list is
 * their own; a pupil's list, which the route lets through on identity, is
 * unchanged; and the school is always the token's, whatever the body says.
 *
 * Real routers, real door, in-memory database.
 *
 *   node scripts/check-homework-scope.js
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
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School            = mongoose.model("School");
  const User              = mongoose.model("User");
  const Class             = mongoose.model("Class");
  const Subject           = mongoose.model("Subject");
  const TeacherAssignment = mongoose.model("TeacherAssignment");
  const Homework          = mongoose.model("Homework");

  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test" },
  ]);

  const PASSWORD = "Check-only-passw0rd";
  const mkUser = (id, role, schoolId, extra = {}) => User.create({
    _id: id, name: id, email: `${id}@example.test`, password: PASSWORD, role, schoolId, isActive: true, ...extra,
  });
  await Promise.all([
    mkUser("maths-a",   "teacher",      A),   // Mathematics in 3A, Physics in 4B
    mkUser("english-a", "teacher",      A),   // English in 3A
    mkUser("teacher-b", "teacher",      B),
    mkUser("admin-a",   "school_admin", A),
    mkUser("bursar-a",  "bursar",       A),
    mkUser("pupil-a",   "student",      A, { enrollmentNo: "A-0001" }),
  ]);

  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await Subject.create([
    { _id: "maths-3a",   schoolId: A, name: "Mathematics", classId: "form3a" },
    { _id: "physics-3a", schoolId: A, name: "Physics",     classId: "form3a" },
    { _id: "english-3a", schoolId: A, name: "English",     classId: "form3a" },
    { _id: "maths-4b",   schoolId: A, name: "Mathematics", classId: "form4b" },
    { _id: "physics-4b", schoolId: A, name: "Physics",     classId: "form4b" },
    { _id: "maths-1b",   schoolId: B, name: "Mathematics", classId: "form1b" },
  ]);
  await TeacherAssignment.create([
    { schoolId: A, teacher: "maths-a",   class: "form3a", subject: "maths-3a" },
    { schoolId: A, teacher: "maths-a",   class: "form4b", subject: "physics-4b" },
    { schoolId: A, teacher: "english-a", class: "form3a", subject: "english-3a" },
    { schoolId: B, teacher: "teacher-b", class: "form1b", subject: "maths-1b" },
  ]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/homework", auth.authenticate, require(path.join(SRC, "routes/homework.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, url, { token, body, headers = {} } = {}) => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };
  const sign = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const as = (id, role, schoolId) => {
    const token = sign(id, role, schoolId);
    return {
      get:    (url)             => call("GET",    url, { token }),
      post:   (url, body)       => call("POST",   url, { token, body }),
      put:    (url, body, h)    => call("PUT",    url, { token, body, headers: h }),
      delete: (url)             => call("DELETE", url, { token }),
    };
  };
  const maths   = as("maths-a",   "teacher",      A);
  const english = as("english-a", "teacher",      A);
  const beta    = as("teacher-b", "teacher",      B);
  const admin   = as("admin-a",   "school_admin", A);
  const bursar  = as("bursar-a",  "bursar",       A);
  const pupil   = as("pupil-a",   "student",      A);

  const hw = (over = {}) => ({ title: "Exercises 1–10", classId: "form3a", subjectId: "maths-3a", isPublished: true, ...over });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the pair a teacher teaches ---");

  const mine = await maths.post("/homework", hw({ createdBy: "english-a" }));
  check("Mathematics for 3A, from its Mathematics teacher", mine.status, 201);
  check("   the author is the token, whatever the body said", mine.body.homework?.createdBy, "maths-a");
  check("   and the school is the token's", mine.body.homework?.schoolId, A);
  const mineId = mine.body.homework?._id;
  // Naming another school in the body never reaches the controller: the door
  // in middleware/auth.js refuses a school-scoped caller first.
  const door = await maths.post("/homework", hw({ schoolId: B }));
  check("   naming another school in the body is refused at the door", [door.status, door.body.code], [403, "SCHOOL_ACCESS_DENIED"]);

  const also = await maths.post("/homework", hw({ classId: "form4b", subjectId: "physics-4b", title: "Optics" }));
  check("Physics for 4B, which the same teacher also teaches", also.status, 201);

  const wrongSubject = await maths.post("/homework", hw({ subjectId: "physics-3a" }));
  check("Physics for 3A — they teach Physics, but not to 3A", [wrongSubject.status, wrongSubject.body.code], [403, "NOT_ASSIGNED"]);
  const wrongClass = await maths.post("/homework", hw({ classId: "form4b", subjectId: "maths-4b" }));
  check("Mathematics for 4B — they teach 4B, but not Mathematics", [wrongClass.status, wrongClass.body.code], [403, "NOT_ASSIGNED"]);
  const someoneElses = await english.post("/homework", hw());
  check("Mathematics for 3A from the English teacher", [someoneElses.status, someoneElses.body.code], [403, "NOT_ASSIGNED"]);
  check("   none of the refusals left a row", await Homework.countDocuments({ deletedAt: null }), 2);

  // Assignment rows switched off no longer count.
  await TeacherAssignment.updateOne({ teacher: "english-a", class: "form3a", subject: "english-3a" }, { $set: { isActive: false } });
  const inactive = await english.post("/homework", hw({ subjectId: "english-3a", title: "Essay" }));
  check("an assignment that has been switched off does not count", [inactive.status, inactive.body.code], [403, "NOT_ASSIGNED"]);
  await TeacherAssignment.updateOne({ teacher: "english-a", class: "form3a", subject: "english-3a" }, { $set: { isActive: true } });
  check("   and counts again once it is back on", (await english.post("/homework", hw({ subjectId: "english-3a", title: "Essay" }))).status, 201);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- across schools ---");

  const cross = await beta.post("/homework", hw({ schoolId: A }));
  check("a teacher in School B naming School A is refused — the pair is not theirs", cross.status, 403);
  const crossOwn = await beta.post("/homework", hw({ classId: "form1b", subjectId: "maths-1b" }));
  check("   and their own pair in their own school is accepted", [crossOwn.status, crossOwn.body.homework?.schoolId], [201, B]);
  const betaList = await beta.get("/homework");
  check("   School B's teacher lists School B's homework only",
    (betaList.body.homework ?? []).map((h) => h.schoolId), [B]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- who sees what ---");

  const mathsList = await maths.get("/homework");
  check("a teacher lists the homework they set", (mathsList.body.homework ?? []).map((h) => h.title).sort(), ["Exercises 1–10", "Optics"]);
  check("   and not a colleague's", (mathsList.body.homework ?? []).some((h) => h.createdBy !== "maths-a"), false);
  const adminList = await admin.get("/homework");
  check("the school's admin lists all of the school's", (adminList.body.homework ?? []).map((h) => h.title).sort(), ["Essay", "Exercises 1–10", "Optics"]);
  const pupilList = await pupil.get("/homework");
  check("a pupil still lists their school's homework, on identity", [pupilList.status, (pupilList.body.homework ?? []).length], [200, 3]);
  check("a bursar may not set homework", (await bursar.post("/homework", hw())).status, 403);
  check("no token is a 401", (await call("POST", "/homework", { body: hw() })).status, 401);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- editing and deleting ---");

  const edit = await maths.put(`/homework/${mineId}`, hw({ title: "Exercises 1–20", schoolId: A, createdBy: "maths-a" }));
  check("the author edits their homework", [edit.status, edit.body.homework?.title, edit.body.homework?.version], [201, "Exercises 1–20", 2]);
  const editByOther = await english.put(`/homework/${mineId}`, hw({ title: "Hijacked" }));
  check("a colleague may not — even for a pair they teach, the row is not theirs", editByOther.status, 403);
  const moved = await maths.put(`/homework/${mineId}`, hw({ subjectId: "physics-3a", title: "Moved" }));
  check("an edit cannot move homework onto a pair the author does not teach", [moved.status, moved.body.code], [403, "NOT_ASSIGNED"]);
  check("   and the row is as it was", (await Homework.findById(mineId).lean()).title, "Exercises 1–20");
  const stale = await maths.put(`/homework/${mineId}`, hw({ title: "Stale" }), { "If-Match": "1" });
  check("a stale version is a 412, as before", stale.status, 412);

  check("a colleague may not delete it", (await english.delete(`/homework/${mineId}`)).status, 403);
  const gone = await maths.delete(`/homework/${mineId}`);
  check("the author deletes it", [gone.status, Boolean(gone.body.homework?.deletedAt)], [200, true]);
  check("   and it leaves their list", (await maths.get("/homework")).body.homework.map((h) => h.title), ["Optics"]);
  check("   an admin's edit on behalf keeps the author it names",
    (await admin.put(`/homework/${also.body.homework._id}`, hw({ classId: "form4b", subjectId: "physics-4b", title: "Optics II", createdBy: "maths-a" }))).body.homework?.createdBy, "maths-a");

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error("\n  check-homework-scope crashed:", err);
  process.exit(1);
});
