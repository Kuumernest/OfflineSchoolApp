// backend/scripts/check-teacher-profile.js
"use strict";

/**
 * A teacher's profile is stored by the server, and nothing wipes it.
 *
 *   PUT /teacher/profile with the phone's exact payload stores every field
 *     (it used to keep name and email and answer 200 for the rest)
 *   GET /teacher/profile returns it under `data`, flattened, with
 *     profileCompleted — and still returns `teacher` for older builds
 *   a later save with blank fields (an older build, a half-loaded form)
 *     changes nothing it left blank; only `clearFields` clears
 *   unknown fields are ignored; the Staff ID a phone may still send does not
 *     touch the school's staff number
 *   an administrator's edit, signing in again, /auth/me, /teacher/me and the
 *     phone's /sync/pull leave it as it was
 *   another teacher cannot read or write it
 *   a pupil's place of birth and "repeating" are stored and returned
 *
 * Real routes over HTTP, real auth, in-memory MongoDB.
 *
 *   node scripts/check-teacher-profile.js
 */

const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write(`  ok   ${label}\n`); }
  else { fail++; process.stdout.write(`  FAIL ${label}\n       got      ${a}\n       expected ${e}\n`); }
};
const realConsole = { log: console.log, warn: console.warn, error: console.error };
const quiet = async (fn) => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, realConsole); }
};

// What mobile/app/teacher/profile/setup.js sends.
const PHONE_PAYLOAD = {
  name: "Ama Mensah", firstName: "Ama", lastName: "Mensah", gender: "female",
  dateOfBirth: "1990-04-12", nationalId: "GHA-123", staffId: "TYPED-9",
  qualification: "bsc", employmentType: "full_time", joinDate: "2020-09-01",
  yearsOfExperience: "6", previousSchool: "St. Mary's", phone: "+233200000001",
  alternatePhone: "+233200000002", address: "12 Ring Road", city: "Accra", state: "Greater Accra",
  emergencyName: "Kofi Mensah", emergencyPhone: "+233200000003", emergencyRelation: "brother",
  bloodGroup: "O+", medicalConditions: "none", bio: "Maths teacher.", profileCompleted: true,
};
const PROFILE_KEYS = [
  "firstName", "lastName", "gender", "dateOfBirth", "nationalId", "qualification", "employmentType",
  "joinDate", "yearsOfExperience", "previousSchool", "phone", "alternatePhone", "address", "city",
  "state", "emergencyName", "emergencyPhone", "emergencyRelation", "bloodGroup", "medicalConditions", "bio",
];
const pick = (o, keys = PROFILE_KEYS) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? null]));

