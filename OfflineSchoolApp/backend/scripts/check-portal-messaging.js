// backend/scripts/check-portal-messaging.js
"use strict";

/**
 * The parent portal's message thread.
 *
 * No suite mounted portal.routes, and this is the half of messaging a parent
 * actually uses. What went unnoticed there: the thread screen drew every
 * message in the same bubble, because it had no way to tell which ones were
 * the parent's own. A guardian is identified by their GuardianAccess row and
 * /portal/me does not carry it, so the client was guessing — and a read
 * receipt has nothing to attach itself to without that answer.
 *
 * The endpoint had been sending participantReads all along and nothing read
 * it. It now also says who is asking, and these assertions hold both to it:
 *
 *   • the thread names the caller, so their own messages can be identified
 *   • it reports what the far side has read and been delivered
 *   • a guardian who is not in the thread gets nothing
 *   • one guardian's identity is their access row, not their child, so a
 *     parent with two children still has one thread with the school
 *
 *   node scripts/check-portal-messaging.js
 */

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const SRC = path.join(__dirname, "..", "src");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const User         = mongoose.model("User");
  const Student      = mongoose.model("Student");
  const Conversation   = mongoose.model("Conversation");
  const Message        = mongoose.model("Message");
  const GuardianAccess = mongoose.model("GuardianAccess");

  const SCHOOL   = "sch-1";
  const ACCESS   = "acc-parent";
  const OTHER    = "acc-stranger";
  const TEACHER  = "usr-teacher";

  await User.create({
    _id: TEACHER, name: "A Teacher", email: "t@example.test",
    password: "check-only-password", role: "teacher", schoolId: SCHOOL, isActive: true,
  });

  await Student.create({
    _id: "stu-1", userId: "usr-stu-1", schoolId: SCHOOL, classId: "cls-1",
    studentName: "A Child", enrollmentNo: "ENR-1", isActive: true,
  });
  await Student.create({
    _id: "stu-2", userId: "usr-stu-2", schoolId: SCHOOL, classId: "cls-1",
    studentName: "Another Child", enrollmentNo: "ENR-2", isActive: true,
  });

  // portalAuth re-reads the access row on every request — a code revoked five
  // minutes ago has to stop working now — so these have to be real.
  await GuardianAccess.create({
    _id: ACCESS, schoolId: SCHOOL, studentIds: ["stu-1", "stu-2"],
    codeHash: "$2a$10$check.only.not.a.real.hash.value.padding.padding.pad",
    codeHint: "11",
  });
  await GuardianAccess.create({
    _id: OTHER, schoolId: SCHOOL, studentIds: ["stu-1"],
    codeHash: "$2a$10$check.only.not.a.real.hash.value.padding.padding.pad",
    codeHint: "22",
  });

  const CONV = "conv-1";
  await Conversation.create({
    _id: CONV, schoolId: SCHOOL, kind: "direct",
    directKey: `guardian:${ACCESS}|user:${TEACHER}`,
    participants: [
      { kind: "guardian", id: ACCESS,  name: "Parent/Guardian", lastReadSeq: 0, lastDeliveredSeq: 0 },
      { kind: "user",     id: TEACHER, name: "A Teacher", role: "teacher", lastReadSeq: 1, lastDeliveredSeq: 2 },
    ],
    lastMessageSeq: 2,
  });

  await Message.create({
    _id: "msg-1", conversationId: CONV, schoolId: SCHOOL, seq: 1,
    sender: { kind: "guardian", id: ACCESS, name: "Parent/Guardian" },
    body: "Good morning sir",
  });
  await Message.create({
    _id: "msg-2", conversationId: CONV, schoolId: SCHOOL, seq: 2,
    sender: { kind: "guardian", id: ACCESS, name: "Parent/Guardian" },
    body: "Is there class on Friday?",
  });

  // The real router, behind its own real portalAuth. A stub setting req.portal
  // would skip the middleware that builds it, which is half of what makes a
  // guardian a guardian.
  const app = express();
  app.use(express.json());
  app.use("/api/portal", require(path.join(SRC, "routes/portal.routes")));

  const server = app.listen(0);
  const port   = server.address().port;

  const tokenFor = (accessId) => jwt.sign(
    { accessId, schoolId: SCHOOL },
    process.env.JWT_SECRET,
    { audience: "portal", expiresIn: "1h" }
  );

  let who = ACCESS;
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/portal${p}`, {
      headers: { Authorization: `Bearer ${tokenFor(who)}` },
    });
    let body = {}; try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };

  // ── The thread has to name the caller ─────────────────────────────────────
  console.log("\n--- the thread says who is asking ---");

  let r = await get(`/messages/conversations/${CONV}`);
  const d = r.body?.data ?? {};

  if (r.status === 200) ok("the thread answers");
  else bad("the thread answers", `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);

  if (d.me?.kind === "guardian" && String(d.me?.id) === ACCESS) {
    ok("it names the caller, so their own messages can be told apart");
  } else {
    bad("it names the caller", JSON.stringify(d.me));
  }

  if ((d.messages ?? []).length === 2) ok("with the messages in the thread");
  else bad("with the messages in the thread", JSON.stringify((d.messages ?? []).length));

  // Every message here was sent by the guardian, so every one is "mine" —
  // which is what the screen uses to decide it may draw a receipt at all.
  const senders = (d.messages ?? []).map((m) => `${m.sender?.kind}:${m.sender?.id}`);
  if (senders.length === 2 && senders.every((s) => s === `guardian:${ACCESS}`)) {
    ok("and each message carries the sender the caller is matched against");
  } else {
    bad("each message carries its sender", JSON.stringify(senders));
  }

  // ── What the far side has seen ────────────────────────────────────────────
  console.log("\n--- what the school has read ---");

  const staff = (d.participantReads ?? []).find((p) => p.kind === "user");
  if (staff) ok("the far side's read state is reported");
  else bad("the far side's read state is reported", JSON.stringify(d.participantReads));

  if (staff?.lastReadSeq === 1 && staff?.lastDeliveredSeq === 2) {
    ok("with the sequence numbers the receipts are computed from");
  } else {
    bad("with the sequence numbers", JSON.stringify(staff));
  }

  // Message 1 is read, message 2 only delivered. That difference is the whole
  // point of the two-tick/one-tick distinction, so assert it survives.
  if ((staff?.lastReadSeq ?? 0) >= 1 && (staff?.lastReadSeq ?? 0) < 2) {
    ok("a message can be delivered without being read");
  } else {
    bad("a message can be delivered without being read", JSON.stringify(staff));
  }

  // ── A guardian has to be identifiable ─────────────────────────────────────
  console.log("\n--- who the parent is ---");

  // A guardian has no name of their own in this system: no field holds one,
  // and the school never types one in. Every thread, every recipient row and
  // every message from a parent therefore read "Parent/Guardian", identically
  // for all of them — a teacher with three parent threads had three rows with
  // the same title. The children are what the school knows a parent by.
  const guardianOf = (d.conversation?.participants ?? [])
    .find((p) => p.kind === "guardian");

  if (guardianOf?.name?.includes("A Child") && guardianOf?.name?.includes("Another Child")) {
    ok(`the guardian is named by their children ("${guardianOf.name}")`);
  } else {
    bad("the guardian is named by their children", JSON.stringify(guardianOf?.name));
  }

  if (Array.isArray(guardianOf?.childNames) && guardianOf.childNames.length === 2) {
    ok("and the names come through structured, not only inside a string");
  } else {
    bad("the names come through structured", JSON.stringify(guardianOf?.childNames));
  }

  // The stored string on every existing thread is the bare one. Relabelling
  // happens on the way out, so a message sent long before this existed reads
  // correctly now without the database being touched.
  const fromParent = (d.messages ?? []).find((m) => m.sender?.kind === "guardian");
  if (fromParent?.sender?.name?.includes("A Child")) {
    ok("a message stored as \"Parent/Guardian\" is relabelled when it is read");
  } else {
    bad("a stored message is relabelled when read", JSON.stringify(fromParent?.sender?.name));
  }

  // A guardian the office has named keeps that name; the children are added
  // to it rather than replacing it.
  await GuardianAccess.updateOne({ _id: ACCESS }, { label: "Mrs Ngu" });
  r = await get(`/messages/conversations/${CONV}`);
  const named = (r.body?.data?.conversation?.participants ?? [])
    .find((p) => p.kind === "guardian");
  if (named?.name?.startsWith("Mrs Ngu (")) {
    ok(`an office-given name is kept and the children added ("${named.name}")`);
  } else {
    bad("an office-given name is kept", JSON.stringify(named?.name));
  }
  await GuardianAccess.updateOne({ _id: ACCESS }, { label: null });

  // An access linked to no child still has to render as something.
  await GuardianAccess.updateOne({ _id: OTHER }, { studentIds: [] });
  const svc = require(path.join(SRC, "services/communication/conversation.service"));
  const bare = (await svc.guardianLabels(SCHOOL, [OTHER])).get(OTHER);
  if (bare?.name === "Parent/Guardian" && bare.childNames.length === 0) {
    ok("an access with no child falls back to the plain label");
  } else {
    bad("an access with no child falls back", JSON.stringify(bare));
  }
  await GuardianAccess.updateOne({ _id: OTHER }, { studentIds: ["stu-1"] });

  // ── A stranger sees nothing ───────────────────────────────────────────────
  console.log("\n--- somebody else's thread ---");

  who = OTHER;
  r = await get(`/messages/conversations/${CONV}`);
  if (r.status === 404) ok("a guardian who is not in the thread gets 404");
  else bad("a guardian not in the thread gets 404", `${r.status}`);

  r = await get("/messages/conversations");
  const list = r.body?.data ?? [];
  if (r.status === 200 && Array.isArray(list) && list.length === 0) {
    ok("and it is not in their list either");
  } else {
    // A 401 would satisfy "no threads" without proving anything at all.
    bad("it is not in their list", `${r.status} ${JSON.stringify(list).slice(0, 140)}`);
  }

  // ── One parent, one identity ──────────────────────────────────────────────
  console.log("\n--- a parent with two children ---");

  who = ACCESS;
  r = await get("/messages/conversations");
  const mine = r.body?.data ?? [];
  if (mine.length === 1) {
    ok("still has one thread with the school, not one per child");
  } else {
    bad("has one thread with the school", `${mine.length} thread(s)`);
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
