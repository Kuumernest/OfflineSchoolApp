// backend/scripts/check-feed-tombstones.js
"use strict";

/**
 * Hard deletes reach the desktop: GET /sync/changes carries syncTombstone.
 *
 * Subjects, teacher assignments and pupils are hard-deleted, so the desktop's
 * mirror (which reads rows by updatedAt) never heard of their deletion and
 * kept them for good. Their tombstones (models/SyncTombstone.js) are now a
 * feed collection, scoped to what each caller may mirror, paged like every
 * other collection; a tombstone whose row still exists is not sent.
 *
 * Also pins the controller fix this needed: a scope's own $or is no longer
 * overwritten by the cursor's (which would have sent every row past the
 * cursor, scope ignored).
 *
 *   node scripts/check-feed-tombstones.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");

(async () => {
  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-long-enough-for-validation";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(ROOT, "src/db/models"));
  const M = (n) => mongoose.model(n);
  await M("SyncTombstone").createIndexes();

  const A = "school-a", B = "school-b";
  const user = (id, role, schoolId) => M("User").create({ _id: id, name: id, email: `${id}@example.test`,
    password: "check-only-password", role, schoolId, isActive: true });
  await user("adm", "school_admin", A); await user("tea", "teacher", A); await user("bur", "bursar", A);
  await user("pup", "student", A); await user("adm-b", "school_admin", B);
  await M("Class").create({ _id: "c1", schoolId: A, name: "Form 1" });
  await M("Class").create({ _id: "c2", schoolId: A, name: "Form 2" });
  await M("Subject").create({ _id: "s1", schoolId: A, name: "Music", classId: "c1" });
  await M("Subject").create({ _id: "s2", schoolId: A, name: "Maths", classId: "c1" });
  await M("Subject").create({ _id: "sb", schoolId: B, name: "B Maths", classId: "cb" });
  // The teacher teaches Form 1 only.
  await M("TeacherAssignment").create({ _id: "as-keep", schoolId: A, teacher: "tea", class: "c1", subject: "s2" });
  await M("TeacherAssignment").create({ _id: "as-go", schoolId: A, teacher: "adm", class: "c2", subject: "s2" });
  const pupil = (id, schoolId, classId) => M("Student").create({ _id: id, userId: `u-${id}`, schoolId, classId,
    studentName: id, enrollmentNo: `EN-${id}`, status: "approved", isActive: true });
  await pupil("p1", A, "c1"); await pupil("p2", A, "c2"); await pupil("pb", B, "cb");

  // ── the deletions ─────────────────────────────────────────────────────────
  await M("Subject").deleteOne({ _id: "s1" });
  await M("TeacherAssignment").deleteOne({ _id: "as-go" });
  await M("Student").deleteOne({ _id: "p1" });   // Form 1 — the teacher's
  await M("Student").deleteOne({ _id: "p2" });   // Form 2 — not the teacher's
  await M("Subject").deleteOne({ _id: "sb" });   // another school
  check("the tombstone keeps the deleted pupil's class",
    (await M("SyncTombstone").findOne({ docId: "p1" }).lean())?.classId, "c1");

  const auth = require(path.join(ROOT, "middleware/auth"));
  const app = express(); app.use(express.json());
  app.use("/api/sync", auth.authenticate, require(path.join(ROOT, "src/routes/sync.routes")));
  const server = app.listen(0);
  const port = server.address().port;
  const tok = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET);
  const T = { adm: tok("adm", "school_admin", A), tea: tok("tea", "teacher", A), bur: tok("bur", "bursar", A),
    pup: tok("pup", "student", A), admB: tok("adm-b", "school_admin", B) };
  const feed = async (who, params = {}) => {
    const qs = new URLSearchParams({ collections: "syncTombstone", ...params });
    const r = await fetch(`http://127.0.0.1:${port}/api/sync/changes?${qs}`, { headers: { Authorization: `Bearer ${T[who]}` } });
    return { status: r.status, body: await r.json() };
  };
  const names = (r) => (r.body.collections?.syncTombstone?.documents || []).map((t) => `${t.entity}:${t.docId}`).sort();

  console.log("--- who hears of which deletion ---");
  check("an admin: every deletion in the school (subject, assignment, both pupils), none from elsewhere",
    names(await feed("adm")), ["student:p1", "student:p2", "subject:s1", "teacherAssignment:as-go"]);
  check("a teacher (taught classes only): the pupil of Form 1, not Form 2; no subjects (it mirrors none)",
    names(await feed("tea")), ["student:p1"]);
  check("a bursar (students.view, no subjects.view): both pupils, no subject or assignment",
    names(await feed("bur")), ["student:p1", "student:p2"]);
  let r = await feed("pup");
  check("a student: refused by name, not sent an empty list",
    [r.body.collections?.syncTombstone, (r.body.refused || []).some((x) => x.collection === "syncTombstone" && x.reason === "FORBIDDEN")],
    [undefined, true]);
  check("the other school's admin: only its own", names(await feed("admB")), ["subject:sb"]);

  console.log("--- paging and the cursor ---");
  // A tombstone whose row is alive (a failed delete): never sent, but passed.
  await M("SyncTombstone").create({ entity: "subject", docId: "s2", schoolId: A });
  const seen = [];
  let cursor = null, pages = 0, more = true;
  while (more && pages < 20) {
    const page = await feed("adm", { limit: "1", ...(cursor ? { cursors: JSON.stringify({ syncTombstone: cursor }) } : {}) });
    const slice = page.body.collections.syncTombstone;
    seen.push(...slice.documents.map((t) => `${t.entity}:${t.docId}`));
    more = slice.hasMore; cursor = slice.cursor; pages++;
  }
  check("one tombstone a page: every deletion delivered once, the live row's tombstone skipped, and the walk ends",
    [seen.sort(), pages], [["student:p1", "student:p2", "subject:s1", "teacherAssignment:as-go"], 5]);

  // The teacher with a cursor: the scope must survive the cursor's own $or.
  r = await feed("tea", { limit: "1" });
  const teaCursor = r.body.collections.syncTombstone.cursor;
  await M("Student").deleteOne({ _id: (await pupil("p3", A, "c2"))._id });   // Form 2, after the cursor
  await M("Student").deleteOne({ _id: (await pupil("p4", A, "c1"))._id });   // Form 1, after the cursor
  r = await feed("tea", { cursors: JSON.stringify({ syncTombstone: teaCursor }) });
  check("a teacher reading on from a cursor still hears only of its classes (scope and cursor both apply)",
    names(r), ["student:p4"]);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
