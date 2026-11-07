// backend/scripts/check-sync-pull-deletions.js
"use strict";

/**
 * Deletions reach every device through GET /sync/pull.
 *
 * The phone's contract (mobile syncManager syncClasses … syncStudents): a row
 * that arrives with deletedAt is marked deleted locally; any other row is
 * upserted and un-deleted. /sync/pull never sent such a row — it filtered
 * soft-deleted rows out, hard deletes left nothing, and deletedItems was [] —
 * so every deleted record stayed on every phone.
 *
 * Each "device" below applies a pull exactly as that contract says, keeping
 * the cursor the server returns. Everything goes through the real routes:
 * DELETE /admin/subjects/:id, /admin/teacher-assignments/:id, /admin/classes/:id,
 * /students/:id, /admin/periods/:id, and POST creates for the stale uploads.
 * In-memory MongoDB, synthetic schools.
 *
 *   node scripts/check-sync-pull-deletions.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

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
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await M("SyncTombstone").createIndexes();
  const db = mongoose.connection.db;

  // ── two schools ───────────────────────────────────────────────────────────
  const A = "school-a", B = "school-b";
  for (const [id, sid] of [[A, A], [B, B]]) {
    await M("School").collection.insertOne({ _id: id, name: id, isActive: true });
  }
  const user = (id, role, schoolId) => M("User").create({ _id: id, name: id, email: `${id}@example.test`,
    password: "check-only-password", role, schoolId, isActive: true });
  await user("adm-a", "school_admin", A);
  await user("adm-b", "school_admin", B);
  await user("sup", "super_admin", null);
  await user("tea-a", "teacher", A);
  await user("u-st1", "student", A);
  await M("Class").create({ _id: "c1", schoolId: A, name: "Form 1" });
  await M("Class").create({ _id: "c2", schoolId: A, name: "Form 2 (closing)" });
  await M("Class").create({ _id: "cb", schoolId: B, name: "B Form 1" });
  await M("Subject").create({ _id: "s1", schoolId: A, name: "Music", classId: "c1" });
  await M("Subject").create({ _id: "s2", schoolId: A, name: "Maths", classId: "c1" });
  await M("Subject").create({ _id: "s3", schoolId: A, name: "Art", classId: "c2" });
  await M("Subject").create({ _id: "sb", schoolId: B, name: "B Maths", classId: "cb" });
  await M("TeacherAssignment").create({ _id: "as1", schoolId: A, teacher: "tea-a", class: "c1", subject: "s2" });
  await M("Period").create({ _id: "p1", schoolId: A, name: "P1", startTime: "08:00", endTime: "09:00" });
  const pupil = (id, schoolId, userId) => M("Student").create({ _id: id, userId, schoolId, classId: schoolId === A ? "c1" : "cb",
    studentName: `Pupil ${id}`, enrollmentNo: `EN-${id}`, status: "approved", isActive: true,
    guardianName: `Guardian of ${id}`, guardianPhone: "+237600000000" });
  await pupil("st1", A, "u-st1");
  await pupil("st2", A, "u-st2");
  await pupil("st3", A, "u-st3");
  await pupil("stb", B, "u-stb");

  // ── the real routes ───────────────────────────────────────────────────────
  const auth = require(path.join(ROOT, "middleware/auth"));
  const app = express();
  app.use(express.json());
  app.use("/api/sync", auth.authenticate, require(path.join(SRC, "routes/sync.routes")));
  app.use("/api/admin/periods", auth.authenticate, require(path.join(SRC, "routes/periods.routes")));
  app.use("/api/admin", auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
  app.use("/api/students", auth.authenticate, require(path.join(SRC, "routes/students.routes")));
  app.use(require(path.join(ROOT, "middleware/errorHandler")));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const tok = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const TOK = { a: tok("adm-a", "school_admin", A), b: tok("adm-b", "school_admin", B), pupil: tok("u-st1", "student", A),
    sup: tok("sup", "super_admin", null) };
  const call = async (who, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${TOK[who]}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    let json = {}; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };

  // ── a device: the phone's apply rules, and its cursor ─────────────────────
  const COLLECTIONS = ["classes", "teachers", "subjects", "periods", "assignments", "students"];
  const device = (who, schoolId) => {
    const store = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
    const d = { who, schoolId, cursor: null, store, last: null };
    d.pull = async () => {
      const q = `/sync/pull?schoolId=${schoolId}${d.cursor ? `&lastSync=${encodeURIComponent(d.cursor)}` : ""}`;
      const r = await call(who, "GET", q);
      d.last = r;
      if (r.status !== 200) return r;
      for (const c of COLLECTIONS) {
        for (const row of r.body.data[c] || []) {
          const id = String(row._id || row.id);
          if (row.deletedAt) {
            // UPDATE … WHERE id = ?: marks a copy it has, creates nothing.
            if (store[c].has(id)) store[c].set(id, { ...store[c].get(id), deleted: true });
          } else {
            store[c].set(id, { ...row, deleted: false });
          }
        }
      }
      d.cursor = r.body.timestamp;
      return r;
    };
    d.visible = (c) => [...store[c].entries()].filter(([, v]) => !v.deleted).map(([k]) => k).sort();
    return d;
  };
  const tombs = async (filter = {}) => (await M("SyncTombstone").find(filter).lean()).map((t) => `${t.entity}:${t.docId}@${t.schoolId}`).sort();
  const tick = () => new Promise((ok) => setTimeout(ok, 15));

  const devA = device("a", A), devB = device("a", A), devC = device("a", A), devOther = device("b", B);
  for (const d of [devA, devB, devC, devOther]) await d.pull();
  check("first pull: every device holds the school's records",
    [devB.visible("subjects"), devB.visible("assignments"), devB.visible("students"), devB.visible("periods"), devB.visible("classes")],
    [["s1", "s2", "s3"], ["as1"], ["st1", "st2", "st3"], ["p1"], ["c1", "c2"]]);
  check("  a first pull carries no removals", devB.last.body.data.deletedItems, []);
  const cOffline = devC.cursor;   // device C goes offline now
  await tick();

  // ═══ 1, 2. device A deletes; the server records it; device B learns ═══
  console.log("--- a deletion reaches another device ---");
  let r = await call("a", "DELETE", "/admin/subjects/s1");
  const cBeforeDelete = devB.cursor;
  check("device A deletes subject s1 → 200; the row is gone and a tombstone records it",
    [r.status, await M("Subject").exists({ _id: "s1" }) ? "still there" : "gone", await tombs()],
    [200, "gone", ["subject:s1@school-a"]]);
  await devB.pull();
  check("device B pulls: s1 is removed, the others stay",
    devB.visible("subjects"), ["s2", "s3"]);
  check("  and the removal is listed in deletedItems",
    devB.last.body.data.deletedItems.map((x) => `${x.collection}:${x.id}`), ["subjects:s1"]);

  // ═══ 3. repeated pulls ═══
  await devB.pull(); await devB.pull();
  check("pulling again (twice) does not bring s1 back", devB.visible("subjects"), ["s2", "s3"]);
  // A device that still holds s1 and pulls from a cursor before the deletion
  // — twice, as a retried pull would — loses it, and keeps it lost.
  const replay = device("a", A);
  for (const id of ["s1", "s2", "s3"]) replay.store.subjects.set(id, { deleted: false });
  replay.cursor = cBeforeDelete; await replay.pull();
  replay.cursor = cBeforeDelete; await replay.pull();
  check("  a retried pull from a cursor before the deletion removes it, and keeps it removed",
    replay.visible("subjects"), ["s2", "s3"]);

  // ═══ more deletions while device C is offline ═══
  console.log("--- a device offline through several deletions ---");
  r = await call("a", "DELETE", "/admin/teacher-assignments/as1");
  check("assignment as1 deleted → 200", r.status, 200);
  r = await call("a", "DELETE", "/students/st2");
  check("student st2 deleted → 200, with its account", [r.status, await M("User").exists({ _id: "u-st2" }) ? "account kept" : "account gone"], [200, "account gone"]);
  r = await call("a", "DELETE", "/admin/periods/p1");
  check("period p1 deleted (soft) → 200", r.status, 200);
  r = await call("a", "DELETE", "/admin/classes/c2");
  check("class c2 deleted (soft, its subject s3 hard-deleted with it) → 200", [r.status, await tombs({ docId: "s3" })], [200, ["subject:s3@school-a"]]);
  await M("Student").updateOne({ _id: "st3" }, { $set: { isActive: false } });   // left the school
  // The deletions happened long ago: tombstones are never discarded.
  await db.collection("synctombstones").updateMany({}, { $set: { deletedAt: new Date(Date.now() - 90 * 864e5) } });
  devC.cursor = new Date(Date.now() - 100 * 864e5).toISOString();
  void cOffline;
  await devC.pull();
  check("device C reconnects (100 days offline) and receives every removal",
    [devC.visible("subjects"), devC.visible("assignments"), devC.visible("students"), devC.visible("periods"), devC.visible("classes")],
    [["s2"], [], ["st1"], [], ["c1"]]);

  // ═══ 5. retries ═══
  console.log("--- retries ---");
  const before = await tombs();
  r = await call("a", "DELETE", "/admin/subjects/s1");
  check("deleting s1 again → 404; the tombstones are unchanged (no second one)", [r.status, await tombs()], [404, before]);
  const snap = JSON.stringify([...devC.store.subjects.entries()]);
  devC.cursor = new Date(Date.now() - 100 * 864e5).toISOString();
  await devC.pull();
  check("  applying the same removals twice leaves the device exactly as it was",
    JSON.stringify([...devC.store.subjects.entries()]) === snap, true);

  // ═══ 6. stale uploads ═══
  console.log("--- a stale upload cannot bring a deleted record back ---");
  r = await call("a", "POST", "/admin/subjects", { id: "s1", name: "Music", classId: "c1" });
  check("a queued create of s1 under its old id → 410 RECORD_DELETED, nothing created",
    [r.status, r.body.code, Boolean(await M("Subject").exists({ _id: "s1" }))], [410, "RECORD_DELETED", false]);
  r = await call("a", "POST", "/admin/teacher-assignments", { id: "as1", teacherId: "tea-a", classId: "c1", subjectId: "s2" });
  check("  the same for the assignment as1", [r.status, r.body.code, Boolean(await M("TeacherAssignment").exists({ _id: "as1" }))], [410, "RECORD_DELETED", false]);
  await devB.pull();
  check("  and devices still see s1 deleted", devB.visible("subjects").includes("s1"), false);
  r = await call("a", "POST", "/admin/subjects", { name: "Music", classId: "c1" });
  check("  a NEW subject with the same name (a new id) is created normally", [r.status === 200 || r.status === 201, Boolean(r.body?.data?.subject?._id || r.body?.data?._id || r.body?.subject?._id)], [true, true]);

  // ═══ 7. boundaries ═══
  console.log("--- school and user boundaries ---");
  await devOther.pull();
  check("school B's device: none of school A's removals, its own records intact",
    [devOther.last.body.data.deletedItems, devOther.visible("subjects"), devOther.visible("students")], [[], ["sb"], ["stb"]]);
  r = await call("b", "GET", `/sync/pull?schoolId=${A}&lastSync=${encodeURIComponent(new Date(0 + 1).toISOString())}`);
  check("school B asking for school A's pull → 403", r.status, 403);
  await pupil("st4", A, "u-st4");
  r = await call("pupil", "GET", `/sync/pull?schoolId=${A}`);
  check("a student's token: their own student row only — not every pupil and guardian in the school",
    (r.body.data?.students || []).map((s) => s._id), ["st1"]);
  r = await call("pupil", "GET", `/sync/pull?schoolId=${A}&lastSync=${encodeURIComponent(new Date(Date.now() - 200 * 864e5).toISOString())}`);
  check("  incrementally too: no other pupil's row or removal reaches it",
    (r.body.data?.students || []).map((s) => s._id), ["st1"]);
  check("  and a student's teacher rows carry deletedAt but no email or account state",
    Object.keys((r.body.data?.teachers || [])[0] || {}).filter((k) => ["email", "isActive", "mustResetPassword"].includes(k)), []);

  // ═══ 8. the cursor ═══
  console.log("--- the cursor never skips a removal ---");
  const devD = device("a", A); await devD.pull();
  await M("Subject").create({ _id: "s9", schoolId: A, name: "Drama", classId: "c1" });
  await devD.pull();
  const cursor = devD.cursor;
  await M("Subject").collection.deleteOne({ _id: "s9" });   // gone without a tombstone yet…
  await M("SyncTombstone").create({ entity: "subject", docId: "s9", schoolId: A, deletedAt: new Date(cursor) });  // …stamped exactly on the cursor
  await devD.pull();
  check("a removal stamped exactly on the device's cursor is delivered (inclusive bound)",
    devD.visible("subjects").includes("s9"), false);
  await M("Subject").create({ _id: "s10", schoolId: A, name: "Chess", classId: "c1" });
  await M("Subject").deleteOne({ _id: "s10" });
  await devD.pull();
  check("  a record created and deleted between two pulls never appears, and leaves nothing behind",
    [devD.visible("subjects").includes("s10"), devD.store.subjects.has("s10")], [false, false]);

  // A tombstone whose row still exists (its delete failed after the tombstone
  // was written) is never sent.
  await M("SyncTombstone").create({ entity: "subject", docId: "s2", schoolId: A, deletedAt: new Date() });
  await devD.pull();
  check("a tombstone for a row that still exists is not sent: s2 stays",
    devD.visible("subjects").includes("s2"), true);
  await M("SyncTombstone").deleteOne({ docId: "s2" });

  // ═══ class deletion and its pupils ═══
  console.log("--- a class with pupils ---");
  const tombsBefore = await tombs();
  r = await call("a", "DELETE", "/admin/classes/c1");
  check("deleting a class that still has pupils → 409; the class, its subjects and pupils untouched, no tombstone",
    [r.status, Boolean(await M("Class").findOne({ _id: "c1", deletedAt: null })),
     Boolean(await M("Subject").exists({ _id: "s2" })), Boolean(await M("Student").exists({ _id: "st1" })), await tombs()],
    [409, true, true, true, tombsBefore]);

  // ═══ a student's assignment rows ═══
  await M("TeacherAssignment").create({ _id: "as2", schoolId: A, teacher: "tea-a", class: "c1", subject: "s2" });
  r = await call("pupil", "GET", `/sync/pull?schoolId=${A}`);
  const teacherBlobs = (r.body.data?.assignments || []).map((a) => a.teacher).filter((t) => t && typeof t === "object");
  check("a student's assignment rows name the teacher but carry no email",
    [teacherBlobs.length > 0, teacherBlobs.some((t) => "email" in t)], [true, false]);
  r = await call("a", "GET", `/sync/pull?schoolId=${A}`);
  check("  an admin's still carry it",
    (r.body.data?.assignments || []).some((a) => a.teacher && typeof a.teacher === "object" && "email" in a.teacher), true);

  // ═══ bulk paths skip save middleware; they are guarded too ═══
  console.log("--- bulk writes ---");
  const bulk = async (fn) => { try { await fn(); return "ok"; } catch (e) { return [e.statusCode, e.code, e.deletedIds]; } };
  check("insertMany carrying a deleted id → refused whole, naming it; nothing inserted",
    [await bulk(() => M("Subject").insertMany([{ _id: "s-new", schoolId: A, name: "New", classId: "c1" }, { _id: "s1", schoolId: A, name: "Music", classId: "c1" }])),
     Boolean(await M("Subject").exists({ _id: "s-new" })), Boolean(await M("Subject").exists({ _id: "s1" }))],
    [[410, "RECORD_DELETED", ["s1"]], false, false]);
  check("  an import of new ids is unaffected",
    [await bulk(() => M("Subject").insertMany([{ _id: "s-new", schoolId: A, name: "New", classId: "c1" }])), Boolean(await M("Subject").exists({ _id: "s-new" }))],
    ["ok", true]);
  check("  bulkWrite insertOne and an upsert on a deleted _id → refused",
    [await bulk(() => M("Student").bulkWrite([{ insertOne: { document: { _id: "st2", schoolId: A, status: "approved" } } }])),
     await bulk(() => M("TeacherAssignment").bulkWrite([{ updateOne: { filter: { _id: "as1" }, update: { $set: { schoolId: A } }, upsert: true } }]))],
    [[410, "RECORD_DELETED", ["st2"]], [410, "RECORD_DELETED", ["as1"]]]);
  const devE = device("a", A); await devE.pull();
  await M("Subject").bulkWrite([{ deleteOne: { filter: { _id: "s-new" } } }]);
  await devE.pull();
  check("  a bulkWrite deleteOne leaves a tombstone, and the deletion reaches devices",
    [await tombs({ docId: "s-new" }), devE.visible("subjects").includes("s-new")], [["subject:s-new@school-a"], false]);

  // ═══ 9. creates, updates, restores ═══
  console.log("--- ordinary changes still flow ---");
  await M("Class").updateOne({ _id: "c1" }, { $set: { name: "Form 1 (renamed)" } });
  await M("Student").updateOne({ _id: "st3" }, { $set: { isActive: true } });   // came back
  await devD.pull();
  check("an update arrives; a pupil who left and came back is visible again",
    [devD.store.classes.get("c1")?.name, devD.visible("students").includes("st3")], ["Form 1 (renamed)", true]);
  const fresh = device("a", A); await fresh.pull();
  check("a new device's first pull: live records only, no removals",
    [fresh.visible("subjects").includes("s1"), fresh.visible("classes").includes("c2"), fresh.last.body.data.deletedItems],
    [false, false, []]);

  // ═══ 10. a super_admin syncs the school they chose ═══
  console.log("--- a super_admin inside a school (the phone's school picker) ---");
  // A real school id: the door only looks up ids of the stored form.
  const C = "68e1000000000000000c0c01";
  await M("School").create({ _id: C, name: "School C", email: "c@example.test", isActive: true });
  await M("Class").create({ _id: "cc", schoolId: C, name: "C Form 1" });
  await M("Student").create({ _id: "stc", userId: "u-stc", schoolId: C, classId: "cc", studentName: "Pupil stc",
    enrollmentNo: "EN-stc", status: "approved", isActive: true });
  const sup = device("sup", C); await sup.pull();
  check("a super_admin pulls the school they named, and only that school",
    [sup.last.status, sup.visible("classes"), sup.visible("students")], [200, ["cc"], ["stc"]]);
  check("a school admin still cannot pull another school",
    (await call("a", "GET", `/sync/pull?schoolId=${C}`)).status, 403);
  check("a super_admin naming a school that does not exist is refused at the door",
    (await call("sup", "GET", "/sync/pull?schoolId=no-such-school")).status, 404);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