const main = async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "check-only-refresh-secret";
  process.env.NODE_ENV = "test";
  process.env.DISABLE_LOGIN_RATE_LIMIT = "1";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "teacher-profile" });
  require("../src/db/models");
  const M = (n) => mongoose.model(n);
  const User = M("User");
  await Promise.all([User.init(), M("IdempotencyKey").init(), M("Counter").init()]);
  require("../src/services/email.service").sendEmail = async () => ({ success: true });

  const express = require("express");
  const jwt     = require("jsonwebtoken");
  const auth    = require("../middleware/auth");

  const A = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: A, name: "Alpha", code: "GVA00", email: "a@example.test" });
  const PW = "Check-only-passw0rd";
  const mk = (id, role, extra = {}) => User.create({
    _id: id, name: `${id} name`, email: `${id}@example.test`, password: PW, role, schoolId: A, isActive: true, ...extra,
  });
  await mk("adm", "school_admin");
  await mk("t1", "teacher", { staffNo: "GVA00-STF-001" });
  await mk("t2", "teacher", { staffNo: "GVA00-STF-002" });
  await mk("pupil", "student", { enrollmentNo: "GVA00-2026-001" });
  await M("Student").create({
    _id: "stu-1", userId: "pupil", schoolId: A, studentName: "Yaw Boateng", firstName: "Yaw",
    lastName: "Boateng", enrollmentNo: "GVA00-2026-001", status: "approved",
  });

  const app = express();
  app.use(express.json());
  app.use("/api/auth",    require("../src/routes/auth.routes"));
  app.use("/api",         auth.authenticate, require("../middleware/idempotency"));
  app.use("/api/admin",   auth.authenticate, require("../src/routes/admin.routes"));
  app.use("/api/teacher", auth.authenticate, require("../src/routes/teacher.routes"));
  app.use("/api/student", auth.authenticate, require("../src/routes/students.routes"));
  app.use("/api/sync",    require("../src/routes/sync.routes"));
  app.use(require("../middleware/errorHandler"));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;

  const tokenFor = (id, role) => jwt.sign({ id, role, schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, url, body, as = ["t1", "teacher"]) => {
    const r = await fetch(`${API}${url}`, {
      method,
      headers: { Authorization: `Bearer ${tokenFor(...as)}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, body: json ?? {} };
  };
  const stored = async (id = "t1") => (await User.findById(id).lean())?.teacherProfile ?? null;
  const EXPECTED = pick(PHONE_PAYLOAD);

  try {
    console.log("--- the phone's save is stored ---");
    let r = await quiet(() => call("PUT", "/teacher/profile", PHONE_PAYLOAD));
    check("PUT /teacher/profile answers 200", r.status, 200);
    check("every profile field is stored on the teacher", pick(await stored()), EXPECTED);
    check("and the profile is marked complete", (await stored())?.completed, true);
    check("the reply carries the profile flattened", [pick(r.body.data), r.body.data?.profileCompleted], [EXPECTED, true]);
    check("the typed Staff ID is not stored, and the staff number is untouched",
      [(await stored())?.staffId ?? null, (await User.findById("t1").lean()).staffNo], [null, "GVA00-STF-001"]);

    console.log("--- read back the way the phone reads it ---");
    r = await quiet(() => call("GET", "/teacher/profile"));
    check("GET /teacher/profile returns the profile under data", pick(r.body.data), EXPECTED);
    check("  with profileCompleted true", r.body.data?.profileCompleted, true);
    check("  and still returns teacher (older builds)", typeof r.body.teacher === "object" && r.body.teacher?._id, "t1");

    console.log("--- nothing wipes it ---");
    const blank = Object.fromEntries(Object.keys(PHONE_PAYLOAD).map((k) => [k, ""]));
    r = await quiet(() => call("PUT", "/teacher/profile", { ...blank, name: "Ama Mensah", profileCompleted: false, phone: "+233200000009" }));
    check("a save with blank fields answers 200", r.status, 200);
    check("  changes only the field it filled in",
      pick(await stored()), { ...EXPECTED, phone: "+233200000009" });
    check("  and does not un-complete the profile", (await stored())?.completed, true);
    r = await quiet(() => call("PUT", "/teacher/profile", { name: "Ama Mensah", clearFields: ["medicalConditions", "notAField"] }));
    check("clearFields clears just what it names", [(await stored())?.medicalConditions ?? null, (await stored())?.bio], [null, "Maths teacher."]);
    r = await quiet(() => call("PUT", "/teacher/profile", { name: "Ama Mensah", role: "school_admin", isActive: false, salary: 1 }));
    const after = await User.findById("t1").lean();
    check("fields that are not profile fields are ignored", [after.role, after.isActive, after.salary ?? null], ["teacher", true, null]);
    check("an over-long value is cut to its limit",
      (await quiet(() => call("PUT", "/teacher/profile", { name: "Ama Mensah", phone: "9".repeat(80) })),
        (await stored())?.phone.length), 30);
    await quiet(() => call("PUT", "/teacher/profile", { name: "Ama Mensah", phone: "+233200000009", medicalConditions: "none" }));

    r = await quiet(() => call("PUT", "/admin/teachers/t1", { name: "Ama K. Mensah" }, ["adm", "school_admin"]));
    check("an administrator's edit of the teacher answers 200", r.status, 200);
    check("  and leaves the profile as it was", pick(await stored()), { ...EXPECTED, phone: "+233200000009" });

    r = await quiet(() => fetch(`${API}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "t1@example.test", password: PW }),
    }).then((x) => x.json().then((b) => ({ status: x.status, body: b }))));
    check("the teacher can sign in again", r.status, 200);
    await quiet(() => call("GET", "/auth/me"));
    await quiet(() => call("GET", "/sync/pull"));
    check("signing in, /auth/me and /sync/pull leave the profile as it was",
      pick(await stored()), { ...EXPECTED, phone: "+233200000009" });
    r = await quiet(() => call("GET", "/teacher/me"));
    check("/teacher/me carries the stored profile", r.body.data?.teacherProfile?.qualification, "bsc");

    r = await quiet(() => call("PUT", "/teacher/profile", { qualification: "bsc", city: "Accra" }));
    check("a save of profile fields alone (no name) answers 200 and keeps the name",
      [r.status, (await User.findById("t1").lean()).name], [200, "Ama K. Mensah"]);
    r = await quiet(() => call("PUT", "/teacher/profile", { name: "  " }));
    check("a blank name is refused", r.status, 400);
    r = await quiet(() => call("PUT", "/teacher/profile", {}));
    check("an empty save is refused", r.status, 400);

    console.log("--- one teacher, one profile ---");
    r = await quiet(() => call("GET", "/teacher/profile", undefined, ["t2", "teacher"]));
    check("another teacher reads their own (empty) profile, not this one",
      [r.body.data?.id, r.body.data?.qualification, r.body.data?.profileCompleted], ["t2", null, false]);
    await quiet(() => call("PUT", "/teacher/profile", { name: "t2 name", qualification: "msc" }, ["t2", "teacher"]));
    check("and their save does not touch this one",
      [(await stored("t1"))?.qualification, (await stored("t2"))?.qualification], ["bsc", "msc"]);

    console.log("--- the pupil's place of birth and repeating ---");
    r = await quiet(() => call("PUT", "/student/profile", { placeOfBirth: "Kumasi", isRepeating: true }, ["pupil", "student"]));
    check("PUT /student/profile answers 200", r.status, 200);
    r = await quiet(() => call("GET", "/student/profile", undefined, ["pupil", "student"]));
    check("GET /student/profile returns them", [r.body.data?.placeOfBirth, r.body.data?.isRepeating], ["Kumasi", true]);
    await quiet(() => call("PUT", "/student/profile", { placeOfBirth: "Tamale" }, ["pupil", "student"]));
    r = await quiet(() => call("GET", "/student/profile", undefined, ["pupil", "student"]));
    check("place of birth is fill-only, like date of birth", r.body.data?.placeOfBirth, "Kumasi");
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongo.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
