// backend/scripts/check-sync-overwrites.js
"use strict";

/**
 * An edit that silently replaced somebody else's must reach THAT somebody.
 *
 * Student records are last-write-wins (docs/11-conflict-resolution.md, an owner
 * decision that stays). The condition attached to it is that the losing write
 * leaves a trace and the person who lost it is told. logOverwriteIfNeeded wrote
 * the trace — a SyncOverwrite naming the previous editor as the loser — but:
 *
 *   - nothing ever read it back: no route listed SyncOverwrite, seenByLoser was
 *     never set, so the loser was never told;
 *   - the edit route answered `overwrote: { id: overwrote._id }` while the
 *     helper returns `{ id }`, so the winner's copy had no id at all;
 *   - the edit route applied the new values to the document BEFORE taking the
 *     snapshot, so `lostVersion` held the winner's values, not the loser's.
 *
 * Two administrators, Ama and Kofi. Ama corrects a pupil; Kofi, working from
 * the version before Ama's, overwrites it. Ama — not Kofi — must see it, with
 * her own values in the snapshot, and be able to mark it seen.
 *
 * Siblings (CLAUDE.md): the pupil has two brothers on the same guardian. They
 * are untouched by all this and never appear as overwrites.
 *
 *   node scripts/check-sync-overwrites.js
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
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 15));

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const User          = mongoose.model("User");
  const Student       = mongoose.model("Student");
  const Class         = mongoose.model("Class");
  const SyncOverwrite = mongoose.model("SyncOverwrite");
  const Notification  = mongoose.model("Notification");
  const permissions   = require(path.join(SRC, "services/permissions.service"));

  const A = "5c0e2e0000000000000000a1";
  const B = "5c0e2e0000000000000000b2";
  await mongoose.model("School").create({ _id: A, name: "Overwrite School", code: "OVW", email: "ovw@example.test" });
  await mongoose.model("School").create({ _id: B, name: "Other School", code: "OTH", email: "oth@example.test" });
  const mkUser = (id, role, schoolId, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: "check-only-password",
    role, schoolId, isActive: true,
  });
  await mkUser("adm-ama",  "school_admin", A, "Ama Owusu");
  await mkUser("adm-kofi", "school_admin", A, "Kofi Mensah");
  await mkUser("bur-a",    "bursar",       A, "Bursar A");
  await mkUser("tea-a",    "teacher",      A, "Teacher A");
  await mkUser("adm-b",    "school_admin", B, "Registrar B");
  await Class.create({ _id: "cls-a", schoolId: A, name: "Form 1" });
  await Class.create({ _id: "cls-a2", schoolId: A, name: "Form 2" });

  // Three children of one guardian: same name, email and phone. Normal data.
  const guardian = { guardianName: "Esi Boateng", guardianEmail: "esi@family.test", guardianPhone: "670000001" };
  const kid = (id, first, no) => Student.create({
    _id: id, userId: `u-${id}`, schoolId: A, classId: "cls-a", firstName: first, lastName: "Boateng",
    studentName: `${first} Boateng`, enrollmentNo: no, status: "approved", isActive: true,
    email: "esi@family.test", ...guardian,
  });
  await kid("st-1", "Kwesi", "E-1");
  await kid("st-2", "Yaw",   "E-2");
  await kid("st-3", "Akua",  "E-3");
  await Student.create({ _id: "st-b", userId: "u-st-b", schoolId: B, studentName: "Other School", enrollmentNo: "B-1", status: "approved", isActive: true });

  const app = express();
  app.use(express.json());
  const auth = require(path.join(ROOT, "middleware/auth"));
  app.use("/api/students", auth.authenticate, require(path.join(SRC, "routes/students.routes")));
  app.use("/api/sync",     auth.authenticate, require(path.join(SRC, "routes/sync.routes")));
  app.use(require(path.join(ROOT, "middleware/errorHandler")));
  const server = app.listen(0);
  server.keepAliveTimeout = 120_000;
  const port = server.address().port;

  const tok = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const TOK = {
    ama: tok("adm-ama", "school_admin", A), kofi: tok("adm-kofi", "school_admin", A),
    bursar: tok("bur-a", "bursar", A), teacher: tok("tea-a", "teacher", A), adminB: tok("adm-b", "school_admin", B),
  };
  const call = async (who, method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { Authorization: `Bearer ${TOK[who]}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch { /* none */ }
    return { status: res.status, body: out };
  };
  const updatedAt = async (id) => (await Student.findById(id).lean()).updatedAt.toISOString();
  const mine = async (who, q = "") => {
    const r = await call(who, "GET", `/api/sync/overwrites/mine${q}`);
    return { status: r.status, list: r.body?.data?.overwrites ?? r.body?.overwrites ?? null, unseen: r.body?.data?.unseenCount ?? null };
  };

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 1. Kofi overwrites Ama's correction ---");
  const base1 = await updatedAt("st-1");          // what Kofi's screen loaded
  await tick();
  const amaEdit = await call("ama", "PATCH", "/api/students/st-1", { address: "4 Palm St" });
  check("Ama's correction is saved", [amaEdit.status, amaEdit.body?.overwrote ?? null], [200, null]);
  await tick();
  const kofiEdit = await call("kofi", "PATCH", "/api/students/st-1", { address: "9 Oak Ave", baseUpdatedAt: base1 });
  check("Kofi's edit still applies (last write wins)", [kofiEdit.status, (await Student.findById("st-1").lean()).address], [200, "9 Oak Ave"]);

  const rows = await SyncOverwrite.find({ entityId: "st-1" }).lean();
  check("one overwrite recorded", rows.length, 1);
  const row = rows[0] || {};
  check("the response carries the overwrite's id (was always undefined)", kofiEdit.body?.overwrote?.id ?? null, row._id ?? "row");
  check("the loser recorded is Ama, the previous editor", [row.lostEditBy, row.lostEditByName], ["adm-ama", "Ama Owusu"]);
  check("the winner recorded is Kofi, the requester", [row.overwrittenBy, row.overwrittenByName, row.newAction], ["adm-kofi", "Kofi Mensah", "edit"]);
  check("the snapshot is Ama's version, not Kofi's", row.lostVersion?.address ?? null, "4 Palm St");
  check("the winner is told whose change he replaced", kofiEdit.body?.overwrote?.lostEditByName ?? null, "Ama Owusu");

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 2. the loser sees it; the winner does not ---");
  const amaList = await mine("ama");
  check("Ama's list: 200, one entry", [amaList.status, amaList.list?.length ?? null], [200, 1]);
  const item = amaList.list?.[0] || {};
  check("with the right ids", [item.id, item.entityId, item.entityType, item.overwrittenByName, item.newAction], [row._id, "st-1", "student", "Kofi Mensah", "edit"]);
  check("unseen, and counted", [item.seenByLoser, amaList.unseen], [false, 1]);
  check("her lost version is shown in full (she holds students.viewFull)", [item.lostVersion?.address, item.lostVersion?.guardianEmail, item.lostVersion?.firstName], ["4 Palm St", "esi@family.test", "Kwesi"]);
  const kofiList = await mine("kofi");
  check("Kofi's list is empty", [kofiList.status, kofiList.list?.length ?? null, kofiList.unseen], [200, 0, 0]);
  check("another school's admin sees nothing", (await mine("adminB")).list?.length ?? null, 0);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 3. the school view is for those who manage students ---");
  const schoolView = await call("kofi", "GET", "/api/sync/overwrites");
  check("an administrator lists the school's overwrites", [schoolView.status, (schoolView.body?.data?.overwrites ?? []).map((o) => o.id)], [200, [row._id]]);
  check("the bursar may not", (await call("bursar", "GET", "/api/sync/overwrites")).status, 403);
  check("a teacher may not", (await call("teacher", "GET", "/api/sync/overwrites")).status, 403);
  const otherSchool = await call("adminB", "GET", `/api/sync/overwrites?schoolId=${A}`);
  check("another school's admin, naming this school, gets nothing of it", (otherSchool.body?.data?.overwrites ?? []).length, 0);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 4. marking seen ---");
  check("Kofi cannot mark Ama's alert seen", (await call("kofi", "POST", `/api/sync/overwrites/${row._id}/seen`)).status, 404);
  check("nor can another school", (await call("adminB", "POST", `/api/sync/overwrites/${row._id}/seen`)).status, 404);
  check("still unseen", (await SyncOverwrite.findById(row._id).lean()).seenByLoser, false);
  const seen = await call("ama", "POST", `/api/sync/overwrites/${row._id}/seen`);
  check("Ama marks it seen", seen.status, 200);
  const after = await SyncOverwrite.findById(row._id).lean();
  check("stored as seen, with a time", [after.seenByLoser, after.seenAt instanceof Date], [true, true]);
  check("her unseen list is empty, her full list keeps it", [(await mine("ama", "?unseen=1")).list?.length, (await mine("ama")).unseen, (await mine("ama")).list?.length], [0, 0, 1]);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 5. suspend, move and delete carry the id too ---");
  {
    const b = await updatedAt("st-1");
    await tick();
    await call("ama", "PATCH", "/api/students/st-1", { city: "Kumasi" });   // Ama again
    await tick();
    const sus = await call("kofi", "PATCH", `/api/students/st-1/suspend?baseUpdatedAt=${encodeURIComponent(b)}`);
    const r = await SyncOverwrite.findOne({ entityId: "st-1", newAction: "suspend" }).lean();
    check("suspend: id matches the row, loser Ama", [sus.body?.overwrote?.id, r?.lostEditBy, r?.lostVersion?.city], [r?._id, "adm-ama", "Kumasi"]);
    const b2 = await updatedAt("st-1");
    await tick();
    await call("ama", "PATCH", "/api/students/st-1/restore");
    await tick();
    const mv = await call("kofi", "PATCH", `/api/students/st-1/move?baseUpdatedAt=${encodeURIComponent(b2)}`, { classId: "cls-a2" });
    const m = await SyncOverwrite.findOne({ entityId: "st-1", newAction: "move" }).lean();
    check("move: id matches the row, loser Ama", [mv.body?.overwrote?.id, m?.lostEditBy], [m?._id, "adm-ama"]);
    check("Ama now has two unseen", (await mine("ama")).unseen, 2);
    await call("ama", "POST", "/api/sync/overwrites/seen-all");
    check("seen-all clears hers", (await mine("ama")).unseen, 0);
    check("…and nobody else's (none of Kofi's rows touched)", await SyncOverwrite.countDocuments({ seenByLoser: true, lostEditBy: { $ne: "adm-ama" } }), 0);
    const b3 = await updatedAt("st-1");
    await tick();
    await call("ama", "PATCH", "/api/students/st-1", { city: "Takoradi" });
    await tick();
    const del = await call("kofi", "DELETE", `/api/students/st-1?baseUpdatedAt=${encodeURIComponent(b3)}`);
    const d = await SyncOverwrite.findOne({ entityId: "st-1", newAction: "delete" }).lean();
    check("delete: id matches the row, loser Ama, her version kept", [del.status, del.body?.overwrote?.id, d?.lostEditBy, d?.lostVersion?.city], [200, d?._id, "adm-ama", "Takoradi"]);
    check("Ama is told of the deletion", (await mine("ama", "?unseen=1")).list?.map((o) => o.newAction), ["delete"]);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 6. no false alarms ---");
  {
    const before = await SyncOverwrite.countDocuments({});
    // Editing your own work from an old baseline is not an overwrite.
    const b = await updatedAt("st-2");
    await tick();
    await call("ama", "PATCH", "/api/students/st-2", { city: "Accra" });
    await tick();
    const self = await call("ama", "PATCH", "/api/students/st-2", { city: "Tema", baseUpdatedAt: b });
    check("overwriting yourself records nothing", [self.body?.overwrote ?? null, await SyncOverwrite.countDocuments({})], [null, before]);
    // A fresh baseline is not an overwrite either.
    const fresh = await call("kofi", "PATCH", "/api/students/st-2", { city: "Ho", baseUpdatedAt: await updatedAt("st-2") });
    check("an edit from the current version records nothing", [fresh.body?.overwrote ?? null, await SyncOverwrite.countDocuments({})], [null, before]);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 7. siblings are unaffected ---");
  {
    const sibs = await Student.find({ _id: { $in: ["st-2", "st-3"] } }).sort({ _id: 1 }).lean();
    check("both brothers keep the shared guardian", sibs.map((s) => [s.guardianName, s.guardianEmail, s.guardianPhone]),
      [["Esi Boateng", "esi@family.test", "670000001"], ["Esi Boateng", "esi@family.test", "670000001"]]);
    check("no overwrite names a sibling", await SyncOverwrite.countDocuments({ entityId: { $in: ["st-2", "st-3"] } }), 0);
    const ids = new Set(((await mine("ama")).list ?? []).map((o) => o.entityId));
    check("Ama's alerts are all about the one child Kofi overwrote", [...ids], ["st-1"]);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 8. the snapshot follows the permission to read the student ---");
  {
    // The bursar is delegated students.manage, edits, and is overwritten. The
    // bursar reads the roster (students.view) but not the full record.
    await permissions.setRolePermissions({ schoolId: A, role: "bursar",
      desired: [...(await permissions.effectiveFor("bursar", A)), "students.manage"] });
    const b = await updatedAt("st-3");
    await tick();
    const bur = await call("bursar", "PATCH", "/api/students/st-3", { address: "12 Market Rd" });
    check("the bursar's delegated edit is saved", bur.status, 200);
    await tick();
    await call("kofi", "PATCH", "/api/students/st-3", { address: "Somewhere else", baseUpdatedAt: b });
    const bl = await mine("bursar");
    const lv = bl.list?.[0]?.lostVersion ?? {};
    check("the bursar sees the alert", [bl.list?.length, bl.list?.[0]?.entityId], [1, "st-3"]);
    check("…with the roster fields only (no guardian contact, no address)",
      [lv.studentName ?? null, lv.guardianPhone ?? null, lv.address ?? null], ["Akua Boateng", null, null]);

    // A teacher delegated students.manage reads no roster at all.
    await permissions.setRolePermissions({ schoolId: A, role: "teacher",
      desired: [...(await permissions.effectiveFor("teacher", A)), "students.manage"] });
    const b2 = await updatedAt("st-3");
    await tick();
    await call("teacher", "PATCH", "/api/students/st-3", { city: "Cape Coast" });
    await tick();
    await call("kofi", "PATCH", "/api/students/st-3", { city: "Elmina", baseUpdatedAt: b2 });
    const tl = await mine("teacher");
    check("the teacher sees the alert, but no snapshot", [tl.list?.length, tl.list?.[0]?.lostVersion ?? null, tl.list?.[0]?.entityName], [1, null, "Akua Boateng"]);
    check("the bursar's list did not grow", (await mine("bursar")).list?.length, 1);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 9. staff alerts are not family notifications ---");
  // The Notification collection is the delivery queue to guardians (email /
  // SMS) and the portal reads it. An admin-to-admin alert there would be sent
  // to — or shown to — the family.
  check("no Notification row was written", await Notification.countDocuments({}), 0);

  await server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
