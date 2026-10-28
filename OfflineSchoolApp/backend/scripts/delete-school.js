// backend/scripts/delete-school.js
"use strict";

/**
 * D2 — remove one school and everything scoped to it.
 *
 *   npm run school:delete -- --school <id or exact name>            # dry run
 *   npm run school:delete -- --school <id or exact name> --apply    # asks for the exact name
 *
 * The dry run prints a count per collection and writes nothing.
 *
 * What goes:
 *   - every document in every collection whose schoolId is the school's —
 *     read from the database's own collection list, so a collection added
 *     later is not missed (students, staff data, classes, subjects, timetable,
 *     periods, exams, results, report cards and templates, attendance, fees,
 *     payments, payroll, expenses, announcements, notifications, admissions,
 *     audit logs, …)
 *   - exam marks of its exams or pupils (they carry no schoolId)
 *   - its logins: staff and pupil accounts of this school — never a Super Admin
 *   - their idempotency keys and sync logs
 *   - uploaded files (logo, documents, content) that only this school's
 *     records point to, plus any logo or photo file named after the school
 *     or one of its pupils that no record points to any more (a replaced
 *     logo) — from wherever the uploads live: the local uploads directory or
 *     the bucket (src/storage/fileStore.js, STORAGE_* variables), and always
 *     from GridFS in this same database (uploads.files / uploads.chunks):
 *     every file filed under the school, whichever driver this machine is
 *     set to — the dry run counts them and their size
 *   - the school itself, last
 *
 * What stays:
 *   - other schools, and everything of theirs
 *   - a guardian portal code that also covers a child at another school: the
 *     deleted children are unlinked, the code is kept (one guardian can have
 *     children in several places — see CLAUDE.md)
 *
 * --apply refuses unless the exact school name is typed, refuses a name that
 * matches more than one school, and runs in a transaction when the database
 * supports one (a replica set); otherwise it deletes the school record last,
 * so an interrupted run can simply be run again.
 */

const path     = require("path");
const readline = require("readline");
const mongoose = require("mongoose");

// Handled on their own, not by the schoolId sweep.
const SPECIAL = new Set(["schools", "users", "guardianaccesses", "exammarks", "idempotencykeys", "synclogs"]);

// GridFS's own collections: files are removed through the store, and the
// chunks — the bytes themselves — are never scanned for paths.
const { GRIDFS_BUCKET } = require("../src/storage/fileStore");
const GRIDFS_COLLECTIONS = new Set([`${GRIDFS_BUCKET}.files`, `${GRIDFS_BUCKET}.chunks`]);

