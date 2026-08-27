// backend/scripts/check-staff-lifecycle.js
"use strict";

/**
 * Assert that a staff account can be removed and added again.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Because it could not. Removing a bursar or a teacher DEACTIVATES the row —
 * correctly, since payments and marks reference it — and both list endpoints
 * hid inactive rows, while both create endpoints refused any email already in
 * the collection. So the person vanished from the screen and their email stayed
 * permanently spent: "Email already registered", pointing at a row nobody could
 * see. The only repair was a database edit.
 *
 * Every assertion below is a step in that story, plus the three ways a reclaim
 * must still be refused. It runs against the REAL router over HTTP rather than
 * calling the helpers directly, because the helpers were never the bug — the
 * order of checks inside the handlers was, and only a request exercises that.
 *
 * ── The three refusals ────────────────────────────────────────────────────
 *
 * They matter as much as the reclaim. Reactivating whatever row happens to
 * carry the address would be worse than the 409: it could hand a school
 * somebody else's tenant row, convert a removed teacher into a bursar while
 * their subject assignments carried on pointing at them, or let a school admin
 * resurrect a platform super_admin as their own staff member.
 *
 *   node scripts/check-staff-lifecycle.js
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
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "staff-lifecycle" });

  const User = require("../src/db/models/User");
  const { ROLES } = require("../src/config/roles");

  // Whoever the request is made as. Mutated between blocks rather than starting
  // a second server, so the school and role in play are always visible right
  // next to the assertions that depend on them.
  let actor = {
    _id: "admin-1", id: "admin-1", role: ROLES.SCHOOL_ADMIN,
    schoolId: SCHOOL_A, email: "head@schoola.com",
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = actor; next(); });
  app.use("/api/admin", require("../src/routes/admin.routes"));

  const server = app.listen(0);
  const port   = server.address().port;

  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin${p}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json ?? {} };
  };

  // ═══════════════════════════════════════════════════════════════════════
  // The reported bug: remove a bursar, add them again
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a removed bursar can be added again ---");

  const created = await call("POST", "/settings/admins", {
    name: "Grace Mbeki", email: "Grace.Mbeki@schoola.com",
    role: "bursar", schoolId: SCHOOL_A,
  });
  check("creating a bursar answers 201", created.status, 201);
  const bursarId = created.body?.admin?._id ?? null;
  check("and returns the account", typeof bursarId, "string");
  check("with a password the caller can pass on",
    typeof created.body?.tempPassword === "string" && created.body.tempPassword.length > 0, true);
  check("and says it was a creation, not a restore", created.body?.restored, false);

  const removed = await call("DELETE", `/settings/admins/${bursarId}`);
  check("removing them succeeds", removed.status, 200);

  const stillThere = await User.findById(bursarId).lean();
  check("the row survives, deactivated — the audit trail depends on it",
    { exists: !!stillThere, active: stillThere?.isActive }, { exists: true, active: false });

  const afterRemoval = await call("GET", `/settings/admins?schoolId=${SCHOOL_A}`);
  check("and drops out of the default list",
    afterRemoval.body?.admins?.some((a) => a._id === bursarId), false);

  // THE BUG. This answered 409 "Email already registered".
  const readded = await call("POST", "/settings/admins", {
    name: "Grace Mbeki", email: "grace.mbeki@schoola.com",
    role: "bursar", schoolId: SCHOOL_A,
  });
  check("adding them back succeeds instead of 409", readded.status, 200);
  check("and says so plainly", readded.body?.restored, true);
  check("reusing the SAME row, so payments they recorded still resolve",
    readded.body?.admin?._id, bursarId);
  check("with a fresh password, since nobody held the old one",
    typeof readded.body?.tempPassword === "string" && readded.body.tempPassword.length > 0, true);
  check("and must be changed on first sign-in",
    readded.body?.admin?.mustResetPassword, true);

  const reborn = await User.findById(bursarId).select("+password").lean();
  check("the account is live again", reborn?.isActive, true);
  check("the new password is HASHED, not stored as typed",
    reborn?.password?.startsWith("$2"), true);
  check("and is the one that was returned",
    await require("bcryptjs").compare(readded.body.tempPassword, reborn.password), true);

  // ═══════════════════════════════════════════════════════════════════════
  // Seeing dormant accounts at all
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- dormant accounts are visible when asked for ---");

  await call("DELETE", `/settings/admins/${bursarId}`);

  const activeOnly = await call("GET", `/settings/admins?schoolId=${SCHOOL_A}`);
  check("default is active only, so pickers and counts are unaffected",
    activeOnly.body?.admins?.some((a) => a._id === bursarId), false);

  const inactiveOnly = await call("GET", `/settings/admins?schoolId=${SCHOOL_A}&status=inactive`);
  check("status=inactive finds the removed account",
    inactiveOnly.body?.admins?.map((a) => a._id), [bursarId]);

  const all = await call("GET", `/settings/admins?schoolId=${SCHOOL_A}&status=all`);
  check("status=all includes it",
    all.body?.admins?.some((a) => a._id === bursarId), true);

  // ═══════════════════════════════════════════════════════════════════════
  // Still refused: an account somebody is using
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- an email in active use is still refused ---");

  const live = await call("POST", "/settings/admins", {
    name: "Paul Etoa", email: "paul@schoola.com", role: "school_admin", schoolId: SCHOOL_A,
  });
  check("a second admin is created", live.status, 201);

  const dupe = await call("POST", "/settings/admins", {
    name: "Someone Else", email: "paul@schoola.com", role: "bursar", schoolId: SCHOOL_A,
  });
  check("their email cannot be taken", dupe.status, 409);
  check("with the message it always had", dupe.body?.message, "Email already registered");

  // ═══════════════════════════════════════════════════════════════════════
  // Still refused: another school's row
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- another school's dormant row is not reclaimable ---");

  await User.create({
    name: "Other School Bursar", email: "shared@example.com",
    role: ROLES.BURSAR, schoolId: SCHOOL_B, isActive: false,
    password: "not-a-real-password",
  });

  const crossTenant = await call("POST", "/settings/admins", {
    name: "Grace Two", email: "shared@example.com", role: "bursar", schoolId: SCHOOL_A,
  });
  check("school A cannot reclaim school B's account", crossTenant.status, 409);
  // Deliberately the same wording as an active clash: school A cannot act on
  // the row either way and has no business learning who holds the address.
  check("and is told nothing about where it lives",
    crossTenant.body?.message, "Email already registered");

  const untouched = await User.findOne({ email: "shared@example.com" }).lean();
  check("school B's row is not modified",
    { school: String(untouched.schoolId), active: untouched.isActive },
    { school: SCHOOL_B, active: false });

  // ═══════════════════════════════════════════════════════════════════════
  // Still refused: the wrong kind of account
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a dormant teacher is not silently converted ---");

  const teacher = await call("POST", "/teachers", {
    name: "Ngassa Fru", email: "ngassa@schoola.com", schoolId: SCHOOL_A,
  });
  check("a teacher is created", teacher.status, 201);
  const teacherId = teacher.body?.teacher?._id ?? null;

  await call("DELETE", `/teachers/${teacherId}`);

  const convert = await call("POST", "/settings/admins", {
    name: "Ngassa Fru", email: "ngassa@schoola.com", role: "bursar", schoolId: SCHOOL_A,
  });
  check("the office screen refuses to turn them into a bursar", convert.status, 409);
  check("and says where the account actually is",
    /removed teacher account/.test(convert.body?.message ?? ""), true);

  const notConverted = await User.findById(teacherId).lean();
  check("their role is unchanged",
    { role: notConverted.role, active: notConverted.isActive },
    { role: "teacher", active: false });

  // ...but the teachers screen itself can bring them back.
  console.log("--- the teachers screen can bring them back ---");

  const teacherInactive = await call("GET", `/teachers?schoolId=${SCHOOL_A}&status=inactive`);
  check("status=inactive finds the removed teacher — the filter the web screen "
      + "has shipped since it was written, against a query that hard-coded active",
    teacherInactive.body?.teachers?.map((x) => x._id), [teacherId]);

  const teacherBack = await call("POST", "/teachers", {
    name: "Ngassa Fru", email: "ngassa@schoola.com", schoolId: SCHOOL_A,
  });
  check("adding the teacher again restores them", teacherBack.status, 200);
  check("saying so", teacherBack.body?.restored, true);
  check("on the same row, so their marks still resolve",
    teacherBack.body?.teacher?._id, teacherId);
  check("with a password the caller is given",
    typeof teacherBack.body?.tempPassword === "string" && teacherBack.body.tempPassword.length > 0, true);

  // ═══════════════════════════════════════════════════════════════════════
  // Still refused: a platform account
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a school admin cannot reclaim a dormant super_admin ---");

  await User.create({
    name: "Platform Owner", email: "owner@platform.com",
    role: ROLES.SUPER_ADMIN, schoolId: SCHOOL_A, isActive: false,
    password: "not-a-real-password",
  });

  const grab = await call("POST", "/settings/admins", {
    name: "Platform Owner", email: "owner@platform.com", role: "bursar", schoolId: SCHOOL_A,
  });
  check("refused", grab.status, 409);
  const platform = await User.findOne({ email: "owner@platform.com" }).lean();
  check("the platform account is untouched",
    { role: platform.role, active: platform.isActive },
    { role: ROLES.SUPER_ADMIN, active: false });

  // A super_admin may, which is the point of the distinction.
  actor = { ...actor, _id: "root-1", id: "root-1", role: ROLES.SUPER_ADMIN };
  const rootGrab = await call("POST", "/settings/admins", {
    name: "Platform Owner", email: "owner@platform.com",
    role: "super_admin", schoolId: SCHOOL_A,
  });
  check("a super_admin can", rootGrab.status, 200);
  check("as a restore of the same account", rootGrab.body?.restored, true);
  check("keeping the role", rootGrab.body?.admin?.role, ROLES.SUPER_ADMIN);

  // ═══════════════════════════════════════════════════════════════════════
  // An address the route accepts must survive the save
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the route and the model agree on what an email is ---");

  // Not a regex unit test: the failure being pinned is that the two validators
  // DISAGREED, so a POST could pass the 400 check and then throw at save() and
  // reach the caller as a 500. Only a real request proves they line up.
  const shapes = [
    ["a long TLD",       "head@stmarys.school"     ],
    ["a longer one",     "bursar@lycee.africa"     ],
    ["a +tag",           "head+bursar@gmail.com"   ],
    ["a two-letter TLD", "principal@school.cm"     ],
    ["a second level",   "office@school.co.uk"     ],
  ];

  const rejected = [];
  for (const [what, email] of shapes) {
    const r = await call("POST", "/settings/admins", {
      name: "Shape Test", email, role: "bursar", schoolId: SCHOOL_A,
    });
    if (r.status !== 201) rejected.push(`${what} (${email}) -> ${r.status} ${r.body?.message ?? ""}`);
  }
  check("every ordinary address shape is accepted", rejected, []);

  // And a malformed one is still a 400 from the route, never a 500 from save().
  const malformed = [];
  for (const email of ["no-at-sign.com", "two@@at.com", "spaces in@name.com", "nodomain@nodot"]) {
    const r = await call("POST", "/settings/admins", {
      name: "Shape Test", email, role: "bursar", schoolId: SCHOOL_A,
    });
    if (r.status !== 400) malformed.push(`${email} -> ${r.status}`);
  }
  check("and a malformed one is a 400, not a 500", malformed, []);

  check("the model validates with the shared rule, not its own",
    String(User.schema.path("email").validators.find((v) => v.type === "regexp")?.regexp),
    String(require("../src/utils/email").EMAIL_REGEX));

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongo.stop();
  process.exit(fail ? 1 : 0);
};

main().catch(async (err) => {
  console.error("\nHarness error:", err);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
