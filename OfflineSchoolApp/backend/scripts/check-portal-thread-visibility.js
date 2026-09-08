// backend/scripts/check-portal-thread-visibility.js
"use strict";

/**
 * A thread a parent can open but cannot find.
 *
 * Reported from a phone: the portal's Messages tab said "no conversations yet"
 * while the thread itself, reached by picking the teacher's name, showed a full
 * exchange — the teacher's "hello mother" and the parent's replies, interleaved
 * in one thread. So the conversation existed, the parent was reading it, and
 * their own list did not have it.
 *
 * ── Why check-portal-messaging did not catch this ─────────────────────────
 *
 * That suite asserts the list works, and it does — for a conversation document
 * it creates by hand, with directKey and participants written out literally. It
 * therefore proves that listFor can find a correctly-shaped thread, and proves
 * nothing about whether the staff app produces that shape. Every id in it is a
 * constant the test chose.
 *
 * This one never writes a Conversation. It goes through the endpoints a teacher
 * and a parent actually use:
 *
 *   staff   GET  /api/messages/recipients        → find the parent
 *   staff   POST /api/messages/conversations/direct
 *   staff   POST /api/messages/conversations/:id/messages
 *   parent  GET  /api/portal/messages/conversations      ← must contain it
 *   parent  GET  /api/portal/messages/conversations/:id
 *   parent  POST /api/portal/messages/conversations/:id
 *   parent  GET  /api/portal/messages/conversations      ← still must
 *
 * The id a teacher addresses a parent by has to be the id the parent is known
 * by, or those two halves disagree and this is the shape of the disagreement:
 * openDirect matches on a derived directKey, listFor filters on participants,
 * and a thread can satisfy one and not the other.
 *
 *   node scripts/check-portal-thread-visibility.js
 */

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

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
  const User           = mongoose.model("User");
  const Student        = mongoose.model("Student");
  const Class          = mongoose.model("Class");
  const Conversation   = mongoose.model("Conversation");
  const GuardianAccess = mongoose.model("GuardianAccess");

  await Conversation.init();

  // A real ObjectId, because School._id is one — /portal/me reads the school
  // heading by it and a "sch-1" would fail the cast before any assertion here
  // got a chance to run.
  const School  = mongoose.model("School");
  const SCHOOL  = "68c000000000000000000001";
  const TEACHER = "usr-teacher";
  const ACCESS  = "acc-parent";

  await School.create({ _id: SCHOOL, name: "Geneva Bilingual Academy", email: "office@example.test" });

  await User.create({
    _id: TEACHER, name: "Kuum Ernest", email: "t@example.test",
    password: "check-only-password", role: "teacher", schoolId: SCHOOL, isActive: true,
  });
  await Class.create({ _id: "cls-1", schoolId: SCHOOL, name: "Form 1" });
  await Student.create({
    _id: "stu-1", userId: "usr-stu-1", schoolId: SCHOOL, classId: "cls-1",
    studentName: "Bern Constance", enrollmentNo: "GVA00-2026-0003", isActive: true,
    status: "approved",
  });
  await GuardianAccess.create({
    _id: ACCESS, schoolId: SCHOOL, studentIds: ["stu-1"],
    codeHash: "$2a$10$check.only.not.a.real.hash.value.padding.padding.pad",
    codeHint: "11",
  });

  // Both real routers, behind their real auth. A stub for req.portal would skip
  // the middleware that builds it, and req.portal.accessId is the identity this
  // whole check is about.
  const app  = express();
  app.use(express.json());
  const auth = require(path.join(ROOT, "middleware", "auth"));
  app.use("/api/messages", auth.authenticate, require(path.join(SRC, "routes/messages.routes")));
  app.use("/api/portal",   require(path.join(SRC, "routes/portal.routes")));
  const server = app.listen(0);
  const port   = server.address().port;

  const staffToken = jwt.sign(
    { id: TEACHER, role: "teacher", schoolId: SCHOOL },
    process.env.JWT_SECRET, { expiresIn: "1h" }
  );

  // The portal's own audience. portalAuth verifies it explicitly, so that a
  // staff token cannot be presented here and a portal token cannot be
  // presented to authenticate(). Same claim shape login() signs.
  const portalToken = jwt.sign(
    { accessId: ACCESS, schoolId: SCHOOL },
    process.env.JWT_SECRET, { audience: "portal", expiresIn: "1h" }
  );

  const call = async (token, method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };

  const staff  = (m, u, b) => call(staffToken,  m, u, b);
  const parent = (m, u, b) => call(portalToken, m, u, b);

  // ── The parent's session has to work at all ──────────────────────────────
  console.log("\n--- the portal session ---");
  {
    const me = await parent("GET", "/api/portal/me");
    if (me.status === 200) ok("the parent's token is accepted by portalAuth");
    else {
      bad("the portal session works", `${me.status} ${JSON.stringify(me.body).slice(0, 200)}`);
      console.log("\n  Cannot continue — every assertion below needs a portal session.\n");
      console.log(`  ${pass} passed, ${fail} failed`);
      await server.close(); await mongoose.disconnect(); await mongo.stop();
      process.exit(1);
    }
  }

  // ── The teacher finds the parent the way the app does ─────────────────────
  console.log("\n--- the teacher addresses a parent ---");
  let guardianId = null;
  {
    const r = await staff("GET", `/api/messages/recipients?schoolId=${SCHOOL}`);
    if (r.status === 200) ok("the recipient list answers");
    else bad("the recipient list answers", `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

    const rows = r.body?.data ?? r.body?.recipients ?? [];
    const g = rows.find((x) => x.kind === "guardian");
    if (g) {
      guardianId = String(g.id);
      ok(`a guardian is offered as a recipient (${g.name ?? "unnamed"})`);
    } else {
      bad("a guardian is offered as a recipient",
        `${rows.length} recipient(s), kinds: ${[...new Set(rows.map((x) => x.kind))].join(", ")}`);
    }

    // The crux. If the teacher is handed anything other than the access row's
    // id, the thread it creates is one the parent's own list cannot match.
    if (guardianId === ACCESS) {
      ok("and by their GuardianAccess id, which is the identity the portal uses");
    } else {
      bad("the guardian's id is their access row",
        `offered ${JSON.stringify(guardianId)}, portal identity is ${JSON.stringify(ACCESS)}`);
    }
  }

  // ── The teacher opens the thread and writes ──────────────────────────────
  console.log("\n--- the teacher writes first ---");
  let convId = null;
  {
    const r = await staff("POST", "/api/messages/conversations/direct", {
      schoolId: SCHOOL, kind: "guardian", id: guardianId ?? ACCESS,
    });
    if (r.status < 400) ok(`the thread is created (${r.status})`);
    else bad("the thread is created", `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);

    convId = r.body?.data?._id ?? r.body?.conversation?._id ?? r.body?._id ?? null;
    if (convId) ok("and the response names it");
    else bad("the response names the thread", JSON.stringify(r.body).slice(0, 220));

    if (convId) {
      const m = await staff("POST", `/api/messages/conversations/${convId}/messages`, {
        schoolId: SCHOOL, body: "hello mother",
      });
      if (m.status < 400) ok("the teacher's message is posted");
      else bad("the teacher's message is posted", `${m.status} ${JSON.stringify(m.body).slice(0, 200)}`);
    }
  }

  // ── What the parent's own list shows. The reported bug. ──────────────────
  console.log("\n--- and the parent's list ---");
  {
    const r = await parent("GET", "/api/portal/messages/conversations");
    if (r.status === 200) ok("the list answers");
    else bad("the list answers", `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

    const rows = r.body?.data ?? [];
    if (rows.length === 1) {
      ok("the thread the teacher started is in it");
    } else {
      bad("the thread the teacher started is in the parent's list",
        `${rows.length} thread(s) returned.\n` +
        `This is the reported defect: the parent can open the thread but not find it.`);
    }

    const row = rows[0] || {};
    if (row._id && convId && String(row._id) === String(convId)) {
      ok("and it is the same thread, by id");
    } else if (rows.length) {
      bad("it is the same thread", `list has ${row._id}, teacher created ${convId}`);
    }

    if (row.lastMessagePreview) ok("with the last message previewed, so the row reads");
    else if (rows.length) bad("the row previews the last message", JSON.stringify(row.lastMessagePreview));

    // The parent has not opened it, so the teacher's message is unread.
    if ((row.unread ?? 0) >= 1) ok("and counted unread, which is what draws them to it");
    else if (rows.length) bad("the unread count is set", String(row.unread));
  }

  // ── The parent can read it, and replying does not orphan it ──────────────
  console.log("\n--- the parent reads and replies ---");
  {
    if (convId) {
      const t = await parent("GET", `/api/portal/messages/conversations/${convId}`);
      if (t.status === 200) ok("the parent can open the thread by id");
      else bad("the parent can open the thread", `${t.status} ${JSON.stringify(t.body).slice(0, 200)}`);

      const msgs = t.body?.data?.messages ?? t.body?.messages ?? [];
      if (msgs.some((m) => m.body === "hello mother")) {
        ok("and the teacher's message is in it");
      } else {
        bad("the teacher's message is in the thread", `${msgs.length} message(s)`);
      }

      const reply = await parent("POST", `/api/portal/messages/conversations/${convId}`, {
        body: "fine thanks",
      });
      if (reply.status < 400) ok("the parent can reply");
      else bad("the parent can reply", `${reply.status} ${JSON.stringify(reply.body).slice(0, 200)}`);
    }

    const after = await parent("GET", "/api/portal/messages/conversations");
    const rows  = after.body?.data ?? [];
    if (rows.length === 1) ok("and the thread is still the only one — replying did not fork it");
    else bad("replying does not create a second thread", `${rows.length} thread(s)`);
  }

  // ── The parent opening a name must not fork the thread ───────────────────
  console.log("\n--- the parent starts from the teacher's name ---");
  {
    const opened = await parent("POST", "/api/portal/messages/conversations", {
      kind: "user", id: TEACHER,
    });
    if (opened.status < 400) ok(`picking the teacher by name answers (${opened.status})`);
    else bad("picking the teacher by name answers", `${opened.status} ${JSON.stringify(opened.body).slice(0, 200)}`);

    const id = opened.body?.data?._id ?? opened.body?._id ?? null;
    if (convId && id && String(id) === String(convId)) {
      ok("and lands on the SAME thread, not a second one");
    } else {
      bad("it lands on the same thread",
        `opened ${id}, the teacher's thread is ${convId}.\n` +
        `A different id here is how a parent ends up reading one thread and ` +
        `listing another.`);
    }

    const stored = await Conversation.countDocuments({ schoolId: SCHOOL, deletedAt: null });
    if (stored === 1) ok("one conversation exists in the database, not two");
    else bad("only one conversation exists", `${stored} stored`);
  }

  // ── What a client needs to write the label in its own language ───────────
  //
  // A guardian has no name. The server composes one, and for an unnamed
  // guardian that composition is the English phrase "Parent/Guardian" —
  // sometimes with the children in brackets. A francophone parent read it over
  // their own thread, and no catalogue could help: the string had never been a
  // key, and `name` alone gives a client no way to tell "Mrs Ngu (Bern
  // Constance)", which is a person's name, from "Parent/Guardian (Bern
  // Constance)", which is a sentence in one language.
  //
  // officeLabel is the difference. It is asserted on all three payloads a
  // client reads guardian names from, because one of them missing it is one
  // screen still in English.
  console.log("\n--- the guardian label can be translated ---");
  {
    const r    = await staff("GET", `/api/messages/recipients?schoolId=${SCHOOL}`);
    const g    = (r.body?.recipients ?? r.body?.data ?? []).find((x) => x.kind === "guardian");

    if (g && "officeLabel" in g) ok("the recipient row says whether the office named them");
    else bad("the recipient row carries officeLabel", JSON.stringify(g ?? null).slice(0, 200));

    // Nobody named this access row, so there is nothing to keep verbatim and
    // the whole label is the client's to write.
    if (g && g.officeLabel === null) ok("and it is null here, because nobody did");
    else if (g) bad("officeLabel is null for an unnamed guardian", JSON.stringify(g.officeLabel));

    if (g && (g.childNames ?? []).includes("Bern Constance")) {
      ok("with the children structured, to compose the brackets from");
    } else if (g) {
      bad("the children are sent structured", JSON.stringify(g.childNames));
    }

    // Still English, still sent. A client a version behind renders it, and an
    // English label beats a blank row.
    if (g && /Parent\/Guardian/.test(String(g.name || ""))) {
      ok("and `name` unchanged, so an older client still shows something");
    } else if (g) {
      bad("`name` is unchanged", JSON.stringify(g.name));
    }

    // The staff thread. A parent's own messages carry the label that was
    // stored when they were sent, and labelGuardians rewrites them on the way
    // out — so officeLabel has to travel with that rewrite.
    const th = await staff("GET", `/api/messages/conversations/${convId}`);
    const parts = th.body?.conversation?.participants
               ?? th.body?.data?.conversation?.participants ?? [];
    const gp = parts.find((p) => p.kind === "guardian");
    if (gp && "officeLabel" in gp) ok("the thread's guardian participant carries it too");
    else bad("the thread participant carries officeLabel", JSON.stringify(gp ?? parts).slice(0, 200));

    // And the parent's own list, which is the screen that was reported.
    const list = await parent("GET", "/api/portal/messages/conversations");
    const row  = (list.body?.data ?? [])[0] ?? {};
    const own  = (row.participants ?? []).find((p) => p.kind === "guardian");
    if (own && "officeLabel" in own) ok("and the parent's own list row carries it");
    else bad("the portal list row carries officeLabel", JSON.stringify(own ?? row.participants).slice(0, 200));

    // otherParticipants is what the portal row is named from. A teacher has a
    // real name and needs no label — but the field has to survive the
    // projection, or a parent-to-parent thread would lose it.
    const others = row.otherParticipants ?? [];
    if (others.length && others.every((p) => "childNames" in p && "officeLabel" in p)) {
      ok("otherParticipants survives the projection with both fields");
    } else {
      bad("otherParticipants keeps childNames and officeLabel",
        JSON.stringify(others).slice(0, 200));
    }
  }

  await server.close();
  await mongoose.disconnect();
  await mongo.stop();

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
