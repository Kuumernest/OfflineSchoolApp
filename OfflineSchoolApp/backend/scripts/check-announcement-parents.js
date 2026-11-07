// backend/scripts/check-announcement-parents.js
"use strict";

/**
 * "Parents" as an announcement audience, end to end.
 *
 * The model already had it — Announcement.audience accepts "parents", POST
 * expands it to audiences:["parents"], and the guardian portal reads notices
 * through audienceMatch({ audience: "parents" }) — but the web composer never
 * offered it, and editing a notice's audience (PUT) changed `audience` while
 * leaving the `audiences` set that readers actually match on. An Everyone
 * notice edited to Parents kept reaching every pupil and teacher.
 *
 * One guardian, two children in different classes (siblings are normal data):
 * the parent sees a Parents notice once; pupils and teachers do not.
 *
 *   node scripts/check-announcement-parents.js
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
  const M = (n) => mongoose.model(n);
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));

  const S    = "68f1000000000000000000c1";
  const HASH = "$2a$10$check.only.not.a.real.hash.value.padding.padding.pad";
  await M("School").create({ _id: S, name: "Parents Academy", email: "pa@example.test" });
  const mk = (id, role) => M("User").create({ _id: id, name: id, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId: S, isActive: true });
  await Promise.all([mk("admin", "school_admin"), mk("teacher", "teacher"), mk("u-pupil", "student")]);
  await M("Class").create([{ _id: "f1", schoolId: S, name: "Form 1" }, { _id: "f3", schoolId: S, name: "Form 3" }]);
  const pupil = (id, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId: S, classId, studentName: `Pupil ${n}`, enrollmentNo: `PA-${n}`,
    isActive: true, status: "approved", guardianName: "Mrs Ngo", guardianEmail: "ngo@example.test",
  });
  await M("Student").create([pupil("pupil", "f1", 1), pupil("sib", "f3", 2)]);
  await M("GuardianAccess").create({ _id: "acc-ngo", schoolId: S, studentIds: ["pupil", "sib"], codeHash: HASH, codeHint: "42" });

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const ann  = require(path.join(SRC, "routes/announcement.routes"));
  const app  = express();
  app.use(express.json());
  app.get("/api/students/announcements", auth.authenticate, ann.handleStudentAnnouncements);
  app.use("/api/announcements", auth.authenticate, ann);
  app.use("/api/portal", require(path.join(SRC, "routes/portal.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (token, method, url, body) => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };
  const staff = (id, role) => jwt.sign({ id, role, schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const ADMIN = staff("admin", "school_admin"), TEACHER = staff("teacher", "teacher");
  const PUPIL = jwt.sign({ id: "u-pupil", role: "student", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const PARENT = jwt.sign({ accessId: "acc-ngo", schoolId: S }, process.env.JWT_SECRET, { audience: "portal", expiresIn: "1h" });

  const titles = (rows) => (rows ?? []).map((a) => a.title).sort();
  const parentSees  = async () => titles((await call(PARENT,  "GET", "/portal/announcements")).body?.data);
  const pupilSees   = async () => titles((await call(PUPIL,   "GET", "/students/announcements?classId=f1")).body?.data);
  const teacherSees = async () => titles((await call(TEACHER, "GET", "/announcements")).body?.data);

  console.log("\n--- an administrator writes to the parents ---");
  let r = await call(ADMIN, "POST", "/announcements", { title: "Parents meeting", body: "Friday 4pm", audience: "parents" });
  check("POST audience:parents → 201", r.status, 201);
  const stored = await M("Announcement").findById(r.body?.data?._id).lean();
  check("stored as audience parents, audiences [parents]", [stored?.audience, stored?.audiences], ["parents", ["parents"]]);
  check("the parent of two sees it once", await parentSees(), ["Parents meeting"]);
  check("a pupil does not", await pupilSees(), []);
  check("a teacher does not", await teacherSees(), []);

  console.log("\n--- an Everyone notice edited to Parents ---");
  r = await call(ADMIN, "POST", "/announcements", { title: "Uniform", body: "New supplier", audience: "all" });
  const uniform = r.body?.data?._id;
  check("before the edit a pupil sees it", (await pupilSees()).includes("Uniform"), true);
  r = await call(ADMIN, "PUT", `/announcements/${uniform}`, { audience: "parents" });
  check("PUT audience:parents → 200", r.status, 200);
  const edited = await M("Announcement").findById(uniform).lean();
  check("audiences follow the audience", [edited?.audience, edited?.audiences], ["parents", ["parents"]]);
  check("the pupil no longer sees it", (await pupilSees()).includes("Uniform"), false);
  check("the teacher no longer sees it", (await teacherSees()).includes("Uniform"), false);
  check("the parent still does", (await parentSees()).includes("Uniform"), true);

  console.log("\n--- a class notice edited to Parents drops its classes ---");
  r = await call(ADMIN, "POST", "/announcements", { title: "Form 3 trip", body: "Zoo", audience: "class", targetClasses: ["f3"] });
  const trip = r.body?.data?._id;
  r = await call(ADMIN, "PUT", `/announcements/${trip}`, { audience: "parents" });
  const moved = await M("Announcement").findById(trip).lean();
  check("targetClasses cleared, audiences [parents]", [r.status, moved?.targetClasses, moved?.audiences], [200, [], ["parents"]]);

  console.log("\n--- what PUT refuses ---");
  r = await call(ADMIN, "PUT", `/announcements/${trip}`, { audience: "everybody" });
  check("an unknown audience → 400", r.status, 400);
  r = await call(ADMIN, "PUT", `/announcements/${trip}`, { audience: "class" });
  check("class with no classes → 400", r.status, 400);
  check("and the row is unchanged", (await M("Announcement").findById(trip).lean())?.audience, "parents");

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
