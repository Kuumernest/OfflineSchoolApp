// backend/scripts/check-teacher-phone-roster.js
"use strict";

/**
 * A teacher's PHONE holds the pupils of the classes they teach, and nobody
 * else's (owner decision, 2026-11).
 *
 * The rule (config/syncFeed.js teacherRosterClassIds — the mobile app purges
 * local rows by the same one):
 *
 *   a teacher sees a pupil whose classId is a class where
 *     - the teacher holds an ACTIVE TeacherAssignment (isActive !== false;
 *       validFrom/validUntil are not consulted, as nowhere on the server), or
 *     - the teacher is the class teacher (Class.classTeacherId), the class not
 *       soft-deleted.
 *
 * Through both doors the phone uses — GET /sync/changes?profile=phone and the
 * older GET /sync/pull — paged, with pupil tombstones narrowed the same way.
 * A pupil of a class the teacher does not hold must not appear in ANY page, in
 * any collection or field.
 *
 * Plus: admin and bursar keep the whole roster, a pupil still gets only their
 * own row, a teacher granted students.view is still narrowed (the role decides,
 * as the desktop FEED's taughtStudentsOnly does), gaining a class delivers its
 * EXISTING pupils on the next pull though their rows did not change, and losing
 * one delivers the assignment/class change the phone purges by.
 *
 *   node scripts/check-teacher-phone-roster.js
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
  // The shortest overlap the feed allows, so a row written before the test's
  // passes is not re-sent by the commit-safe re-read and mistaken for delivery.
  process.env.SYNC_SAFETY_WINDOW_MS = "1000";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "teacher-phone-roster" });
  require(path.join(ROOT, "src/db/models"));
  const M = (n) => mongoose.model(n);
  await M("SyncTombstone").createIndexes();

  const A = "5c0e2e0000000000000000d1";
  const user = (id, role, extra = {}) => M("User").create({ _id: id, name: `Name ${id}`, email: `${id}@example.test`,
    password: "check-only-password", role, schoolId: A, isActive: true, ...extra });
  await user("adm", "school_admin"); await user("bur", "bursar"); await user("pup", "student");
  await user("teaA", "teacher"); await user("teaB", "teacher");

  // c1: teaA teaches (assignment).  c2: teaB's only — teaA must never see it.
  // c3: teaA is form master, no subject assignment.  c4: teaA's assignment
  // switched off.  c5, c6: gained later (assignment, form master).
  for (const [id, extra] of [["c1"], ["c2"], ["c3", { classTeacherId: "teaA", classTeacherName: "Name teaA" }], ["c4"], ["c5"], ["c6"]]) {
    await M("Class").create({ _id: id, schoolId: A, name: `Form ${id}`, ...(extra || {}) });
  }
  for (const c of ["1", "2", "3", "4", "5", "6"]) await M("Subject").create({ _id: `s${c}`, schoolId: A, name: `Subj ${c}`, classId: `c${c}` });
  await M("TeacherAssignment").create({ _id: "as1", schoolId: A, teacher: "teaA", class: "c1", subject: "s1" });
  await M("TeacherAssignment").create({ _id: "as2", schoolId: A, teacher: "teaB", class: "c2", subject: "s2" });
  await M("TeacherAssignment").create({ _id: "as4", schoolId: A, teacher: "teaA", class: "c4", subject: "s4", isActive: false });

  const pupil = (id, classId, extra = {}) => M("Student").create({ _id: id, userId: `u-${id}`, schoolId: A, classId,
    studentName: `Pupil ${id}`, enrollmentNo: `EN-${id}`, status: "approved", isActive: true,
    guardianName: `Guardian of ${id}`, guardianPhone: "+233200000000", ...extra });
  // Siblings across classes share a guardian's phone (CLAUDE.md) — normal data.
  await pupil("p1a", "c1", { userId: "pup" }); await pupil("p1b", "c1"); await pupil("p1c", "c1");
  await pupil("p1pend", "c1", { status: "pending" });
  await pupil("p2a", "c2"); await pupil("p2b", "c2"); await pupil("p2c", "c2", { status: "pending" });
  await pupil("p3a", "c3"); await pupil("p3b", "c3");
  await pupil("p4a", "c4");
  await pupil("p5a", "c5"); await pupil("p5b", "c5");
  await pupil("p6a", "c6");

  // Everything above is old news: dated well before any pass, so a pupil is
  // delivered by a later pass only if the server decided to send it — never
  // by the commit-safe re-read of recent rows.
  const OLD = new Date("2026-01-05T08:00:00Z");
  // One second apart, so /sync/pull's plain-timestamp cursor can page them
  // one at a time (it cannot split rows sharing a millisecond — its own
  // documented edge, not this check's subject).
  let tick = 0;
  for (const m of ["Class", "Subject", "TeacherAssignment", "Student", "User"]) {
    for (const d of await M(m).collection.find({}).sort({ _id: 1 }).toArray()) {
      const at = new Date(OLD.getTime() + 1000 * tick++);
      await M(m).collection.updateOne({ _id: d._id }, { $set: { updatedAt: at, createdAt: at } });
    }
  }

  const CLASS_OF = {}; for (const s of await M("Student").find().lean()) CLASS_OF[s._id] = s.classId;
  const pupilsOf = (...classes) => Object.keys(CLASS_OF).filter((id) => classes.includes(CLASS_OF[id])).sort();
  const FORBIDDEN = pupilsOf("c2", "c4");   // never, at any point, for teaA

  const auth = require(path.join(ROOT, "middleware/auth"));
  const app = express(); app.use(express.json());
  app.use("/api/sync", auth.authenticate, require(path.join(ROOT, "src/routes/sync.routes")));
  const server = app.listen(0);
  server.keepAliveTimeout = 120_000;
  const port = server.address().port;
  const tok = (id, role) => jwt.sign({ id, role, schoolId: A }, process.env.JWT_SECRET);
  const T = { adm: tok("adm", "school_admin"), bur: tok("bur", "bursar"), pup: tok("pup", "student"),
    teaA: tok("teaA", "teacher"), teaB: tok("teaB", "teacher") };
  const raw = [];   // every body teaA received, as text, for the "nowhere" assertion
  const http = async (who, p) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sync${p}`, { headers: { Authorization: `Bearer ${T[who]}` } });
    const text = await r.text();
    if (who === "teaA") raw.push(text);
    return { status: r.status, body: JSON.parse(text) };
  };

  /** A full phone pass, paged to exhaustion, as mobile/src/services/syncFeed.client.js does. */
  const phonePass = async (who, { limit = 1, cursors = {} } = {}) => {
    const got = {}; const cur = { ...cursors }; let pages = 0;
    let pending = null;
    for (let i = 0; i < 400; i++) {
      const qs = new URLSearchParams({ profile: "phone", limit: String(limit) });
      if (pending) qs.set("collections", pending.join(","));
      const asked = Object.fromEntries(Object.entries(cur).filter(([k]) => !pending || pending.includes(k)));
      if (Object.keys(asked).length) qs.set("cursors", JSON.stringify(asked));
      const r = await http(who, `/changes?${qs}`);
      if (r.status !== 200) throw new Error(`phone pass ${who}: ${r.status}`);
      pages++;
      pending = [];
      for (const [name, slice] of Object.entries(r.body.collections)) {
        (got[name] ??= []).push(...slice.documents);
        if (slice.cursor) cur[name] = slice.cursor;
        if (slice.hasMore) pending.push(name);
      }
      if (!pending.length) break;
    }
    return { got, cursors: cur, pages };
  };

  /** /sync/pull as an old phone does: store `timestamp`, pull again while hasMore.
   *  Three a page: its cursor is inclusive, so a page re-sends its boundary row. */
  const pullPass = async (who, { limit = 3, lastSync = null } = {}) => {
    const got = {}; let ts = lastSync; let pages = 0;
    for (let i = 0; i < 400; i++) {
      const qs = new URLSearchParams({ schoolId: A, limit: String(limit) });
      if (ts) qs.set("lastSync", ts);
      const r = await http(who, `/pull?${qs}`);
      if (r.status !== 200) throw new Error(`pull ${who}: ${r.status}`);
      pages++;
      for (const [name, rows] of Object.entries(r.body.data)) (got[name] ??= []).push(...rows);
      ts = r.body.timestamp;
      if (!r.body.hasMore) break;
    }
    return { got, lastSync: ts, pages };
  };

  const uniq = (a) => [...new Set(a)].sort();
  const ids  = (rows) => uniq((rows ?? []).map((r) => String(r._id ?? r.id)));
  const live = (rows) => uniq((rows ?? []).filter((r) => !r.deletedAt).map((r) => String(r._id)));
  const removed = (rows) => uniq((rows ?? []).filter((r) => r.deletedAt).map((r) => String(r._id)));
  const leaked = () => FORBIDDEN.filter((id) => raw.some((t) => t.includes(`"${id}"`) || t.includes(`Pupil ${id}`) || t.includes(`Guardian of ${id}`)));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 1. teacher A: classes 1 (assigned) and 3 (form master), nothing else ---");
  const feedA = await phonePass("teaA");
  check("phone feed: live pupils of c1 and c3 exactly", live(feedA.got.students), uniq([...pupilsOf("c1", "c3")].filter((x) => x !== "p1pend")));
  check("phone feed: c1's pending pupil arrives as a removal row (as for staff)", removed(feedA.got.students), ["p1pend"]);
  check("phone feed: paged (one row a page), every pupil once",
    [feedA.pages > 5, (feedA.got.students ?? []).length], [true, pupilsOf("c1", "c3").length]);
  const pullA = await pullPass("teaA");
  check("/sync/pull: live pupils of c1 and c3 exactly", live(pullA.got.students), live(feedA.got.students));
  check("/sync/pull: paged", pullA.pages > 5, true);
  check("no pupil of c2 or the switched-off c4 anywhere in any page (id, name, guardian)", leaked(), []);
  check("classes and assignments still arrive whole (the phone purges by them)",
    [ids(feedA.got.classes), ids(feedA.got.assignments), ids(pullA.got.assignments)],
    [["c1", "c2", "c3", "c4", "c5", "c6"], ["as1", "as2", "as4"], ["as1", "as2", "as4"]]);

  console.log("--- 2. everybody else as before ---");
  const ALL_LIVE = Object.keys(CLASS_OF).filter((id) => !["p1pend", "p2c"].includes(id)).sort();
  for (const who of ["adm", "bur"]) {
    const f = await phonePass(who, { limit: 500 });
    const p = await pullPass(who, { limit: 2000 });
    check(`${who}: the whole roster, phone feed and /sync/pull`, [live(f.got.students), live(p.got.students)], [ALL_LIVE, ALL_LIVE]);
  }
  const pf = await phonePass("pup", { limit: 500 });
  const pp = await pullPass("pup", { limit: 2000 });
  check("a pupil: their own row only, both doors", [ids(pf.got.students), ids(pp.got.students)], [["p1a"], ["p1a"]]);
  const fb = await phonePass("teaB", { limit: 500 });
  check("teacher B: c2 only", live(fb.got.students), ["p2a", "p2b"]);

  console.log("--- 3. a teacher granted students.view is still narrowed (the role decides, as the desktop FEED) ---");
  const perms = require(path.join(ROOT, "src/services/permissions.service"));
  const realEffective = perms.effectiveFor;
  perms.effectiveFor = async (role, sid) => {
    const held = await realEffective(role, sid);
    return role === "teacher" ? uniq([...held, "students.view"]) : held;
  };
  const over = await phonePass("teaA", { limit: 500 });
  const overPull = await pullPass("teaA", { limit: 2000 });
  perms.effectiveFor = realEffective;
  check("students.view override: phone feed and /sync/pull still c1 + c3", [live(over.got.students), live(overPull.got.students)],
    [live(feedA.got.students), live(feedA.got.students)]);
  check("  and still no c2/c4 pupil anywhere", leaked(), []);

  console.log("--- 4. hard deletes: a teacher hears only of their own classes' pupils ---");
  await M("Student").deleteOne({ _id: "p1c" });
  await M("Student").deleteOne({ _id: "p2b" });
  const feedA2 = await phonePass("teaA", { cursors: feedA.cursors });
  const stonesA = (feedA2.got.tombstones ?? []).filter((t) => t.collection === "students").map((t) => t._id).sort();
  check("phone feed: the c1 pupil's tombstone, not the c2 pupil's", stonesA, ["p1c"]);
  const pullA2 = await pullPass("teaA", { lastSync: pullA.lastSync });
  check("/sync/pull: deletedItems name the c1 pupil, not the c2 pupil",
    uniq(pullA2.got.deletedItems.filter((d) => d.collection === "students").map((d) => d.id)), ["p1c"]);
  check("  nor anywhere in any page", leaked(), []);
  const admStones = await phonePass("adm", { limit: 500, cursors: {} });
  check("the admin hears of both", (admStones.got.tombstones ?? []).filter((t) => t.collection === "students").map((t) => t._id).sort(), ["p1c", "p2b"]);

  console.log("--- 5. gaining a class delivers its existing (unchanged) pupils ---");
  await M("TeacherAssignment").create({ _id: "as5", schoolId: A, teacher: "teaA", class: "c5", subject: "s5" });
  await M("Class").updateOne({ _id: "c6" }, { $set: { classTeacherId: "teaA", classTeacherName: "Name teaA" } });
  // Past the commit-safe overlap (one second here), so the cursor the gaining
  // pass hands back rests after the grant and the next pass can be quiet.
  await new Promise((r) => setTimeout(r, 1500));
  const feedA3 = await phonePass("teaA", { cursors: feedA2.cursors });
  check("phone feed: c5 (new assignment) and c6 (new form master) pupils arrive",
    pupilsOf("c5", "c6").every((id) => live(feedA3.got.students).includes(id)), true);
  check("  with the assignment and class change that granted them", [ids(feedA3.got.assignments).includes("as5"), ids(feedA3.got.classes).includes("c6")], [true, true]);
  const pullA3 = await pullPass("teaA", { lastSync: pullA2.lastSync });
  check("/sync/pull: c5 and c6 pupils arrive",
    pupilsOf("c5", "c6").every((id) => live(pullA3.got.students).includes(id)), true);
  check("  still no c2/c4 pupil anywhere", leaked(), []);
  // And a quiet pass after: the gain is not re-sent for ever.
  const feedA4 = await phonePass("teaA", { cursors: feedA3.cursors });
  check("phone feed: the next pass is quiet again", live(feedA4.got.students), []);
  const pullA4 = await pullPass("teaA", { lastSync: pullA3.lastSync });
  check("/sync/pull: the next pull is quiet again", live(pullA4.got.students), []);

  console.log("--- 6. losing a class: the change the phone purges by is delivered ---");
  await M("TeacherAssignment").updateOne({ _id: "as1" }, { $set: { isActive: false } });
  await M("Class").updateOne({ _id: "c3" }, { $set: { classTeacherId: null, classTeacherName: null } });
  await M("TeacherAssignment").deleteOne({ _id: "as5" });
  const feedA5 = await phonePass("teaA", { cursors: feedA4.cursors });
  const pullA5 = await pullPass("teaA", { lastSync: pullA4.lastSync });
  for (const [door, got, asgs] of [["phone feed", feedA5.got, feedA5.got.assignments], ["/sync/pull", pullA5.got, pullA5.got.assignments]]) {
    check(`${door}: the switched-off assignment arrives with isActive false`, (asgs ?? []).find((a) => a._id === "as1")?.isActive, false);
    check(`${door}: c3 arrives with no class teacher`, (got.classes ?? []).some((c) => c._id === "c3" && !c.classTeacherId), true);
  }
  check("phone feed: the deleted assignment arrives as a tombstone",
    (feedA5.got.tombstones ?? []).some((t) => t.collection === "assignments" && t._id === "as5"), true);
  check("/sync/pull: the deleted assignment arrives in deletedItems",
    pullA5.got.deletedItems.some((d) => d.collection === "assignments" && d.id === "as5"), true);
  // A lost class's pupils are no longer sent, changed or not.
  await M("Student").updateOne({ _id: "p1b" }, { $set: { guardianName: "Changed" } });
  const feedA6 = await phonePass("teaA", { cursors: feedA5.cursors });
  const pullA6 = await pullPass("teaA", { lastSync: pullA5.lastSync });
  check("a change to a lost class's pupil is not sent (either door)",
    [ids(feedA6.got.students).includes("p1b"), ids(pullA6.got.students).includes("p1b")], [false, false]);
  const now = await phonePass("teaA", { limit: 500, cursors: {} });
  check("a fresh phone pass now: c6 only (c1 switched off, c3 handed back, c5 deleted)", live(now.got.students), ["p6a"]);

  console.log("--- 7. the desktop feed's answer is the desktop's ---");
  const desk = await http("teaA", "/changes?collections=student&limit=500");
  check("desktop FEED (no profile) for teacher A: its taughtStudentsOnly answer, unchanged",
    live(desk.body.collections.student.documents), []);
  check("  and no c2/c4 pupil anywhere, whole run", leaked(), []);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
