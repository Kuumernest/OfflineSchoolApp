// backend/scripts/check-delete-school.js
"use strict";

/**
 * D2 — scripts/delete-school.js removes one school and nothing else.
 *
 *   gv  "Green Valley Academy"   the target: admin, teacher, pupil login, ama
 *                                + bih (guardian Mrs Tem), an exam with a mark,
 *                                class, fee, announcement, notification, a
 *                                collection no model knows, logo file
 *   bf  "Bright Future"          kept: teacher, cho (also Mrs Tem's child), an
 *                                exam with a mark, the same kinds of records
 *   two schools named "Twin"     a name that matches both is refused
 *   two Super Admins             one with no school, one with gv's id — kept
 *
 *   portal codes   gv [ama, bih] → deleted; gv [ama, cho] → kept, unlinked to
 *                  [cho]; bf [cho] → untouched
 *   files          gv's logo removed; a file bf also uses kept; bf's logo kept
 *
 *   node scripts/check-delete-school.js
 */

const fs       = require("fs");
const os       = require("os");
const path     = require("path");
const mongoose = require("mongoose");
const { stopQuietly } = require("./stopQuietly");

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");
  const { run } = require("./delete-school");
  const { computePlatformStats, parseFilters } = require("../src/services/platformStats.service");
  const db = mongoose.connection.db;
  const C  = (n) => db.collection(n);

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const GV = new mongoose.Types.ObjectId().toString();
  const BF = new mongoose.Types.ObjectId().toString();
  const YEAR = "2026/2027";
  // As in the real database: a school's own _id is an ObjectId, the schoolId
  // other records carry is its string.
  const OID = (id) => new mongoose.Types.ObjectId(id);
  const either = (id) => ({ $in: [id, OID(id)] });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delete-school-"));
  for (const f of ["gv-logo.png", "bf-logo.png", "shared.pdf"]) {
    fs.mkdirSync(path.join(root, "uploads", "logos"), { recursive: true });
    fs.writeFileSync(path.join(root, "uploads", "logos", f), "x");
  }
  const file = (f) => fs.existsSync(path.join(root, "uploads", "logos", f));

  await C("schools").insertMany([
    { _id: OID(GV), name: "Green Valley Academy", logo: "/uploads/logos/gv-logo.png", settings: { academicYear: YEAR }, deletedAt: null },
    { _id: OID(BF), name: "Bright Future",        logo: "/uploads/logos/bf-logo.png", settings: { academicYear: YEAR }, deletedAt: null },
    { _id: new mongoose.Types.ObjectId(), name: "Twin", deletedAt: null }, { _id: new mongoose.Types.ObjectId(), name: "Twin", deletedAt: null },
  ]);
  await C("users").insertMany([
    { _id: "sa-1",   name: "Root",     role: "super_admin",  schoolId: null },
    { _id: "sa-2",   name: "Root Two", role: "super_admin",  schoolId: GV },
    { _id: "gv-adm", name: "GV Admin", role: "school_admin", schoolId: GV },
    { _id: "gv-tch", name: "GV Tch",   role: "teacher",      schoolId: GV },
    { _id: "u-ama",  name: "Ama",      role: "student",      schoolId: null },
    { _id: "bf-tch", name: "BF Tch",   role: "teacher",      schoolId: BF },
    { _id: "u-cho",  name: "Cho",      role: "student",      schoolId: BF },
  ]);
  const pupil = (_id, schoolId, extra = {}) => ({
    _id, schoolId, studentName: _id, status: "approved", deletedAt: null,
    guardianName: "Mrs Tem", guardianEmail: "tem@gmail.com", ...extra,
  });
  await C("students").insertMany([
    pupil("ama", GV, { userId: "u-ama" }), pupil("bih", GV),
    pupil("cho", BF, { userId: "u-cho", documents: [{ path: "uploads/logos/shared.pdf" }] }),
  ]);
  await C("applications_shadow").insertOne({ schoolId: GV, note: "a collection no model knows" });
  await C("applications_shadow").insertOne({ schoolId: BF, note: "kept" });
  await C("guardianaccesses").insertMany([
    { _id: "code-gv",    schoolId: GV, studentIds: ["ama", "bih"] },
    { _id: "code-cross", schoolId: GV, studentIds: ["ama", "cho"] },
    { _id: "code-bf",    schoolId: BF, studentIds: ["cho"] },
  ]);
  await C("exams").insertMany([
    { _id: "e-gv", schoolId: GV, name: "Seq 1", academicYear: YEAR, term: 1, deletedAt: null },
    { _id: "e-bf", schoolId: BF, name: "Seq 1", academicYear: YEAR, term: 1, deletedAt: null },
  ]);
  await C("exammarks").insertMany([
    { _id: "m-gv", examId: "e-gv", studentId: "ama", teacherId: "gv-tch" },
    { _id: "m-bf", examId: "e-bf", studentId: "cho", teacherId: "bf-tch" },
  ]);
  for (const S of [GV, BF]) {
    await C("classes").insertOne({ schoolId: S, name: "Form 1" });
    await C("feecharges").insertOne({ schoolId: S, studentId: S === GV ? "ama" : "cho", academicYear: YEAR, amount: 50000 });
    await C("announcements").insertOne({ schoolId: S, title: "Hello", body: "x", isActive: true });
    await C("notifications").insertOne({ schoolId: S, kind: "fee.reminder", to: "tem@gmail.com", documents: S === GV ? "uploads/logos/shared.pdf" : null });
    await C("auditlogs").insertOne({ schoolId: S, action: "x" });
  }
  await C("idempotencykeys").insertMany([{ key: "k1", userId: "gv-tch" }, { key: "k2", userId: "bf-tch" }]);
  await C("synclogs").insertMany([{ userId: "gv-adm" }, { userId: "bf-tch" }]);

  const snapshot = async () => {
    const out = {};
    for (const { name } of await db.listCollections().toArray()) {
      const n = await C(name).countDocuments({ $or: [{ schoolId: BF }, { _id: either(BF) }] });
      if (n) out[name] = n;
    }
    return Object.fromEntries(Object.entries(out).sort());
  };
  const bfBefore    = await snapshot();
  const statsBefore = await computePlatformStats(parseFilters({}));
  const rowOf = (stats, id) => (stats.schools ?? []).find((s) => String(s.schoolId) === id) ?? null;

  console.log("\n--- naming the school ---");
  check("by exact name",  String((await run({ school: "Green Valley Academy" })).plan.school._id), GV);
  check("by id",          (await run({ school: GV })).plan.school.name, "Green Valley Academy");
  const refused = async (args) => run(args).then(() => "ran", (e) => (e.refused ? e.message : `error: ${e.message}`));
  check("a name matching two schools is refused", await refused({ school: "Twin" }), `"Twin" matches 2 schools — use the school's id`);
  check("a near name is not a match",             (await refused({ school: "green valley academy" })).startsWith("No school"), true);

  console.log("\n--- dry run ---");
  const { plan } = await run({ school: GV, uploadsRoot: root });
  check("counts per collection", Object.fromEntries(Object.entries(plan.counts).sort()), {
    announcements: 1, applications_shadow: 1, auditlogs: 1, classes: 1, exammarks: 1, exams: 1,
    feecharges: 1, guardianaccesses: 1, idempotencykeys: 1, notifications: 1, students: 2, synclogs: 1, users: 3,
  });
  check("logins: staff and the pupil's, never a Super Admin", plan.userIds.sort(), ["gv-adm", "gv-tch", "u-ama"]);
  check("the cross-school portal code is to be unlinked, not deleted", [plan.codesDeleted, plan.codesUnlinked], [["code-gv"], ["code-cross"]]);
  check("only the logo no one else uses is listed (a file Bright Future's pupil also points to is kept)", plan.files, ["uploads/logos/gv-logo.png"]);
  check("dry run writes nothing",
    [await C("schools").countDocuments(), await C("students").countDocuments(), file("gv-logo.png")], [4, 3, true]);

  console.log("\n--- --apply ---");
  check("a wrong confirmation is refused",
    await refused({ school: GV, apply: true, confirm: "Green Valley", uploadsRoot: root }),
    "The name typed does not match the school's exact name — nothing deleted");
  check("and deleted nothing", [await C("schools").countDocuments({ _id: OID(GV) }), await C("students").countDocuments({ schoolId: GV })], [1, 2]);

  const { result } = await run({ school: GV, apply: true, confirm: async () => "Green Valley Academy", uploadsRoot: root });
  check("standalone database: ran in order without a transaction", result.transaction, false);
  const left = {};
  for (const { name } of await db.listCollections().toArray()) {
    const n = await C(name).countDocuments({ $or: [{ schoolId: GV }, { _id: either(GV) }] });
    if (n) left[name] = n;
  }
  check("nothing with the school's id is left (Super Admin aside)", left, { users: 1 });
  check("both Super Admins kept", (await C("users").find({ role: "super_admin" }).toArray()).map((u) => u._id).sort(), ["sa-1", "sa-2"]);
  check("its logins, marks, keys and sync logs gone",
    [await C("users").countDocuments({ _id: { $in: ["gv-adm", "gv-tch", "u-ama"] } }), await C("exammarks").countDocuments({ _id: "m-gv" }),
     await C("idempotencykeys").countDocuments({ userId: "gv-tch" }), await C("synclogs").countDocuments({ userId: "gv-adm" })],
    [0, 0, 0, 0]);
  check("portal codes: its own gone; the cross-school one kept with only Cho, moved to Cho's school; Bright Future's untouched",
    (await C("guardianaccesses").find().sort({ _id: 1 }).toArray()).map((c) => [c._id, c.studentIds, c.schoolId === BF]),
    [["code-bf", ["cho"], true], ["code-cross", ["cho"], true]]);
  check("files: its logo removed, the shared file and the other logo kept",
    [file("gv-logo.png"), file("shared.pdf"), file("bf-logo.png"), result.filesRemoved], [false, true, true, 1]);

  console.log("\n--- the other schools ---");
  check("Bright Future: every collection unchanged, plus the code moved to it",
    await snapshot(), { ...bfBefore, guardianaccesses: bfBefore.guardianaccesses + 1 });
  check("their users, marks, keys and sync logs kept",
    [await C("users").countDocuments({ _id: { $in: ["bf-tch", "u-cho"] } }), await C("exammarks").countDocuments({ _id: "m-bf" }),
     await C("idempotencykeys").countDocuments({ userId: "bf-tch" }), await C("synclogs").countDocuments({ userId: "bf-tch" })],
    [2, 1, 1, 1]);
  check("the Twins kept", await C("schools").countDocuments({ name: "Twin" }), 2);

  console.log("\n--- platform totals ---");
  const statsAfter = await computePlatformStats(parseFilters({}));
  check("the platform page still loads, without the deleted school",
    [rowOf(statsBefore, GV) !== null, rowOf(statsAfter, GV)], [true, null]);
  check("Bright Future's row is unchanged", rowOf(statsAfter, BF), rowOf(statsBefore, BF));
  check("the student total drops by exactly the deleted school's",
    (statsBefore.totals?.students ?? 0) - (statsAfter.totals?.students ?? 0), rowOf(statsBefore, GV)?.students ?? -1);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
