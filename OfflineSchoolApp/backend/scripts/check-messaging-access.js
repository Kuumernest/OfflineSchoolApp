// backend/scripts/check-messaging-access.js
"use strict";

/**
 * Nobody reads or writes a conversation they are not in.
 *
 * Reported 2026-10-24: signed in as a student, a tester saw threads between
 * an administrator and an unrelated parent. The server was not what showed
 * them — the phone's local store was (mobile message.service) — but the rule
 * the phone was trusted to keep is the server's to enforce, and this pins it
 * there for every principal and every route that touches a conversation:
 *
 *   list, open, read messages, send, mark read, attach, react, delete
 *   — staff routes for a student, a teacher and the bursar,
 *   — the portal routes for a guardian,
 *
 * each against a thread between an administrator and a different guardian.
 * Outsiders get "not found" (never 403: saying a thread exists is itself a
 * disclosure) and nothing they send is stored. The existing oversight rule —
 * an administrator may read any thread in their school when the school leaves
 * auditing on — is asserted as it stands, not changed.
 *
 * And the other half of the report: a student's message to a teacher is
 * stored and reaches the teacher.
 *
 * Real routers behind their real authentication, real tokens.
 *
 *   node scripts/check-messaging-access.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");
const fs       = require("fs");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const User = mongoose.model("User"), Student = mongoose.model("Student"), Class = mongoose.model("Class");
  const School = mongoose.model("School"), GuardianAccess = mongoose.model("GuardianAccess");
  const Conversation = mongoose.model("Conversation"), Message = mongoose.model("Message");
  await Promise.all([Conversation.init(), Message.init()]);

  const SCHOOL = "68c000000000000000000001";
  await School.create({ _id: SCHOOL, name: "Green Valley Academy", email: "office@example.test" });
  await Class.create({ _id: "cls-1", schoolId: SCHOOL, name: "Form 1" });

  const person = (id, role, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: "check-only-password",
    role, schoolId: SCHOOL, isActive: true,
  });
  await person("u-admin",   "school_admin", "Head Teacher");
  await person("u-teacher", "teacher",      "Mrs Teacher");
  await person("u-teach2",  "teacher",      "Mr Outsider");
  await person("u-bursar",  "bursar",       "Fee Desk");
  await person("u-stu",     "student",      "Pupil One");
  await person("u-stu2",    "student",      "Pupil Two");
  for (const [id, uid, name] of [["stu-1", "u-stu", "Pupil One"], ["stu-2", "u-stu2", "Pupil Two"], ["stu-3", "u-stu3", "Pupil Three"]]) {
    await Student.create({ _id: id, userId: uid, schoolId: SCHOOL, classId: "cls-1", studentName: name,
      enrollmentNo: `GVA-${id}`, isActive: true, status: "approved" });
  }
  const hash = "$2a$10$check.only.not.a.real.hash.value.padding.padding.pad";
  // The admin's correspondent, and a different family entirely.
  await GuardianAccess.create({ _id: "acc-theirs", schoolId: SCHOOL, studentIds: ["stu-3"], codeHash: hash, codeHint: "11" });
  await GuardianAccess.create({ _id: "acc-other",  schoolId: SCHOOL, studentIds: ["stu-2"], codeHash: hash, codeHint: "22" });

  const app  = express();
  app.use(express.json());
  const auth = require(path.join(ROOT, "middleware", "auth"));
  app.use("/api/messages", auth.authenticate, require(path.join(SRC, "routes/messages.routes")));
  app.use("/api/portal",   require(path.join(SRC, "routes/portal.routes")));
  const server = app.listen(0);
  const port   = server.address().port;

  const staffToken  = (id, role) => jwt.sign({ id, role, schoolId: SCHOOL }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const portalToken = (accessId) => jwt.sign({ accessId, schoolId: SCHOOL }, process.env.JWT_SECRET, { audience: "portal", expiresIn: "1h" });

  const call = async (token, method, url, body, form) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(form ? {} : { "Content-Type": "application/json" }) },
      ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: out };
  };
  const as = (token) => (m, u, b, f) => call(token, m, u, b, f);

  const admin   = as(staffToken("u-admin",   "school_admin"));
  const teacher = as(staffToken("u-teacher", "teacher"));
  const student = as(staffToken("u-stu",     "student"));
  const theirs  = as(portalToken("acc-theirs"));

  // ── The thread nobody else may see: an administrator and a parent ────────
  const opened = await admin("POST", "/api/messages/conversations/direct", { kind: "guardian", id: "acc-theirs" });
  const X = opened.body?.conversation?._id;
  const posted = await admin("POST", `/api/messages/conversations/${X}/messages`, { body: "About your child's fees" });
  const msgId = posted.body?.message?._id;
  const reply = await theirs("POST", `/api/portal/messages/conversations/${X}`, { body: "Thank you, I will come on Monday" });
  check("setup: the admin and the parent hold a thread and both wrote in it",
    [opened.status, posted.status, reply.status >= 200 && reply.status < 300], [201, 201, true]);

  const before = await Message.countDocuments({ conversationId: X });

  // ═══════════════════════════════════════════════════════════════════════
  const outsiders = [
    ["a student",                  as(staffToken("u-stu",     "student"))],
    ["another student",            as(staffToken("u-stu2",    "student"))],
    ["a teacher",                  as(staffToken("u-teach2",  "teacher"))],
    ["the bursar",                 as(staffToken("u-bursar",  "bursar"))],
  ];
  for (const [who, me] of outsiders) {
    console.log(`--- ${who}, outside the thread ---`);
    const list = await me("GET", "/api/messages/conversations");
    check(`${who}: the list does not contain it`,
      [list.status, (list.body?.conversations ?? []).some((c) => c._id === X)], [200, false]);
    check(`${who}: opening it is not found`, (await me("GET", `/api/messages/conversations/${X}`)).status, 404);
    check(`${who}: its messages are not found`, (await me("GET", `/api/messages/conversations/${X}/messages`)).status, 404);
    const send = await me("POST", `/api/messages/conversations/${X}/messages`, { body: "let me in" });
    check(`${who}: sending into it is refused`, send.status >= 400, true);
    check(`${who}: marking it read is not found`, (await me("POST", `/api/messages/conversations/${X}/read`, { seq: 1 })).status, 404);
    const form = new FormData();
    form.append("file", new Blob(["hello"], { type: "text/plain" }), "note.txt");
    const attach = await me("POST", `/api/messages/conversations/${X}/attachments`, null, form);
    check(`${who}: attaching to it is refused`, attach.status >= 400, true);
    check(`${who}: reacting to its message is not found`, (await me("POST", `/api/messages/${msgId}/reactions`, { key: "👍" })).status, 404);
    check(`${who}: deleting its message is not found`, (await me("DELETE", `/api/messages/${msgId}`)).status, 404);
    check(`${who}: the school-wide audit list is refused`, (await me("GET", "/api/messages/audit/conversations")).status, 403);
  }

  console.log("--- a guardian of a different child, through the portal ---");
  const other = as(portalToken("acc-other"));
  const plist = await other("GET", "/api/portal/messages/conversations");
  check("guardian: the portal list does not contain it",
    [plist.status, (plist.body?.conversations ?? plist.body?.data ?? []).some((c) => c._id === X)], [200, false]);
  check("guardian: opening it is not found", (await other("GET", `/api/portal/messages/conversations/${X}`)).status, 404);
  check("guardian: sending into it is refused", (await other("POST", `/api/portal/messages/conversations/${X}`, { body: "hello?" })).status >= 400, true);
  check("guardian: marking it read is not found", (await other("POST", `/api/portal/messages/conversations/${X}/read`, { seq: 1 })).status, 404);
  check("a guardian's token is not accepted on the staff routes", (await other("GET", `/api/messages/conversations/${X}`)).status, 401);

  check("and nothing any outsider sent was stored", await Message.countDocuments({ conversationId: X }), before);
  check("nor was the message deleted or reacted to",
    await Message.findById(msgId).lean().then((m) => [m.deletedAt ?? null, (m.reactions ?? []).length]), [null, 0]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the people in it, and the existing oversight rule ---");
  check("the parent in it reads it", (await theirs("GET", `/api/portal/messages/conversations/${X}`)).status, 200);
  const adminRead = await admin("GET", `/api/messages/conversations/${X}/messages`);
  check("the admin in it reads it, as a participant", [adminRead.status, adminRead.body?.viaAudit], [200, false]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a student's message to a teacher is delivered ---");
  const pick = await student("GET", "/api/messages/recipients");
  check("the teacher is offered to the student", (pick.body?.recipients ?? pick.body?.data ?? []).some((r) => r.id === "u-teacher"), true);
  check("a guardian is not offered to the student", (pick.body?.recipients ?? pick.body?.data ?? []).some((r) => r.kind === "guardian"), false);
  const sd = await student("POST", "/api/messages/conversations/direct", { kind: "user", id: "u-teacher" });
  const Y  = sd.body?.conversation?._id;
  const sent = await student("POST", `/api/messages/conversations/${Y}/messages`, { body: "Sir, I was absent on Friday", clientId: "client-1" });
  check("the student's message is accepted", [sd.status, sent.status], [201, 201]);
  const tlist = await teacher("GET", "/api/messages/conversations");
  const tthread = await teacher("GET", `/api/messages/conversations/${Y}/messages`);
  check("and the teacher has it, unread",
    [(tlist.body?.conversations ?? []).find((c) => c._id === Y)?.unread, (tthread.body?.messages ?? []).map((m) => m.body)],
    [1, ["Sir, I was absent on Friday"]]);
  const replay = await student("POST", `/api/messages/conversations/${Y}/messages`, { body: "Sir, I was absent on Friday", clientId: "client-1" });
  check("an outbox replay is recognised, not posted twice",
    [replay.status, await Message.countDocuments({ conversationId: Y })], [200, 1]);
  const toParent = await student("POST", "/api/messages/conversations/direct", { kind: "guardian", id: "acc-theirs" });
  check("a student may not open a thread with a guardian, and is told why",
    [toParent.status, typeof toParent.body?.error === "string" && toParent.body.error.length > 0], [403, true]);

  const audit = await admin("GET", `/api/messages/conversations/${Y}/messages`);
  check("existing rule: an admin may read a thread they are not in (audit, on by default), marked as such",
    [audit.status, audit.body?.viaAudit], [200, true]);
  check("but may not post into it", (await admin("POST", `/api/messages/conversations/${Y}/messages`, { body: "x" })).status, 403);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- attachments: protection is judged on the resolved path ---");
  // The /uploads handler, which server.js mounts from storage/serveUploads.js.
  const serverSrc = fs.readFileSync(path.join(SRC, "storage", "serveUploads.js"), "utf8");
  check("the upload gate checks the canonical path, so ./messages/x is protected too",
    /isProtectedPath\(canonicalPath\)/.test(serverSrc) && /verifyMediaSignature\(canonicalPath/.test(serverSrc), true);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("\nHarness error:", err); process.exit(1); });
