// backend/scripts/check-portal-unread.js
"use strict";

/**
 * The portal's Messages badge counts what the Messages section can show.
 *
 * Reported: the tab carried a 1 while the section said "No conversations
 * yet". /me sent unread threads and unread notices as two numbers, the client
 * added them, and the section opened on Conversations — so one unread gate
 * notice was a 1 over an empty list.
 *
 * /me now sends `unread: { messages, notices, total }`, counted by one helper
 * (unreadSummary) from the same queries /messages/conversations and
 * /notifications list, and /notifications reports the same total. These
 * assertions hold the badge to those two lists, for a guardian with two
 * children (CLAUDE.md: one code, several children) and through a child switch,
 * a second guardian on one of the children, a deleted thread, and reading.
 *
 *   node scripts/check-portal-unread.js
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
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  delete process.env.SMTP_HOST;

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await Promise.all([M("Conversation").init(), M("Notification").init()]);

  const SCHOOL  = "68c00000000000000000000a";
  const TEACHER = "usr-teacher";
  const MOTHER  = "acc-mother";   // both children, one code
  const FATHER  = "acc-father";   // the younger only, his own code
  const AMA     = "stu-ama";
  const BIH     = "stu-bih";
  const HASH    = "$2a$10$check.only.not.a.real.hash.value.padding.padding.pad";

  await M("School").create({ _id: SCHOOL, name: "Geneva Bilingual Academy", email: "office@example.test",
    settings: { defaultLanguage: "en" } });
  await M("User").create({ _id: TEACHER, name: "Kuum Ernest", email: "t@example.test",
    password: "check-only-password", role: "teacher", schoolId: SCHOOL, isActive: true });
  await M("Class").create({ _id: "cls-1", schoolId: SCHOOL, name: "Form 1" });
  // Siblings sharing the guardian's contact details: normal, not duplicates.
  for (const [_id, name, no] of [[AMA, "Ama Bate", "GVA-0001"], [BIH, "Bih Bate", "GVA-0002"]]) {
    await M("Student").create({ _id, userId: `usr-${_id}`, schoolId: SCHOOL, classId: "cls-1",
      studentName: name, enrollmentNo: no, isActive: true, status: "approved",
      guardianName: "Mrs Bate", guardianPhone: "+237600000000" });
  }
  await M("GuardianAccess").create({ _id: MOTHER, schoolId: SCHOOL, studentIds: [AMA, BIH], codeHash: HASH, codeHint: "11" });
  await M("GuardianAccess").create({ _id: FATHER, schoolId: SCHOOL, studentIds: [BIH], codeHash: HASH, codeHint: "22" });

  const app = express();
  app.use(express.json());
  const auth = require(path.join(ROOT, "middleware", "auth"));
  app.use("/api/messages", auth.authenticate, require(path.join(SRC, "routes/messages.routes")));
  app.use("/api/portal",   require(path.join(SRC, "routes/portal.routes")));
  const server = app.listen(0);
  const port   = server.address().port;

  const staffToken  = jwt.sign({ id: TEACHER, role: "teacher", schoolId: SCHOOL }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const portalToken = (accessId) => jwt.sign({ accessId, schoolId: SCHOOL }, process.env.JWT_SECRET, { audience: "portal", expiresIn: "1h" });
  const call = async (token, method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: out };
  };
  const staff  = (m, u, b) => call(staffToken, m, u, b);
  const mother = (m, u, b) => call(portalToken(MOTHER), m, u, b);
  const father = (m, u, b) => call(portalToken(FATHER), m, u, b);

  /**
   * What the section can show, read from its own two lists, next to what /me
   * badges it with.
   */
  const view = async (who, child = null) => {
    const q     = child ? `?studentId=${child}` : "";
    const me    = (await who("GET", `/api/portal/me${q}`)).body?.data ?? {};
    const convs = (await who("GET", `/api/portal/messages/conversations${q}`)).body?.data ?? [];
    const notes = (await who("GET", `/api/portal/notifications${q}`)).body ?? {};
    const shownMessages = convs.reduce((n, c) => n + (c.unread || 0), 0);
    const shownNotices  = (notes.data ?? []).filter((n) => !n.conversationId && !n.read).length;
    return {
      badge:   me.unread ?? null,
      shown:   { messages: shownMessages, notices: shownNotices, total: shownMessages + shownNotices },
      threads: convs.length,
      notificationsTotal: notes.unreadTotal ?? null,
      legacy:  { messages: me.unreadMessages, notices: me.unreadNotices },
    };
  };

  // ── 1. The reported state: no thread, one unread notice ──────────────────
  console.log("\n--- no conversations, one unread gate notice (the report) ---");
  await M("Notification").create({ schoolId: SCHOOL, studentId: BIH, kind: "gate.arrival", channel: "log",
    to: "x@example.test", subject: "Bih arrived at 07:42", body: "", text: "Bih arrived at 07:42", status: "skipped" });
  {
    const v = await view(mother);
    check("the section lists no threads", v.threads, 0);
    check("/me badges exactly what the section shows: 0 messages, 1 notice",
      v.badge, { messages: 0, notices: 1, total: 1 });
    check("...which is what its lists hold", v.badge && { ...v.badge }, v.shown);
    check("/notifications reports the same total", v.notificationsTotal, 1);
    check("unreadMessages / unreadNotices are kept for older clients", v.legacy, { messages: 0, notices: 1 });

    const other = await view(mother, AMA);
    check("switching child does not change the family-wide badge", other.badge, { messages: 0, notices: 1, total: 1 });
  }

  // ── 2. A teacher writes ──────────────────────────────────────────────────
  console.log("\n--- a teacher writes twice to the mother ---");
  const opened = await staff("POST", "/api/messages/conversations/direct", { schoolId: SCHOOL, kind: "guardian", id: MOTHER });
  const convId = opened.body?.conversation?._id ?? opened.body?.data?._id ?? null;
  for (const body of ["Please come in on Thursday.", "At 10, if you can."]) {
    await staff("POST", `/api/messages/conversations/${convId}/messages`, { schoolId: SCHOOL, body });
  }
  {
    const v = await view(mother);
    check("the badge is 2 messages + 1 notice", v.badge, { messages: 2, notices: 1, total: 3 });
    check("...and the section shows exactly that", v.badge && { ...v.badge }, v.shown);
    check("/notifications agrees", v.notificationsTotal, 3);

    const f = await view(father);
    check("the father (own code, same child) has the notice but not her thread",
      f.badge, { messages: 0, notices: 1, total: 1 });
    check("...and his section shows the same", f.badge && { ...f.badge }, f.shown);
  }

  // ── 3. A deleted thread ──────────────────────────────────────────────────
  console.log("\n--- a deleted thread with unread in it ---");
  await M("Conversation").create({ schoolId: SCHOOL, kind: "direct", deletedAt: new Date(),
    participants: [{ kind: "user", id: TEACHER, lastReadSeq: 4 }, { kind: "guardian", id: MOTHER, lastReadSeq: 0 }],
    lastMessageSeq: 4, lastMessageAt: new Date(), lastMessagePreview: "gone" });
  {
    const v = await view(mother);
    check("is neither listed nor counted", [v.threads, v.badge?.messages], [1, 2]);
    check("the badge still equals the section", v.badge && { ...v.badge }, v.shown);
  }

  // ── 4. Reading clears it from both ───────────────────────────────────────
  console.log("\n--- the mother reads the thread, then the notice ---");
  await mother("POST", `/api/portal/messages/conversations/${convId}/read`, { seq: 99 });
  {
    const v = await view(mother);
    check("thread read: the notice is all that is left", v.badge, { messages: 0, notices: 1, total: 1 });
    check("...as the section shows", v.badge && { ...v.badge }, v.shown);
  }
  const notice = ((await mother("GET", "/api/portal/notifications")).body?.data ?? []).find((n) => !n.conversationId);
  await mother("POST", `/api/portal/notifications/${notice?._id}/read`);
  {
    const v = await view(mother);
    check("notice read: no badge", v.badge, { messages: 0, notices: 0, total: 0 });
    check("the father's notice is still unread (his own receipt)", (await view(father)).badge?.notices, 1);
  }

  await server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
