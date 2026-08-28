// backend/scripts/check-student-tenancy.js
"use strict";

/**
 * Assert that one school cannot write to another school's pupil records.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * Five write routes in admin.routes.js took a pupil id and never asked whose
 * pupil it was:
 *
 *   PATCH  /admin/students/:id/suspend    findOneAndUpdate({ _id })
 *   PATCH  /admin/students/:id/restore    findOneAndUpdate({ _id })
 *   PATCH  /admin/students/:id/move       findByIdAndUpdate(id)
 *   PUT    /admin/students/:id/reject     findOne({ _id })
 *   DELETE /admin/students/:id            findByIdAndUpdate(id)
 *
 * So anybody holding students.manage, students.admit or students.delete could
 * suspend, restore, move, reject or withdraw a child in a school they have
 * nothing to do with. `move` was worse than the others: it also looked its
 * destination class up with Class.findById and no school clause, so a pupil
 * could be moved INTO another school's class — corrupting the register at both
 * ends while reading as a successful move on the screen that did it.
 *
 * The same operations exist in students.routes.js and have always checked, with
 * canAccess() answering 403. Two implementations of one operation, and only one
 * of them was safe: the console happens to call the safe path for suspend,
 * restore and delete, which is why nothing had surfaced.
 *
 * That is the shape this project keeps finding — a guard absent from a route
 * whose sibling has it — and it is the third such fix after announcements and
 * periods. So every assertion below is CROSS-SCHOOL. A single-school test cannot
 * fail on this however carefully it is written, and every test that existed used
 * one school.
 *
 *   node scripts/check-student-tenancy.js
 */

const express  = require("express");
const mongoose = require("mongoose");

const SCHOOL_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SCHOOL_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180_000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "student-tenancy" });

  const Student = require("../src/db/models/Student");
  const Class   = require("../src/db/models/Class");
  const { ROLES } = require("../src/config/roles");
  require("../src/db/models/User");

  /** Who is asking. Mutated between blocks so the school in play stays visible. */
  let actor = {
    _id: "admin-a", id: "admin-a", role: ROLES.SCHOOL_ADMIN,
    schoolId: SCHOOL_A, email: "head@a.com",
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = actor; next(); });
  app.use("/api/admin", require("../src/routes/admin.routes"));

  const server = app.listen(0);
  const port   = server.address().port;

  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try { payload = await res.json(); } catch { /* not every response is json */ }
    return { status: res.status, body: payload };
  };

  const seed = async () => {
    await Student.deleteMany({});
    await Class.deleteMany({});
    await Class.collection.insertMany([
      { _id: "a-cls-1", schoolId: SCHOOL_A, name: "A Form 1", isActive: true,
        deletedAt: null, updatedAt: new Date() },
      { _id: "a-cls-2", schoolId: SCHOOL_A, name: "A Form 2", isActive: true,
        deletedAt: null, updatedAt: new Date() },
      { _id: "b-cls-1", schoolId: SCHOOL_B, name: "B Form 1", isActive: true,
        deletedAt: null, updatedAt: new Date() },
    ]);
    await Student.collection.insertMany([
      { _id: "a-pupil", schoolId: SCHOOL_A, classId: "a-cls-1", studentName: "Ours",
        enrollmentNo: "A-001", status: "approved", isActive: true, deletedAt: null,
        updatedAt: new Date() },
      { _id: "b-pupil", schoolId: SCHOOL_B, classId: "b-cls-1", studentName: "Theirs",
        enrollmentNo: "B-001", status: "approved", isActive: true, deletedAt: null,
        updatedAt: new Date() },
      { _id: "b-pending", schoolId: SCHOOL_B, classId: "b-cls-1", studentName: "Their Applicant",
        enrollmentNo: "B-002", status: "pending", isActive: true, deletedAt: null,
        updatedAt: new Date() },
    ]);
  };

  await seed();
  const theirs = () => Student.findById("b-pupil").lean();

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- suspending, restoring and withdrawing ---");

  // The control: our own pupil works. Without it every assertion below could
  // pass because the route is broken for everybody.
  const own = await call("PATCH", "/api/admin/students/a-pupil/suspend");
  check("suspending our own pupil succeeds", own.status, 200);
  check("and it applied", (await Student.findById("a-pupil").lean())?.status, "suspended");

  // THE ASSERTIONS THIS FILE EXISTS FOR.
  const theirSuspend = await call("PATCH", "/api/admin/students/b-pupil/suspend");
  check("suspending another school's pupil is refused", theirSuspend.status, 404);
  check("and they are untouched", (await theirs())?.status, "approved");
  check("still active", (await theirs())?.isActive, true);

  const theirRestore = await call("PATCH", "/api/admin/students/b-pupil/restore");
  check("restoring another school's pupil is refused", theirRestore.status, 404);

  const theirDelete = await call("DELETE", "/api/admin/students/b-pupil");
  check("withdrawing another school's pupil is refused", theirDelete.status, 404);
  check("and they are still on the register", (await theirs())?.deletedAt, null);
  check("and still active", (await theirs())?.isActive, true);

  // 404 rather than 403, deliberately: somebody outside a school should not
  // learn that one of its pupils exists.
  check("the refusal does not admit the pupil exists", theirSuspend.status, 404);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- moving a pupil between classes ---");

  const moveOwn = await call("PATCH", "/api/admin/students/a-pupil/move",
    { classId: "a-cls-2" });
  check("moving our own pupil within our school succeeds", moveOwn.status, 200);
  check("and it applied", (await Student.findById("a-pupil").lean())?.classId, "a-cls-2");

  const moveTheirs = await call("PATCH", "/api/admin/students/b-pupil/move",
    { classId: "a-cls-1" });
  check("moving another school's pupil is refused", moveTheirs.status, 404);
  check("and they stay where they were", (await theirs())?.classId, "b-cls-1");

  /**
   * THE WORST OF THE FIVE. The destination class was looked up with
   * Class.findById and no school clause, so our own pupil could be moved into
   * another school's class — a register corrupted at both ends, reported as a
   * successful move.
   */
  const moveIntoTheirClass = await call("PATCH", "/api/admin/students/a-pupil/move",
    { classId: "b-cls-1" });
  check("moving our pupil into another school's class is refused",
    moveIntoTheirClass.status, 400);
  check("and our pupil has not moved",
    (await Student.findById("a-pupil").lean())?.classId, "a-cls-2");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- rejecting an application ---");

  const rejectTheirs = await call("PUT", "/api/admin/students/b-pending/reject",
    { reason: "no" });
  check("rejecting another school's applicant is refused",
    rejectTheirs.status >= 400, true);
  check("and their application still stands",
    (await Student.findById("b-pending").lean())?.status, "pending");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a super_admin still crosses schools, which is the point of it ---");

  actor = { _id: "root", id: "root", role: ROLES.SUPER_ADMIN, schoolId: null, email: "root@x.com" };

  const rootSuspend = await call("PATCH", "/api/admin/students/b-pupil/suspend");
  check("a super_admin may suspend any school's pupil", rootSuspend.status, 200);
  check("which really applied", (await theirs())?.status, "suspended");

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  try { await mongo.stop(); } catch { /* a lingering temp process is not a result */ }

  console.log(`\n  ${pass} passed, ${fail} failed`);
};

main()
  .catch((err) => { console.error("\nHarness error:", err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
