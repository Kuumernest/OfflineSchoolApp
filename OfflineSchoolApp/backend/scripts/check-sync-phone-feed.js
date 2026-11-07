// backend/scripts/check-sync-phone-feed.js
"use strict";

/**
 * The phone's six collections through GET /sync/changes?profile=phone.
 *
 * The phone moved off GET /sync/pull (one timestamp, one unbounded answer) onto
 * the keyset feed. What must not move with it is the AUDIENCE: each phone role
 * gets exactly what /sync/pull gave it, in the same row shapes —
 *
 *   - admin, bursar, teacher: classes, subjects, periods, teachers (with email
 *     and staff number), assignments (teacher/class/subject names joined), the
 *     pupil roster (normalised; off the roster → a removal) — a teacher's
 *     narrowed to the classes they teach (check-teacher-phone-roster.js) —
 *     hard deletes;
 *   - a STUDENT: their own pupil row only, teacher NAMES only (no email, no
 *     account state — in `teachers` and in each assignment's teacher), and
 *     only their own pupil tombstone;
 *   - nobody: another school's rows.
 *
 * Plus: compared row-for-row with /sync/pull for every role; paged exactly
 * once; the desktop's default answer is unchanged (no phone collections, the
 * teacher's KNOWN_GAPS still refused); a staff role without any pupil
 * capability is refused pupils by name.
 *
 *   node scripts/check-sync-phone-feed.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-long-enough-for-validation";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "sync-phone-feed" });
  require(path.join(ROOT, "src/db/models"));
  const M = (n) => mongoose.model(n);
  await M("SyncTombstone").createIndexes();

  const A = "5c0e2e0000000000000000c1", B = "5c0e2e0000000000000000c2";
  const user = (id, role, schoolId, extra = {}) => M("User").create({ _id: id, name: `Name ${id}`, email: `${id}@example.test`,
    password: "check-only-password", role, schoolId, isActive: true, ...extra });
  await user("adm", "school_admin", A); await user("bur", "bursar", A);
  await user("tea", "teacher", A, { staffNo: "A-STF-001" }); await user("tea2", "teacher", A);
  await user("pup", "student", A); await user("adm-b", "school_admin", B); await user("tea-b", "teacher", B);
  await M("Class").create({ _id: "c1", schoolId: A, name: "Form 1" });
  await M("Class").create({ _id: "c2", schoolId: A, name: "Form 2" });
  await M("Class").create({ _id: "cb", schoolId: B, name: "B Form" });
  await M("Subject").create({ _id: "s1", schoolId: A, name: "Maths", classId: "c1" });
  await M("Subject").create({ _id: "s2", schoolId: A, name: "Music", classId: "c2" });
  await M("Subject").create({ _id: "sb", schoolId: B, name: "B Maths", classId: "cb" });
  await M("Period").create({ _id: "pe1", schoolId: A, name: "P1", startTime: "08:00", endTime: "08:40" });
  await M("Period").create({ _id: "peb", schoolId: B, name: "PB", startTime: "08:00", endTime: "08:40" });
  await M("TeacherAssignment").create({ _id: "as1", schoolId: A, teacher: "tea", class: "c1", subject: "s1" });
  await M("TeacherAssignment").create({ _id: "as2", schoolId: A, teacher: "tea2", class: "c2", subject: "s2" });
  await M("TeacherAssignment").create({ _id: "asb", schoolId: B, teacher: "tea-b", class: "cb", subject: "sb" });
  const pupil = (id, schoolId, classId, extra = {}) => M("Student").create({ _id: id, userId: `u-${id}`, schoolId, classId,
    studentName: `Pupil ${id}`, enrollmentNo: `EN-${id}`, status: "approved", isActive: true,
    guardianName: "Mrs Mensah", guardianPhone: "+233200000000", ...extra });
  await pupil("p-own", A, "c1", { userId: "pup" });
  // Siblings: one guardian, same phone (CLAUDE.md) — both are on the roster.
  await pupil("p-sib1", A, "c1"); await pupil("p-sib2", A, "c2");
  await pupil("p-pending", A, "c1", { status: "pending" });
  await pupil("p-b", B, "cb");

  const auth = require(path.join(ROOT, "middleware/auth"));
  const app = express(); app.use(express.json());
  app.use("/api/sync", auth.authenticate, require(path.join(ROOT, "src/routes/sync.routes")));
  const server = app.listen(0);
  const port = server.address().port;
  const tok = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET);
  const T = { adm: tok("adm", "school_admin", A), bur: tok("bur", "bursar", A), tea: tok("tea", "teacher", A),
    pup: tok("pup", "student", A), admB: tok("adm-b", "school_admin", B) };
  const http = async (who, p) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sync${p}`, { headers: { Authorization: `Bearer ${T[who]}` } });
    return { status: r.status, body: await r.json() };
  };
  /** A full phone pass: every collection paged to exhaustion. */
  const phonePass = async (who, { limit = 500, cursors = {} } = {}) => {
    const got = {}; const cur = { ...cursors }; let refused = [];
    let pending = null;   // after the first page: only the collections with more
    for (let i = 0; i < 50; i++) {
      const qs = new URLSearchParams({ profile: "phone", limit: String(limit) });
      if (pending) qs.set("collections", pending.join(","));
      if (Object.keys(cur).length) qs.set("cursors", JSON.stringify(cur));
      const r = await http(who, `/changes?${qs}`);
      if (r.status !== 200) return { error: r.status, got: {} };
      refused = r.body.refused;
      pending = [];
      for (const [name, slice] of Object.entries(r.body.collections)) {
        (got[name] ??= []).push(...slice.documents);
        if (slice.cursor) cur[name] = slice.cursor;
        if (slice.hasMore) pending.push(name);
      }
      if (!pending.length) break;
    }
    return { got, cursors: cur, refused };
  };
  const ids = (rows) => (rows ?? []).map((r) => String(r._id)).sort();
  const live = (rows) => ids((rows ?? []).filter((r) => !r.deletedAt));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 1. what each phone role receives ---");
  const adm = await phonePass("adm");
  check("admin: the six collections and tombstones", Object.keys(adm.got).sort(),
    ["assignments", "classes", "periods", "students", "subjects", "teachers", "tombstones"]);
  check("admin: own school's classes only", ids(adm.got.classes), ["c1", "c2"]);
  check("admin: the roster, siblings both present; pending → a removal row", [live(adm.got.students), ids(adm.got.students)],
    [["p-own", "p-sib1", "p-sib2"], ["p-own", "p-pending", "p-sib1", "p-sib2"]]);
  const sib = adm.got.students.find((s) => s._id === "p-sib1");
  check("a pupil row in /sync/pull's shape (name, guardian, enrollment)", [sib.name, sib.guardianPhone, sib.enrollmentNo, sib.classId],
    ["Pupil p-sib1", "+233200000000", "EN-P-SIB1", "c1"]);
  const asg = adm.got.assignments.find((a) => a._id === "as1");
  check("an assignment carries the joined names (teacher with email)", [asg.teacher?.name, asg.teacher?.email, asg.class?.name, asg.subject?.name],
    ["Name tea", "tea@example.test", "Form 1", "Maths"]);
  const t = adm.got.teachers.find((x) => x._id === "tea");
  check("staff: a teacher row with email and staff number, no password", [t.email, t.staffNo, "password" in t], ["tea@example.test", "A-STF-001", false]);
  check("staff: only teachers in `teachers`", ids(adm.got.teachers), ["tea", "tea2"]);

  for (const who of ["bur", "tea"]) {
    const p = await phonePass(who);
    // A teacher's pupils are those of the classes they teach (Form 1 here) —
    // owner decision 2026-11, proved in full by check-teacher-phone-roster.js.
    const pupils = who === "tea" ? ["p-own", "p-sib1"] : live(adm.got.students);
    check(`${who}: the same collections and rows as the admin (a teacher: their classes' pupils)`, [Object.keys(p.got).sort(), live(p.got.students), ids(p.got.classes), ids(p.got.assignments)],
      [Object.keys(adm.got).sort(), pupils, ids(adm.got.classes), ids(adm.got.assignments)]);
  }

  console.log("--- 2. a student is narrowed as /sync/pull narrows them ---");
  const pup = await phonePass("pup");
  check("their own pupil row and nobody else's", ids(pup.got.students), ["p-own"]);
  check("teacher names, no email or account state",
    pup.got.teachers.map((x) => Object.keys(x).filter((k) => ["email", "isActive", "mustResetPassword", "staffNo"].includes(k))).flat(), []);
  check("  and the names are there", pup.got.teachers.map((x) => x.name).sort(), ["Name tea", "Name tea2"]);
  check("assignments' joined teacher: name only", pup.got.assignments.map((a) => a.teacher?.email ?? null), [null, null]);

  console.log("--- 3. the same rows as /sync/pull, role by role ---");
  for (const who of ["adm", "bur", "tea", "pup"]) {
    const pull = (await http(who, `/pull?schoolId=${A}`)).body.data;
    const feed = who === "adm" ? adm : who === "pup" ? pup : await phonePass(who);
    const same = ["classes", "teachers", "subjects", "periods", "assignments", "students"]
      .every((c) => JSON.stringify(live(pull[c])) === JSON.stringify(live(feed.got[c])));
    check(`${who}: every collection's live rows match /sync/pull`, same, true);
  }

  console.log("--- 4. deletions ---");
  await M("Subject").deleteOne({ _id: "s2" });
  await M("Student").deleteOne({ _id: "p-sib2" });
  await M("Class").updateOne({ _id: "c2" }, { $set: { deletedAt: new Date() } });
  const adm2 = await phonePass("adm", { cursors: adm.cursors });
  const stones = (adm2.got.tombstones ?? []).map((x) => `${x.collection}:${x._id}`).sort();
  check("hard deletes arrive as removal rows of their collection", stones.includes("subjects:s2") && stones.includes("students:p-sib2"), true);
  check("a soft delete arrives in-row", adm2.got.classes.some((c) => c._id === "c2" && c.deletedAt), true);
  const pup2 = await phonePass("pup", { cursors: pup.cursors });
  check("a student does not hear of another pupil's deletion", (pup2.got.tombstones ?? []).some((x) => x._id === "p-sib2"), false);
  check("  but does of the subject's", (pup2.got.tombstones ?? []).some((x) => x._id === "s2"), true);

  console.log("--- 5. paging, other schools, the desktop's answer ---");
  const small = await phonePass("adm", { limit: 1 });
  const twice = ids(small.got.students).filter((x, i, a) => a.indexOf(x) !== i);
  check("one row a page: every pupil once", [ids(small.got.students), twice], [["p-own", "p-pending", "p-sib1"], []]);
  const b = await phonePass("admB");
  check("another school's admin: none of school A (tenancy from the token)", ids(b.got.classes), ["cb"]);
  const desk = await http("tea", "/changes?limit=5");
  check("no profile: the desktop's collections, no phone ones", Object.keys(desk.body.collections).some((c) => ["classes", "teachers", "students", "tombstones"].includes(c)), false);
  check("  and the teacher's known gaps are still refused there",
    ["class", "subject", "teacherAssignment"].every((c) => desk.body.refused.some((r) => r.collection === c)), true);
  const unknown = await http("adm", "/changes?profile=phone&collections=feeCharge");
  check("profile=phone serves only its own collections", unknown.body.refused?.[0]?.reason, "UNKNOWN_COLLECTION");

  // A school that took pupils away from its bursar: refused by name. (The
  // capabilities are narrowed for this one request, at the service the
  // controller asks.)
  const perms = require(path.join(ROOT, "src/services/permissions.service"));
  const before = await perms.effectiveFor("bursar", A);
  const realEffective = perms.effectiveFor;
  perms.effectiveFor = async (role, sid) => (role === "bursar" ? before.filter((k) => !k.startsWith("students.view")) : realEffective(role, sid));
  const noPupils = await http("bur", "/changes?profile=phone&collections=students,classes");
  perms.effectiveFor = realEffective;
  check("a staff role with no pupil capability is refused pupils by name, keeps the rest",
    [noPupils.body.refused?.map((r) => r.collection), Object.keys(noPupils.body.collections ?? {})], [["students"], ["classes"]]);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
