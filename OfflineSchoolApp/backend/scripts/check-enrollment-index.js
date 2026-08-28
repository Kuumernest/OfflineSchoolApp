// backend/scripts/check-enrollment-index.js
"use strict";

/**
 * Assert that a school can have more than one member of staff.
 *
 * The old unique+sparse index on User.enrollmentNo indexed explicit nulls —
 * and the field defaults to null — so on a fresh database the SECOND teacher
 * or admin could not be created. This pins both halves of the fix: users
 * without a number no longer collide, and real numbers are still unique.
 *
 * Runs against a throwaway in-memory server; never touches MONGODB_URI.
 *
 *   node scripts/check-enrollment-index.js
 */

const path = require("path");
const B = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const check = (l, a, e) => {
  if (JSON.stringify(a) === JSON.stringify(e)) { pass++; console.log("  ok   " + l); }
  else { fail++; console.log(`  FAIL ${l}: got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongoose = require("mongoose");

  const mongod = await MongoMemoryServer.create({
    // The default launch timeout is ten seconds, which is not enough on a
    // developer machine with a browser and an editor open — the suite failed
    // intermittently with "Instance failed to start within 10000ms" and the
    // failure looked like a broken test rather than a busy host.
    instance: { launchTimeout: 180_000 },
  });
  await mongoose.connect(mongod.getUri(), { dbName: "enrollfix" });

  const User = require("../src/db/models/User");
  await User.init();

  const idx = (await User.collection.indexes()).filter(
    (i) => i.key && "enrollmentNo" in i.key
  );
  console.log("indexes on enrollmentNo:");
  idx.forEach((i) => console.log(
    `  ${i.name} unique=${!!i.unique} sparse=${!!i.sparse} partial=${JSON.stringify(i.partialFilterExpression ?? null)}`
  ));
  console.log("");

  check("only one enrollmentNo index", idx.length, 1);
  check("it is the partial one", idx[0].name, "enrollmentNo_unique_present");
  check("old broken index is absent",
    idx.some((i) => i.name === "enrollmentNo_1"), false);

  const staff = (id) => ({
    _id: id, name: id, role: "teacher", schoolId: "s1",
    email: id + "@x.io", password: "fixture-pw-123",
  });

  // The bug: many staff, none with a number.
  await User.create(staff("staff-a"));
  let err = null;
  try { await User.create(staff("staff-b")); } catch (e) { err = e; }
  check("a second staff user can now be created", err, null);

  err = null;
  try { await User.create(staff("staff-c")); } catch (e) { err = e; }
  check("and a third", err, null);

  const nulls = await User.countDocuments({ enrollmentNo: null });
  check("all three stored with a null enrolment number", nulls, 3);

  // Uniqueness for real numbers must still be enforced.
  await User.create({
    _id: "pupil-a", name: "Ada", role: "student", schoolId: "s1",
    email: "pa@x.io", password: "fixture-pw-123", enrollmentNo: "EN-001",
  });
  err = null;
  try {
    await User.create({
      _id: "pupil-b", name: "Bola", role: "student", schoolId: "s1",
      email: "pb@x.io", password: "fixture-pw-123", enrollmentNo: "EN-001",
    });
  } catch (e) { err = e; }
  check("a duplicate REAL enrolment number is still refused", err?.code, 11000);

  err = null;
  try {
    await User.create({
      _id: "pupil-c", name: "Chi", role: "student", schoolId: "s1",
      email: "pc@x.io", password: "fixture-pw-123", enrollmentNo: "EN-002",
    });
  } catch (e) { err = e; }
  check("a distinct enrolment number is accepted", err, null);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