const UPLOAD = /(?:^|[\\/])uploads[\\/][^\s"'<>?#]+/g;

const fail = (msg) => Object.assign(new Error(msg), { refused: true });

function idForms(id) {
  const out = [String(id)];
  if (mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(String(id))) out.push(new mongoose.Types.ObjectId(String(id)));
  return out;
}

/** The one school `arg` names: its id, or its exact name. */
async function resolveSchool(db, arg) {
  const wanted = String(arg ?? "").trim();
  if (!wanted) throw fail("Name the school: --school <id or exact name>");
  const schools = db.collection("schools");
  const byId = await schools.find({ _id: { $in: idForms(wanted) } }).toArray();
  if (byId.length === 1) return byId[0];
  const byName = await schools.find({ name: wanted }).toArray();
  if (byName.length > 1) throw fail(`"${wanted}" matches ${byName.length} schools — use the school's id`);
  if (!byName.length) throw fail(`No school with the id or exact name "${wanted}"`);
  return byName[0];
}

/** Every upload path a value mentions. */
function uploadPaths(value, out = new Set()) {
  if (typeof value === "string") {
    for (const m of value.match(UPLOAD) ?? []) out.add(m.replace(/^[\\/]/, "").replace(/\\/g, "/"));
  } else if (Array.isArray(value)) {
    value.forEach((v) => uploadPaths(v, out));
  } else if (value && typeof value === "object" && !(value instanceof Date) && !mongoose.isObjectIdOrHexString(value)) {
    Object.values(value).forEach((v) => uploadPaths(v, out));
  }
  return out;
}

/**
 * The store files are removed from: the app's (from STORAGE_*), or — when a
 * caller names a directory — the local uploads/ inside it.
 */
const storeFor = ({ uploadsRoot, store } = {}) => {
  if (store) return store;
  const fileStore = require("../src/storage/fileStore");
  return uploadsRoot
    ? fileStore.createStore({ driver: "local", root: path.join(uploadsRoot, "uploads") })
    : fileStore.getStore();
};

/**
 * The stores to clean: the configured one, plus GridFS in this database when
 * that is not it already — run from a laptop (local driver by default) the
 * production files are still in the database being cleaned.
 */
const storesFor = (db, store) => {
  if (store?.driver === "mongo") return [store];
  const grid = require("../src/storage/fileStore").createStore({ driver: "mongo", db });
  return store ? [store, grid] : [grid];
};

async function plan(db, school, { store = null } = {}) {
  const sid  = school._id;
  const ours = { $in: idForms(sid) };
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name).filter((n) => !n.startsWith("system.") && !GRIDFS_COLLECTIONS.has(n)).sort();
  const stores = storesFor(db, store);
  const grid   = stores.find((s) => s.driver === "mongo");

  const counts = {};
  const files  = new Set();
  for (const name of names.filter((n) => !SPECIAL.has(n))) {
    const n = await db.collection(name).countDocuments({ schoolId: ours });
    if (!n) continue;
    counts[name] = n;
    for await (const doc of db.collection(name).find({ schoolId: ours })) uploadPaths(doc, files);
  }
  uploadPaths(school, files);

  const students   = await db.collection("students").find({ schoolId: ours }).project({ _id: 1, userId: 1 }).toArray();
  const studentIds = students.map((s) => String(s._id));
  const examIds    = (await db.collection("exams").find({ schoolId: ours }).project({ _id: 1 }).toArray()).map((e) => String(e._id));

  // Logins: this school's staff and pupils; a pupil account with no school
  // set is included only when one of this school's pupils points to it.
  const pupilUserIds = students.map((s) => s.userId).filter(Boolean).map(String);
  const users = await db.collection("users").find({
    role: { $ne: "super_admin" },
    $or: [
      { schoolId: ours },
      { _id: { $in: pupilUserIds }, $or: [{ schoolId: null }, { schoolId: { $exists: false } }] },
    ],
  }).project({ _id: 1, role: 1 }).toArray();
  const userIds = users.map((u) => String(u._id));
  for await (const u of db.collection("users").find({ _id: { $in: userIds } })) uploadPaths(u, files);

  const marks = { $or: [{ examId: { $in: examIds } }, { studentId: { $in: studentIds } }] };
  counts.exammarks       = await db.collection("exammarks").countDocuments(marks);
  counts.users           = userIds.length;
  counts.idempotencykeys = await db.collection("idempotencykeys").countDocuments({ userId: { $in: userIds } });
  counts.synclogs        = await db.collection("synclogs").countDocuments({ userId: { $in: userIds } });

  // Portal codes: delete a code only when every child it covers is ours.
  const mine = new Set(studentIds);
  const codes = await db.collection("guardianaccesses").find({
    $or: [{ schoolId: ours }, { studentIds: { $in: studentIds } }],
  }).project({ _id: 1, schoolId: 1, studentIds: 1 }).toArray();
  const codesDeleted  = codes.filter((c) => (c.studentIds ?? []).every((id) => mine.has(String(id)))).map((c) => c._id);
  const unlinked      = codes.filter((c) => !(c.studentIds ?? []).every((id) => mine.has(String(id))));
  const codesUnlinked = unlinked.map((c) => c._id);
  // A kept code that was filed under this school moves to the school of the
  // children it still covers — portal login looks a code up by school.
  const codesMoved = [];
  for (const c of unlinked.filter((x) => idForms(sid).some((f) => String(f) === String(x.schoolId)))) {
    const rest = (c.studentIds ?? []).map(String).filter((id) => !mine.has(id));
    const kid  = await db.collection("students").findOne({ _id: { $in: rest } }, { projection: { schoolId: 1 } });
    if (kid) codesMoved.push({ _id: c._id, schoolId: kid.schoolId });
  }
  counts.guardianaccesses = codesDeleted.length;

  // Files named after the school or one of its pupils (logos/<school id>-…,
  // photos/<student id>-…): a logo replaced long ago that no record names any
  // more is still this school's. Listed from the store itself.
  {
    const prefixes = [`logos/${String(sid).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}-`,
      ...studentIds.map((id) => `photos/${id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}-`)];
    for (const st of stores) {
      for (const prefix of prefixes) {
        for (const key of await st.list(prefix)) files.add(`uploads/${key}`);
      }
    }
  }

  // Every GridFS file filed under the school (its metadata), whatever its
  // name: documents, attachments, teacher content.
  for (const key of (await grid.schoolFiles(sid)).keys) files.add(`uploads/${key}`);

  // A file any record that stays still points to is kept — every collection,
  // since a path can sit anywhere (a sibling's documents, a login's avatar).
  if (files.size) {
    for (const name of names) {
      const kept = name === "schools" ? { _id: { $ne: sid } }
        : name === "users" ? { _id: { $nin: userIds } }
        : { schoolId: { $nin: idForms(sid) } };
      for await (const doc of db.collection(name).find(kept)) {
        for (const p of uploadPaths(doc)) files.delete(p);
        if (!files.size) break;
      }
      if (!files.size) break;
    }
  }

  // What of that is in GridFS, and how much room it takes.
  const gridfs = { files: 0, bytes: 0 };
  for (const rel of files) {
    const f = await grid.stat(rel.replace(/^uploads\//, "")).catch(() => null);
    if (f) { gridfs.files++; gridfs.bytes += f.size || 0; }
  }

  for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
  return {
    gridfs,
    school: { _id: sid, name: school.name },
    counts, schoolScoped: Object.keys(counts).filter((n) => !SPECIAL.has(n)),
    studentIds, examIds, userIds, codesDeleted, codesUnlinked, codesMoved,
    staffLogins: users.filter((u) => u.role !== "student").length,
    files: [...files].sort(),
  };
}

async function deleteAll(db, p, session) {
  const opt  = session ? { session } : {};
  const ours = { $in: idForms(p.school._id) };
  for (const name of p.schoolScoped) await db.collection(name).deleteMany({ schoolId: ours }, opt);
  await db.collection("exammarks").deleteMany({ $or: [{ examId: { $in: p.examIds } }, { studentId: { $in: p.studentIds } }] }, opt);
  await db.collection("guardianaccesses").deleteMany({ _id: { $in: p.codesDeleted } }, opt);
  await db.collection("guardianaccesses").updateMany(
    { _id: { $in: p.codesUnlinked } }, { $pull: { studentIds: { $in: p.studentIds } } }, opt);
  for (const m of p.codesMoved) await db.collection("guardianaccesses").updateOne({ _id: m._id }, { $set: { schoolId: m.schoolId } }, opt);
  await db.collection("idempotencykeys").deleteMany({ userId: { $in: p.userIds } }, opt);
  await db.collection("synclogs").deleteMany({ userId: { $in: p.userIds } }, opt);
  await db.collection("users").deleteMany({ _id: { $in: p.userIds }, role: { $ne: "super_admin" } }, opt);
  await db.collection("schools").deleteOne({ _id: p.school._id }, opt);
}

const noTransactions = (err) =>
  err?.code === 20 || /replica set|Transaction numbers|transactions are not supported|retryable writes/i.test(err?.message ?? "");

async function apply(db, p, { store }) {
  let transaction = true;
  const session = await mongoose.connection.getClient().startSession();
  try {
    await session.withTransaction(() => deleteAll(db, p, session));
  } catch (err) {
    if (!noTransactions(err)) throw err;
    transaction = false;
    await deleteAll(db, p, null);
  } finally {
    await session.endSession();
  }

  // After the records: a file whose delete fails is an orphan, which is
  // harmless; a record pointing at a deleted file is a broken image.
  let filesRemoved = 0, gridfsRemoved = 0;
  const { cleanKey } = require("../src/storage/fileStore");
  for (const rel of p.files) {
    const key = cleanKey(rel.replace(/^uploads\//, ""));
    if (!key) continue;
    for (const st of storesFor(db, store)) {
      if (!(await st.stat(key).catch(() => null))) continue;
      try {
        if (await st.remove(key)) { filesRemoved++; if (st.driver === "mongo") gridfsRemoved++; }
      } catch (err) {
        console.warn(`  could not remove ${key}: ${err.message}`);
      }
    }
  }
  return { transaction, filesRemoved, gridfsRemoved };
}

function print(p, { applied = false, result = null } = {}) {
  console.log(applied
    ? `DELETED school "${p.school.name}" [${p.school._id}]`
    : `DRY RUN — school "${p.school.name}" [${p.school._id}] (nothing written; --apply to delete)`);
  console.log("\nDocuments per collection:");
  for (const [name, n] of Object.entries(p.counts).sort()) console.log(`  ${name.padEnd(32)} ${n}`);
  console.log(`  ${"schools".padEnd(32)} 1`);
  console.log(`\nLogins: ${p.userIds.length} (${p.staffLogins} staff, ${p.userIds.length - p.staffLogins} pupils) — Super Admin never included`);
  console.log(`Portal codes kept but unlinked (they cover a child at another school): ${p.codesUnlinked.length}`);
  console.log(`Uploaded files only this school uses: ${p.files.length}`);
  p.files.forEach((f) => console.log(`  - ${f}`));
  console.log(`  of which in GridFS (this database): ${p.gridfs.files} files, ${(p.gridfs.bytes / 1024 / 1024).toFixed(2)} MB`);
  if (result) console.log(`\n${result.transaction ? "Ran in one transaction." : "No transaction support — ran in order, school record last."} Files removed: ${result.filesRemoved} (GridFS: ${result.gridfsRemoved})`);
}

/** For the command line and the check script alike. */
async function run({ school: arg, apply: doApply = false, confirm = null, uploadsRoot, store: given } = {}) {
  const db = mongoose.connection.db;
  const store = storeFor({ uploadsRoot, store: given });
  const school = await resolveSchool(db, arg);
  const p = await plan(db, school, { store });
  if (!doApply) return { plan: p };
  const typed = typeof confirm === "function" ? await confirm(school.name) : confirm;
  if (typed !== school.name) throw fail("The name typed does not match the school's exact name — nothing deleted");
  const result = await apply(db, p, { store });
  return { plan: p, result };
}

const ask = (name) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`\nThis permanently deletes "${name}" and everything above.\nType the school's exact name to confirm: `,
    (answer) => { rl.close(); resolve(answer); });
});

module.exports = { run, print, resolveSchool };

if (require.main === module) {
  require("dotenv").config();
  const argv  = process.argv.slice(2);
  const at    = argv.indexOf("--school");
  const arg   = at >= 0 ? argv[at + 1] : null;
  const APPLY = argv.includes("--apply");
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    const db = mongoose.connection.db;
    const p  = await plan(db, await resolveSchool(db, arg), { store: storeFor() });
    print(p);
    if (APPLY) {
      const { result } = await run({ school: String(p.school._id), apply: true, confirm: ask });
      print(p, { applied: true, result });
    }
    await mongoose.disconnect();
  })().catch(async (e) => {
    console.error(e.refused ? `Refused: ${e.message}` : e);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
