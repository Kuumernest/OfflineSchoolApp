// backend/scripts/check-name-uniqueness.js
"use strict";

/**
 * One class name per school, one subject name per class — case-insensitively,
 * on every path.
 *
 * The create routes checked an exact name, and nothing else did: a rename, a
 * case difference ("Biology" / "biology") or two requests at once could make
 * two "Form 1"s or two Biologys in Form 1. Now a unique index with a
 * case-insensitive collation (class_name_unique_per_school,
 * subject_name_unique_per_class; db/nameCollation.js) holds the rule, and the
 * routes check the same way first so a duplicate is a 409 with a sentence,
 * never a raw database error. Deleted classes free their name.
 *
 * Real admin routes, in-memory MongoDB with the real indexes.
 *
 *   node scripts/check-name-uniqueness.js
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
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  require(path.join(ROOT, "src/db/models"));
  const M = (n) => mongoose.model(n);
  const db = mongoose.connection.db;

  // ── before the index: duplicates that differ only in case are counted ────
  console.log("--- provisioning counts case-only duplicates ---");
  await db.collection("classes").insertMany([
    { _id: "old-1", schoolId: "s-old", name: "Form 9", deletedAt: null },
    { _id: "old-2", schoolId: "s-old", name: "FORM 9", deletedAt: null },
    { _id: "old-3", schoolId: "s-old", name: "Form 9", deletedAt: new Date() },   // deleted: outside the index
  ]);
  const { provision } = require("./provision-indexes");
  const plan = await provision({ only: ["Class"], log: () => {} });
  check("\"Form 9\" and \"FORM 9\" in one school: 1 group of 2 (the deleted one not counted)",
    plan.rows.find((r) => r.name === "class_name_unique_per_school")?.duplicates, { groups: 1, rows: 2 });
  await db.collection("classes").deleteMany({ schoolId: "s-old" });

  for (const n of mongoose.modelNames()) await M(n).createIndexes();

  // ── a school, an admin, the real routes ──────────────────────────────────
  const A = "school-a", B = "school-b";
  await M("School").collection.insertMany([{ _id: A, name: "A", isActive: true }, { _id: B, name: "B", isActive: true }]);
  await M("User").create({ _id: "adm-a", name: "adm", email: "adm-a@example.test", password: "check-only-password", role: "school_admin", schoolId: A, isActive: true });
  await M("User").create({ _id: "adm-b", name: "adm", email: "adm-b@example.test", password: "check-only-password", role: "school_admin", schoolId: B, isActive: true });
  const auth = require(path.join(ROOT, "middleware/auth"));
  const app = express(); app.use(express.json());
  app.use("/api/admin", auth.authenticate, require(path.join(ROOT, "src/routes/admin.routes")));
  app.use(require(path.join(ROOT, "middleware/errorHandler")));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const tok = { a: jwt.sign({ id: "adm-a", role: "school_admin", schoolId: A }, process.env.JWT_SECRET), b: jwt.sign({ id: "adm-b", role: "school_admin", schoolId: B }, process.env.JWT_SECRET) };
  const call = async (method, p, body, who = "a") => {
    const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tok[who]}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let json = {}; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
  const classId = (r) => r.body?.class?._id || r.body?.serverId;
  const subjectId = (r) => r.body?.subject?._id || r.body?.subject?.id || r.body?.serverId;

  // ═══ classes ═══
  console.log("--- classes ---");
  const f1 = await call("POST", "/classes", { name: "Form 1" });
  check("Form 1 created", f1.status, 201);
  check("  \"form 1\", \" FORM 1 \" in the same school → 409, not created",
    [(await call("POST", "/classes", { name: "form 1" })).status, (await call("POST", "/classes", { name: " FORM 1 " })).status,
     await M("Class").countDocuments({ schoolId: A })], [409, 409, 1]);
  check("  another school may have its own Form 1", (await call("POST", "/classes", { name: "Form 1" }, "b")).status, 201);
  const f2 = await call("POST", "/classes", { name: "Form 2" });
  let r = await call("PUT", `/classes/${classId(f2)}`, { name: "FORM 1" });
  check("renaming Form 2 to \"FORM 1\" → 409 DUPLICATE_NAME, name unchanged",
    [r.status, r.body.code, (await M("Class").findById(classId(f2)).lean()).name], [409, "DUPLICATE_NAME", "Form 2"]);
  r = await call("PUT", `/classes/${classId(f2)}`, { name: "form 2" });
  check("  re-casing its own name is allowed", [r.status, (await M("Class").findById(classId(f2)).lean()).name], [200, "form 2"]);
  await call("PUT", `/classes/${classId(f2)}`, { isActive: false });
  check("  a deactivated class still holds its name", (await call("POST", "/classes", { name: "Form 2" })).status, 409);
  r = await call("DELETE", `/classes/${classId(f2)}`);
  check("  once deleted, the name is free again", [r.status, (await call("POST", "/classes", { name: "Form 2" })).status], [200, 201]);
  const race = await Promise.all([call("POST", "/classes", { name: "Form 3" }), call("POST", "/classes", { name: "form 3" })]);
  check("two requests for one name at once: one created, the other 409 — never a 500 or a second row",
    [race.map((x) => x.status).sort(), await M("Class").countDocuments({ schoolId: A, name: /^form 3$/i })], [[201, 409], 1]);
  let raw = null;
  try { await M("Class").create({ schoolId: A, name: "FORM 1" }); raw = "inserted"; } catch (e) { raw = e.code; }
  check("the database itself refuses a duplicate written past the routes (E11000)", raw, 11000);

  // ═══ subjects ═══
  console.log("--- subjects ---");
  const c1 = classId(f1);
  const c3 = classId(race.find((x) => x.status === 201));
  const bio = await call("POST", "/subjects", { name: "Biology", classId: c1 });
  check("Biology created in Form 1", bio.status, 201);
  check("  \"biology\" in Form 1 → 409", (await call("POST", "/subjects", { name: "biology", classId: c1 })).status, 409);
  const bio3 = await call("POST", "/subjects", { name: "Biology", classId: c3 });
  check("  Biology in another class is fine", bio3.status, 201);
  const chem = await call("POST", "/subjects", { name: "Chemistry", classId: c1 });
  r = await call("PUT", `/subjects/${subjectId(chem)}`, { name: "BIOLOGY" });
  check("renaming Chemistry to \"BIOLOGY\" in Form 1 → 409, unchanged",
    [r.status, r.body.code, (await M("Subject").findById(subjectId(chem)).lean()).name], [409, "DUPLICATE_NAME", "Chemistry"]);
  r = await call("PUT", `/subjects/${subjectId(bio3)}`, { classId: c1 });
  check("  moving the other Biology into Form 1 → 409", r.status, 409);
  r = await call("PUT", `/subjects/${subjectId(chem)}`, { name: "Chemistry", code: "CHM" });
  check("  editing a subject without changing its name is fine", r.status, 200);
  const sRace = await Promise.all([call("POST", "/subjects", { name: "Physics", classId: c1 }), call("POST", "/subjects", { name: "PHYSICS", classId: c1 })]);
  check("two requests for one subject at once: one created, the other 409",
    [sRace.map((x) => x.status).sort(), await M("Subject").countDocuments({ classId: c1, name: /^physics$/i })], [[201, 409], 1]);
  r = await call("DELETE", `/subjects/${subjectId(bio)}`);
  check("a deleted subject's name can be used again in its class",
    [r.status, (await call("POST", "/subjects", { name: "Biology", classId: c1 })).status], [200, 201]);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
