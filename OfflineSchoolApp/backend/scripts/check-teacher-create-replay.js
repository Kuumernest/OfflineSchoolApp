// backend/scripts/check-teacher-create-replay.js
"use strict";

/**
 * A teacher create that names an existing account is a replay, and changes
 * nothing.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * POST /admin/teachers reclaims a REMOVED teacher whose email it is given:
 * reactivated, a new temporary password, a welcome email. That is right for
 * the console's deliberate "add them again", and wrong for a phone. A phone
 * sends the id it made offline, and an old build could still POST a teacher
 * it had already synced — and, if that teacher had since been removed, the
 * stray POST brought them back. The handler now answers any id that already
 * names a teacher of this school as a replay, and refuses any id that names
 * somebody else, before the email claim is even looked at.
 *
 * Runs over HTTP against the real router and the real Idempotency-Key
 * middleware, with the mail service stubbed so every send is counted.
 *
 *   node scripts/check-teacher-create-replay.js
 */

const { stopQuietly } = require("./stopQuietly");

const express  = require("express");
const mongoose = require("mongoose");
const path     = require("path");

const SRC = path.join(__dirname, "..", "src");

const SCHOOL_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SCHOOL_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180_000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "teacher-create-replay" });

  require(path.join(SRC, "db/models"));
  const User           = mongoose.model("User");
  const IdempotencyKey = require(path.join(SRC, "db/models/IdempotencyKey"));
  await Promise.all([User.init(), IdempotencyKey.init()]);

  // Stubbed before the router binds to it (admin.routes destructures sendEmail
  // at require time). Every send is recorded; none leaves the process.
  const sent = [];
  const emailService = require(path.join(SRC, "services/email.service"));
  emailService.sendEmail = async (msg) => { sent.push(msg); return { success: true }; };

  const PASSWORD = "Check-only-passw0rd";
  const mk = (id, role, schoolId, extra = {}) => User.create({
    _id: id, name: `${id} name`, email: `${id}@example.test`, password: PASSWORD,
    role, schoolId, isActive: true, ...extra,
  });
  await mk("teacher-live",    "teacher", SCHOOL_A);
  await mk("teacher-removed", "teacher", SCHOOL_A, { isActive: false });
  await mk("teacher-other",   "teacher", SCHOOL_B);
  await mk("teacher-other-removed", "teacher", SCHOOL_B, { isActive: false });
  await mk("bursar-a",        "bursar",  SCHOOL_A);
  await mk("pupil-a",         "student", SCHOOL_A, { enrollmentNo: "A-0001" });
  await mk("teacher-readd",   "teacher", SCHOOL_A, { isActive: false });

  const actor = {
    _id: "admin-1", id: "admin-1", role: "school_admin",
    schoolId: SCHOOL_A, email: "head@schoola.com",
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = actor; next(); });
  app.use("/api", require("../middleware/idempotency"));
  app.use("/api/admin", require(path.join(SRC, "routes/admin.routes")));
  const server = app.listen(0);
  server.keepAliveTimeout = 120_000;
  const port = server.address().port;

  const post = async (body, key) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/teachers`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json ?? {} };
  };
  // The middleware marks a key completed without awaiting it; wait for that
  // rather than racing it (a second request in the gap is told IN_PROGRESS).
  const settled = async (key) => {
    for (let i = 0; i < 100; i++) {
      const k = await IdempotencyKey.findOne({ key }).lean();
      if (k?.state === "completed") return;
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  // Everything a replay must leave alone.
  const snap = async (id) => {
    const u = await User.findById(id).select("+password").lean();
    return u && {
      isActive: u.isActive, password: u.password, name: u.name, email: u.email,
      role: u.role, schoolId: u.schoolId, mustResetPassword: u.mustResetPassword ?? null,
    };
  };

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- an existing active teacher's id is a replay ---");
  {
    const before = await snap("teacher-live");
    sent.length = 0;
    const r = await post({ id: "teacher-live", name: "Renamed", email: "new@example.test" });
    check("answers 200", r.status, 200);
    check("as a replay", r.body.replay, true);
    check("naming the existing teacher", r.body.teacher?._id, "teacher-live");
    check("with serverId/clientId for the outbox",
      [r.body.serverId, r.body.clientId], ["teacher-live", "teacher-live"]);
    check("without a password", [r.body.teacher?.password, r.body.tempPassword], [undefined, undefined]);
    check("the row is unchanged (name, email, password)", await snap("teacher-live"), before);
    check("and no mail is sent", sent.length, 0);

    const viaUnderscore = await post({ _id: "teacher-live", name: "x", email: "y@example.test" });
    check("an _id in the body is read the same way", [viaUnderscore.status, viaUnderscore.body.replay], [200, true]);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a REMOVED teacher's id is a replay, and they stay removed ---");
  {
    const before = await snap("teacher-removed");
    sent.length = 0;
    const r = await post({
      id: "teacher-removed", name: "teacher-removed name", email: "teacher-removed@example.test",
    });
    check("answers 200 replay", [r.status, r.body.replay], [200, true]);
    check("is not reported as a restore", r.body.restored, undefined);
    check("hands out no password", r.body.tempPassword, undefined);
    const after = await snap("teacher-removed");
    check("stays inactive", after.isActive, false);
    check("password hash unchanged", after.password === before.password, true);
    check("nothing else changed", after, before);
    check("and no welcome email", sent.length, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- an id naming somebody else is refused, nothing changed ---");
  for (const [label, id] of [
    ["another school's teacher",          "teacher-other"],
    ["another school's removed teacher",  "teacher-other-removed"],
    ["a bursar of this school",           "bursar-a"],
    ["a pupil of this school",            "pupil-a"],
  ]) {
    const before = await snap(id);
    sent.length = 0;
    const r = await post({ id, name: "Intruder", email: `${id}@example.test` });
    check(`${label}: refused with 409`, r.status, 409);
    check(`${label}: the reply discloses nothing about the row`,
      [r.body.teacher, r.body.data], [undefined, undefined]);
    check(`${label}: the row is unchanged`, await snap(id), before);
    check(`${label}: no mail`, sent.length, 0);
  }
  check("and no second account was made under any of those emails",
    await User.countDocuments({ name: "Intruder" }), 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the console's re-add by email is unchanged ---");
  {
    // A fresh id, as a phone or the web sends for a new teacher.
    const before = await snap("teacher-readd");
    sent.length = 0;
    const r = await post({
      id: "fresh-id-1", name: "Back Again", email: "teacher-readd@example.test",
    });
    check("fresh id + a removed teacher's email: restored (200)", [r.status, r.body.restored], [200, true]);
    check("reusing the existing row", r.body.teacher?._id, "teacher-readd");
    check("with a new password returned", typeof r.body.tempPassword, "string");
    const after = await snap("teacher-readd");
    check("live again", after.isActive, true);
    check("with a new password hash", after.password !== before.password, true);
    check("renamed as asked", after.name, "Back Again");
    check("and one welcome email", sent.map((m) => [m.to, m.template]),
      [["teacher-readd@example.test", "teacherWelcome"]]);
    check("no row was made under the fresh id", await User.exists({ _id: "fresh-id-1" }), null);

    // Removed again, and re-added with no id at all.
    await User.updateOne({ _id: "teacher-readd" }, { $set: { isActive: false } });
    sent.length = 0;
    const noId = await post({ name: "Back Twice", email: "teacher-readd@example.test" });
    check("no id + a removed teacher's email: restored (200)", [noId.status, noId.body.restored], [200, true]);
    check("live again", (await snap("teacher-readd")).isActive, true);
    check("one welcome email", sent.length, 1);

    // And an active teacher's email is still a 409 with no id, as before.
    const taken = await post({ name: "Dup", email: "teacher-live@example.test" });
    check("no id + an active teacher's email: still 409", taken.status, 409);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a brand-new teacher, with and without an id ---");
  {
    sent.length = 0;
    const withId = await post({ id: "phone-made-1", name: "New One", email: "new.one@example.test" });
    check("fresh id: 201 under that id", [withId.status, withId.body.teacher?._id], [201, "phone-made-1"]);
    check("one welcome email", sent.length, 1);

    // The same create retried with no Idempotency-Key: the handler's own guard.
    const pwBefore = (await snap("phone-made-1")).password;
    sent.length = 0;
    const again = await post({ id: "phone-made-1", name: "New One", email: "new.one@example.test" });
    check("retried: 200 replay, not a 409 about the email", [again.status, again.body.replay], [200, true]);
    check("password unchanged by the retry", (await snap("phone-made-1")).password === pwBefore, true);
    check("no second email", sent.length, 0);

    const noId = await post({ name: "Plain New", email: "plain.new@example.test" });
    check("no id: 201", noId.status, 201);
    check("with a server-made id", typeof noId.body.teacher?._id, "string");
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- Idempotency-Key replays still answer from memory ---");
  {
    sent.length = 0;
    const body = { id: "keyed-1", name: "Keyed", email: "keyed@example.test" };
    const first  = await post(body, "key-keyed-1");
    await settled("key-keyed-1");
    const second = await post(body, "key-keyed-1");
    check("first: 201", first.status, 201);
    check("same key: the stored 201 again", [second.status, second.body.teacher?._id], [201, "keyed-1"]);
    check("without the temporary password", second.body.tempPassword, undefined);
    check("one email only", sent.length, 1);
    check("one account only", await User.countDocuments({ email: "keyed@example.test" }), 1);

    // A new key for the same id (a queue that lost its key) reaches the
    // handler, which recognises the id.
    const third = await post(body, "key-keyed-1-b");
    await settled("key-keyed-1-b");
    check("new key, same id: 200 replay", [third.status, third.body.replay], [200, true]);
    check("still one email", sent.length, 1);
  }

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch(async (err) => {
  console.error("\nHarness error:", err);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
