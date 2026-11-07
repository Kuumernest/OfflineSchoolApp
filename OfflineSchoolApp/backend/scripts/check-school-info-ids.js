// backend/scripts/check-school-info-ids.js
"use strict";

/**
 * The phone's school-info routes answer for every school id the data holds.
 *
 *   GET /admin/school-info     (administrators; the phone and the web)
 *   GET /teacher/school/info   (teachers; the phone)
 *
 * School._id is an ObjectId in the schema, but the account side keeps the
 * school as a STRING (User.schoolId, and every record's schoolId), and rows
 * written outside Mongoose — imports, older seeds — can carry a school whose
 * _id is a plain string. Both routes did School.findById(id): for such a
 * school that throws a cast error (500 here, a bare 400 behind the global
 * handler) and the logo probe, built only for an ObjectId, said "no logo".
 * Now the school is found by the id as stored, whatever its type, and an id
 * that names no school is a 404.
 *
 *   node scripts/check-school-info-ids.js
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

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "school-info-ids" });
  require(path.join(SRC, "db/models"));
  const User = mongoose.model("User");
  const School = mongoose.model("School");

  const OID = "5c0e2e0000000000000000a9", STR = "school-legacy-7";
  const LOGO = "data:image/png;base64," + "A".repeat(2000);
  await School.create({ _id: OID, name: "Object School", code: "OBJ", email: "obj@example.test", logo: LOGO });
  // Written outside Mongoose, as an import would: a string _id.
  await School.collection.insertOne({ _id: STR, name: "Legacy School", code: "LEG", email: "leg@example.test", logo: LOGO, isActive: true, createdAt: new Date(), updatedAt: new Date() });

  const mk = (id, role, schoolId) => User.create({ _id: id, name: id, email: `${id}@example.test`, password: "check-only-password", role, schoolId, isActive: true });
  await mk("adm-o", "school_admin", OID); await mk("adm-s", "school_admin", STR);
  await mk("tea-o", "teacher", OID);      await mk("tea-s", "teacher", STR);
  await mk("root", "super_admin", null);

  const auth = require(path.join(ROOT, "middleware/auth"));
  const app = express(); app.use(express.json());
  app.use("/api/admin", auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
  app.use("/api/teacher", auth.authenticate, require(path.join(SRC, "routes/teacher.routes")));
  app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const port = server.address().port;
  const tok = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET);
  const get = async (t, p) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { headers: { Authorization: `Bearer ${t}` } });
    let body = {}; try { body = await r.json(); } catch {}
    const school = body.school ?? body.data?.school ?? null;
    return { status: r.status, name: school?.name ?? null, logoLen: school?.logoLen ?? null, logo: school?.logo ? school.logo.length : null };
  };

  for (const [label, sid, adm, tea] of [["ObjectId", OID, "adm-o", "tea-o"], ["string", STR, "adm-s", "tea-s"]]) {
    console.log(`--- a school with a ${label} _id ---`);
    const name = label === "string" ? "Legacy School" : "Object School";
    const A = tok(adm, "school_admin", sid), T = tok(tea, "teacher", sid);
    check("admin, light: 200 with the name and the logo fingerprint", await get(A, `/admin/school-info?schoolId=${sid}`),
      { status: 200, name, logoLen: LOGO.length, logo: null });
    check("admin, with the logo", (await get(A, `/admin/school-info?schoolId=${sid}&includeLogo=1`)).logo, LOGO.length);
    check("teacher, light: 200 with the name and the logo fingerprint", await get(T, "/teacher/school/info"),
      { status: 200, name, logoLen: LOGO.length, logo: null });
    check("teacher, with the logo", (await get(T, "/teacher/school/info?includeLogo=1")).logo, LOGO.length);
  }

  console.log("--- a super_admin naming a school ---");
  const R = tok("root", "super_admin", null);
  // (A super_admin naming a string-_id school is stopped earlier, at the door —
  // middleware/auth.js lookupSchool — outside this route; recorded, not fixed here.)
  check("by an ObjectId", (await get(R, `/admin/school-info?schoolId=${OID}`)).name, "Object School");
  check("an id that names no school: 404, not 500", (await get(R, "/admin/school-info?schoolId=no-such-school")).status, 404);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
